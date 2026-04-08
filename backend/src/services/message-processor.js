/**
 * Message Processor Service
 *
 * Extracted from webhook routes to be used by BullMQ workers.
 * Contains all heavy processing: Gemini AI, WhatsApp sending, logging, analytics.
 */
import { logger } from '../config/logger.js';
import { pool } from '../config/database.js';
import { decrypt } from '../config/encryption.js';
import { getActiveKeysForAgent, recordKeyError, recordKeySuccess } from './api-key-manager.js';
import { getHistory, addToHistory, addToolCallToHistory, formatHistoryForGemini, clearHistory } from './memory.js';
import { processMessageWithTools, buildToolDeclarations } from './gemini.js';
import { executeTool, executeTransferTool, executeFinalizarTool, executeAtributoTool, transformResultForLLM, logToolExecution } from './tool-runner.js';
import { parseMetaMessage, buildGeminiParts } from './media-handler.js';
import { saveMedia } from './media-storage.js';
import { sendTextMessage, markAsRead } from './whatsapp-sender.js';
import { atribuirConversaAutomatica, calcularStatsFila } from './fila-manager.js';
import { emitNovaMensagem, emitNovaConversaNaFila, emitFilaStats, emitStatusEntrega } from './websocket.js';
import { getFlowState, startFlow, processFlowInput, clearFlowState } from './flow-engine.js';
import { consumirCredito } from './creditos-ia.js';
import { checkAutomacoesEntrada } from './automacao-entrada.js';
import { matchRegraRoteamento } from './roteamento-inicial.js';

const createLogger = logger.child({ module: 'message-processor' });

/**
 * Resolve o wamid de uma mensagem citada (reply) no nosso banco e retorna o id local.
 * Usado quando o cliente envia uma reply: Meta nos da o wamid via context.id, e a gente
 * tenta achar a mensagem local correspondente pra criar o vinculo no FK.
 * Retorna { reply_to_message_id: uuid|null, reply_to_wamid: string|null }.
 */
async function resolveReplyTo(empresa_id, replyToWamid) {
  if (!replyToWamid) return { reply_to_message_id: null, reply_to_wamid: null };
  try {
    const r = await pool.query(
      `SELECT id FROM mensagens_log
       WHERE whatsapp_message_id = $1 AND empresa_id = $2
       ORDER BY criado_em DESC LIMIT 1`,
      [replyToWamid, empresa_id]
    );
    return {
      reply_to_message_id: r.rows[0]?.id || null,
      reply_to_wamid: replyToWamid,
    };
  } catch {
    // Em qualquer falha, salvamos o wamid bruto pra nao perder o vinculo
    return { reply_to_message_id: null, reply_to_wamid: replyToWamid };
  }
}

/**
 * Adiciona/atualiza uma conexão WhatsApp no JSONB conexoes_whatsapp da conversa.
 */
async function atualizarConexoesWhatsApp(conversa_id, wnId) {
  if (!wnId) return;
  await pool.query(`
    UPDATE conversas SET
      conexoes_whatsapp = CASE
        WHEN conexoes_whatsapp IS NULL OR conexoes_whatsapp = '[]'::jsonb THEN
          jsonb_build_array(jsonb_build_object('wn_id', $2::text, 'first_seen', NOW(), 'last_seen', NOW()))
        WHEN NOT EXISTS (SELECT 1 FROM jsonb_array_elements(conexoes_whatsapp) elem WHERE elem->>'wn_id' = $2::text) THEN
          conexoes_whatsapp || jsonb_build_array(jsonb_build_object('wn_id', $2::text, 'first_seen', NOW(), 'last_seen', NOW()))
        ELSE
          (SELECT jsonb_agg(
            CASE WHEN elem->>'wn_id' = $2::text
              THEN jsonb_set(elem, '{last_seen}', to_jsonb(NOW()))
              ELSE elem
            END
          ) FROM jsonb_array_elements(conexoes_whatsapp) elem)
      END,
      conexao_ativa_id = COALESCE(conexao_ativa_id, $2),
      atualizado_em = NOW()
    WHERE id = $1
  `, [conversa_id, wnId]);
}

/**
 * Process a batch of WhatsApp messages from the same contact (debounce).
 * All messages are parsed/logged individually, but sent to Gemini as one combined message.
 * This prevents the AI from responding multiple times when a client sends rapid messages.
 *
 * @param {Array} batch - Array of { message, contacts, phoneNumberId, empresa_id, wnId }
 */
export async function processWhatsAppBatch(batch) {
  if (!batch || batch.length === 0) return;

  const startTime = Date.now();

  // All items share the same phone/empresa (grouped by debounce key)
  const { phoneNumberId, empresa_id, wnId } = batch[0];
  const phone = batch[0].message.from;
  const contactName = batch[0].contacts[0]?.profile?.name || null;

  // Get Graph API token
  const wnResult = await pool.query(
    `SELECT token_graph_api, n8n_response_url FROM whatsapp_numbers wn
     JOIN empresas e ON e.id = wn.empresa_id
     WHERE wn.id = $1 AND wn.empresa_id = $2`,
    [wnId, empresa_id]
  );

  if (wnResult.rows.length === 0) {
    createLogger.error('WhatsApp number not found in worker', { wnId, empresa_id });
    return;
  }

  const graphToken = decrypt(wnResult.rows[0].token_graph_api);
  if (!graphToken) {
    createLogger.error('No valid Graph API token in worker', { wnId, empresa_id });
    return;
  }

  // Process each message: parse, download media, mark as read
  const processedMessages = [];

  for (const item of batch) {
    const msg = item.message;

    // Mark as read (non-blocking)
    markAsRead(phoneNumberId, graphToken, msg.id).catch(() => {});

    const parsed = parseMetaMessage(msg);

    if ((parsed.type === 'unknown' && !parsed.text) || parsed.type === 'reaction') {
      continue; // Skip unprocessable messages
    }

    const { parts, historyText, mediaBuffer, mediaMimeType, mediaFileName } = await buildGeminiParts(parsed, graphToken);

    let mediaSaved = null;
    if (mediaBuffer) {
      try {
        mediaSaved = await saveMedia(mediaBuffer, empresa_id, mediaMimeType, mediaFileName);
      } catch (err) {
        createLogger.error('Failed to save media to disk', { error: err.message, empresa_id, type: parsed.type });
      }
    }

    processedMessages.push({
      messageId: msg.id,
      parsed,
      parts,
      historyText,
      mediaSaved,
      mediaMimeType,
      mediaFileName,
    });
  }

  if (processedMessages.length === 0) {
    createLogger.debug('All messages in batch were skipped', { phone, empresa_id });
    return;
  }

  // Combine all text messages into one for the AI
  const combinedHistoryText = processedMessages.map(m => m.historyText).join('\n');

  // Combine parts for Gemini (text + media from all messages)
  const combinedParts = processedMessages.flatMap(m => m.parts || []);

  // Use the last message's data for the main record
  const lastMsg = processedMessages[processedMessages.length - 1];

  createLogger.info('Processing WhatsApp batch', {
    empresa_id, phone,
    batchSize: batch.length,
    processedCount: processedMessages.length,
    combinedText: combinedHistoryText.substring(0, 150),
  });

  // --- Process shared logic with combined message ---
  await processMessageCommon({
    empresa_id,
    phone,
    contactName,
    messageId: lastMsg.messageId,
    phoneNumberId,
    graphToken,
    historyText: combinedHistoryText,
    parsed: lastMsg.parsed,
    parts: combinedParts.length > 0 ? combinedParts : null,
    mediaSaved: lastMsg.mediaSaved,
    mediaMimeType: lastMsg.mediaMimeType,
    mediaFileName: lastMsg.mediaFileName,
    startTime,
    wnId,
    source: 'whatsapp_direct',
    // Extra: log individual messages before AI processing
    _batchMessages: processedMessages,
  });
}

/**
 * Process a single incoming WhatsApp message (legacy, still used by n8n path).
 * For direct WhatsApp messages, use processWhatsAppBatch instead.
 */
export async function processWhatsAppMessage({ message, contacts, phoneNumberId, empresa_id, wnId }) {
  // Delegate to batch with single item
  await processWhatsAppBatch([{ message, contacts, phoneNumberId, empresa_id, wnId }]);
}

/**
 * Process an incoming n8n message.
 * This is the heavy logic extracted from n8n.js webhook route.
 */
export async function processN8nMessage({ message, phone, name, phoneNumberId, empresa_id, agentId, metadata, n8nResponseUrl, webhookToken }) {
  const startTime = Date.now();

  // --- Resolve wnId from phoneNumberId (multi-conexão) ---
  let wnId = null;
  if (phoneNumberId) {
    const wnRes = await pool.query(
      `SELECT id FROM whatsapp_numbers WHERE phone_number_id = $1 AND empresa_id = $2 LIMIT 1`,
      [phoneNumberId, empresa_id]
    );
    wnId = wnRes.rows[0]?.id || null;
  }

  // --- Resolve agent ---
  let agentQuery, agentParams;
  if (agentId) {
    agentQuery = `
      SELECT id as agente_id, nome as agente_nome, modelo, temperatura, max_tokens, prompt_ativo,
             cache_enabled, gemini_cache_id, cache_expires_at, mensagem_midia_nao_suportada,
             chatbot_fluxo_id, chatbot_ativo
      FROM agentes WHERE id = $1 AND empresa_id = $2 AND ativo = true LIMIT 1
    `;
    agentParams = [agentId, empresa_id];
  } else {
    agentQuery = `
      SELECT id as agente_id, nome as agente_nome, modelo, temperatura, max_tokens, prompt_ativo,
             cache_enabled, gemini_cache_id, cache_expires_at, mensagem_midia_nao_suportada,
             chatbot_fluxo_id, chatbot_ativo
      FROM agentes WHERE empresa_id = $1 AND ativo = true
      ORDER BY is_triagem DESC NULLS LAST, criado_em ASC LIMIT 1
    `;
    agentParams = [empresa_id];
  }

  const agentResult = await pool.query(agentQuery, agentParams);
  if (agentResult.rows.length === 0) {
    createLogger.warn('No active agent for company (n8n)', { empresa_id });
    return { response: null, error: 'No active agent' };
  }

  const agent = agentResult.rows[0];
  const { agente_id, agente_nome, modelo } = agent;

  // --- Get API keys ---
  const availableKeys = await getActiveKeysForAgent(empresa_id, agente_id);
  if (availableKeys.length === 0) {
    createLogger.warn('No API keys for agent (n8n)', { empresa_id, agente_id });
    return { response: null, error: 'No API keys' };
  }

  const conversationKey = `whatsapp:${phone}`;

  // --- Find or create contato ---
  let contato_id = null;
  try {
    const contatoResult = await pool.query(`
      INSERT INTO contatos (empresa_id, whatsapp, nome)
      VALUES ($1, $2, $3)
      ON CONFLICT (empresa_id, whatsapp) DO UPDATE SET
        nome = COALESCE(NULLIF($3, ''), contatos.nome), atualizado_em = NOW()
      RETURNING id
    `, [empresa_id, phone, name || null]);
    contato_id = contatoResult.rows[0].id;
  } catch (err) {
    createLogger.error('Failed to upsert contato (n8n)', { error: err.message });
  }

  // --- Find or create conversa ---
  let conversa_id;
  const conversaResult = await pool.query(`
    SELECT id, controlado_por, humano_nome, fila_id, ultima_msg_entrada_em FROM conversas
    WHERE empresa_id = $1 AND contato_whatsapp = $2 AND status = 'ativo'
      ${wnId ? 'AND whatsapp_number_id = $3::uuid' : ''}
    ORDER BY criado_em DESC LIMIT 1
  `, wnId ? [empresa_id, phone, wnId] : [empresa_id, phone]);

  if (conversaResult.rows.length > 0) {
    conversa_id = conversaResult.rows[0].id;

    if (contato_id) {
      pool.query('UPDATE conversas SET contato_id = $1 WHERE id = $2 AND contato_id IS NULL', [contato_id, conversa_id]).catch(() => {});
    }

    // Atualizar conexões WhatsApp (multi-conexão por ticket)
    atualizarConexoesWhatsApp(conversa_id, wnId).catch(() => {});

    // --- Check human control ---
    if (conversaResult.rows[0].controlado_por === 'humano') {
      // Se nunca recebeu mensagem do cliente (resposta a template), ativar IA
      if (!conversaResult.rows[0].ultima_msg_entrada_em) {
        createLogger.info('First client response on template conversation, activating AI (n8n)', { empresa_id, phone, conversa_id });
        await pool.query(
          `UPDATE conversas SET controlado_por = 'ia', operador_id = NULL, operador_nome = NULL, ultima_msg_entrada_em = NOW(), atualizado_em = NOW() WHERE id = $1`,
          [conversa_id]
        );
        pool.query(`
          INSERT INTO controle_historico (conversa_id, empresa_id, acao, de_controlador, para_controlador, motivo)
          VALUES ($1, $2, 'humano_devolveu', 'humano', 'ia', 'Cliente respondeu template, IA ativada automaticamente')
        `, [conversa_id, empresa_id]).catch(() => {});
        // Continua para processamento pela IA (não retorna)
      } else {
        createLogger.info('Message during human control (n8n), skipping AI', { empresa_id, phone, conversa_id });

        addToHistory(empresa_id, conversationKey, 'user', message).catch(() => {});

        const logMsgResult = await pool.query(`
          INSERT INTO mensagens_log (conversa_id, empresa_id, direcao, conteudo, remetente_tipo, criado_em)
          VALUES ($1, $2, 'entrada', $3, 'cliente', NOW())
          RETURNING id, criado_em
        `, [conversa_id, empresa_id, message]);

        const fila_id = conversaResult.rows[0].fila_id;
        if (logMsgResult.rows[0]) {
          emitNovaMensagem(conversa_id, fila_id, {
            id: logMsgResult.rows[0].id,
            conversa_id,
            conteudo: message,
            direcao: 'entrada',
            remetente_tipo: 'cliente',
            criado_em: logMsgResult.rows[0].criado_em,
          });
        }

        pool.query(`UPDATE conversas SET humano_ultima_msg_em = NOW(), ultima_msg_entrada_em = NOW(), atualizado_em = NOW(), lida = false, lida_em = NULL, lida_por = NULL WHERE id = $1`, [conversa_id]).catch(() => {});

        return {
          response: null,
          human_controlled: true,
          conversation_id: conversa_id,
          processing_time_ms: Date.now() - startTime,
        };
      }
    }
  } else {
    // New conversation
    const filaResult = await pool.query(
      `SELECT id FROM filas_atendimento WHERE empresa_id = $1 AND ativo = true ORDER BY is_default DESC, criado_em ASC LIMIT 1`,
      [empresa_id]
    );
    const defaultFilaId = filaResult.rows[0]?.id || null;

    const { rows: [{ get_next_ticket_number: numero_ticket }] } = await pool.query(
      `SELECT get_next_ticket_number($1)`, [empresa_id]
    );

    const insertConversa = await pool.query(`
      INSERT INTO conversas (empresa_id, contato_whatsapp, contato_nome, contato_id, agente_id, agente_inicial_id, status, controlado_por, fila_id, dados_json, numero_ticket, whatsapp_number_id, conexoes_whatsapp, conexao_ativa_id)
      VALUES ($1, $2, $3, $4, $5, $5, 'ativo', $6, $7, $8, $9, $10::uuid,
        CASE WHEN $10 IS NOT NULL THEN jsonb_build_array(jsonb_build_object('wn_id', $10::text, 'first_seen', NOW(), 'last_seen', NOW())) ELSE '[]'::jsonb END,
        $10::uuid)
      ON CONFLICT (empresa_id, contato_whatsapp, whatsapp_number_id) WHERE status = 'ativo' AND whatsapp_number_id IS NOT NULL
      DO UPDATE SET atualizado_em = NOW()
      RETURNING id, (xmax = 0) as is_new
    `, [
      empresa_id, phone, name || null, contato_id, agente_id,
      defaultFilaId ? 'fila' : 'ia',
      defaultFilaId,
      JSON.stringify({ name: name || null, source: 'n8n' }),
      numero_ticket,
      wnId || null
    ]);

    conversa_id = insertConversa.rows[0].id;
    const isNewConversa = insertConversa.rows[0].is_new;

    if (!isNewConversa) {
      // Race condition: conversa já existia, tratar como existente
      createLogger.info('Conversa already existed (ON CONFLICT), treating as existing (n8n)', { empresa_id, phone, conversa_id });
    } else if (defaultFilaId) {
      emitNovaConversaNaFila(defaultFilaId, {
        id: conversa_id,
        contato_whatsapp: phone,
        contato_nome: name || null,
        status: 'ativo',
        controlado_por: 'fila',
        fila_id: defaultFilaId,
        numero_ticket,
        criado_em: new Date().toISOString(),
      });

      const operador = await atribuirConversaAutomatica(conversa_id, defaultFilaId).catch(() => null);
      if (operador) {
        addToHistory(empresa_id, conversationKey, 'user', message).catch(() => {});
        await pool.query(
          `INSERT INTO mensagens_log (conversa_id, empresa_id, direcao, conteudo, remetente_tipo, criado_em)
           VALUES ($1, $2, 'entrada', $3, 'cliente', NOW())`,
          [conversa_id, empresa_id, message]
        );
        return {
          response: null,
          human_controlled: true,
          conversation_id: conversa_id,
          processing_time_ms: Date.now() - startTime,
        };
      }

      calcularStatsFila(defaultFilaId).then(stats => emitFilaStats(defaultFilaId, stats)).catch(() => {});
    }
  }

  // Atualizar ultima_msg_entrada_em (janela 24h WhatsApp) — fluxo n8n
  pool.query(`UPDATE conversas SET ultima_msg_entrada_em = NOW(), atualizado_em = NOW() WHERE id = $1`, [conversa_id]).catch(() => {});

  // --- Process with AI (shared logic) ---
  const result = await processAIResponse({
    empresa_id,
    conversa_id,
    contato_id,
    agente_id,
    agent,
    availableKeys,
    conversationKey,
    messageText: message,
    parts: null,
    startTime,
  });

  if (!result) return { response: null, error: 'AI processing failed' };

  // --- Send response via WhatsApp ---
  if (phoneNumberId) {
    let whatsappToken = null;
    try {
      const wnResult = await pool.query(
        'SELECT token_graph_api FROM whatsapp_numbers WHERE phone_number_id = $1 AND empresa_id = $2 AND ativo = true LIMIT 1',
        [phoneNumberId, empresa_id]
      );
      if (wnResult.rows.length > 0 && wnResult.rows[0].token_graph_api) {
        whatsappToken = decrypt(wnResult.rows[0].token_graph_api);
      }
    } catch (err) {
      createLogger.error('Failed to get WhatsApp token (n8n worker)', { error: err.message });
    }

    if (whatsappToken) {
      sendTextMessage(phoneNumberId, whatsappToken, phone, result.text)
        .then(sendResult => {
          if (sendResult.wamid && result.outgoingMsgId) {
            pool.query(
              `UPDATE mensagens_log SET whatsapp_message_id = $1, status_entrega = 'sent' WHERE id = $2`,
              [sendResult.wamid, result.outgoingMsgId]
            ).catch(() => {});
          }
        })
        .catch(err => {
          createLogger.error('Failed to send via Meta API (n8n worker)', { error: err.message, phone });
        });
    } else if (n8nResponseUrl) {
      // Fallback: use n8n Flow 2 (legacy)
      fetch(n8nResponseUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          phone,
          message: result.text,
          phone_number_id: phoneNumberId,
          webhook_token: webhookToken,
        }),
        signal: AbortSignal.timeout(10000),
      }).catch(err => {
        createLogger.error('Failed to send to Flow 2 (n8n worker)', { error: err.message });
      });
    }
  }

  return {
    response: result.text,
    conversation_id: conversa_id,
    agent_name: result.agente_nome,
    tools_called: result.toolsCalled.map(tc => tc.name),
    tokens_used: { input: result.tokensInput, output: result.tokensOutput },
    processing_time_ms: Date.now() - startTime,
  };
}

/**
 * Common message processing logic (shared between WhatsApp direct and n8n).
 * Handles: resolve agent, find/create conversation, check human control, process AI.
 */
async function processMessageCommon({
  empresa_id, phone, contactName, messageId, phoneNumberId, graphToken,
  historyText, parsed, parts, mediaSaved, mediaMimeType, mediaFileName,
  startTime, wnId, source, _batchMessages,
}) {
  // --- Resolve default agent ---
  const agentResult = await pool.query(`
    SELECT id as agente_id, nome as agente_nome, modelo, temperatura, max_tokens, prompt_ativo,
           cache_enabled, gemini_cache_id, cache_expires_at, mensagem_midia_nao_suportada,
           chatbot_fluxo_id, chatbot_ativo
    FROM agentes
    WHERE empresa_id = $1 AND ativo = true
    ORDER BY is_triagem DESC NULLS LAST, criado_em ASC
    LIMIT 1
  `, [empresa_id]);

  if (agentResult.rows.length === 0) {
    createLogger.warn('No active agent for company', { empresa_id });
    return;
  }

  let agent = agentResult.rows[0];
  let { agente_id, agente_nome, modelo, temperatura, max_tokens, prompt_ativo } = agent;

  // --- Get API keys with failover ---
  const availableKeys = await getActiveKeysForAgent(empresa_id, agente_id);
  if (availableKeys.length === 0) {
    createLogger.warn('No API keys for agent', { empresa_id, agente_id });
    return;
  }

  const conversationKey = `whatsapp:${phone}`;

  // --- Find or create contato ---
  let contato_id = null;
  try {
    const contatoResult = await pool.query(`
      INSERT INTO contatos (empresa_id, whatsapp, nome)
      VALUES ($1, $2, $3)
      ON CONFLICT (empresa_id, whatsapp) DO UPDATE SET
        nome = COALESCE(NULLIF($3, ''), contatos.nome), atualizado_em = NOW()
      RETURNING id
    `, [empresa_id, phone, contactName || null]);
    contato_id = contatoResult.rows[0].id;
  } catch (err) {
    createLogger.error('Failed to upsert contato', { error: err.message });
  }

  // --- Find or create conversa ---
  let conversa_id;
  let isNewConversation = false;
  const conversaResult = await pool.query(`
    SELECT id, controlado_por, humano_nome, fila_id, agente_id as conversa_agente_id, ultima_msg_entrada_em FROM conversas
    WHERE empresa_id = $1 AND contato_whatsapp = $2 AND status = 'ativo'
      ${wnId ? 'AND whatsapp_number_id = $3::uuid' : ''}
    ORDER BY criado_em DESC LIMIT 1
  `, wnId ? [empresa_id, phone, wnId] : [empresa_id, phone]);

  if (conversaResult.rows.length > 0) {
    conversa_id = conversaResult.rows[0].id;

    if (contato_id) {
      pool.query('UPDATE conversas SET contato_id = $1 WHERE id = $2 AND contato_id IS NULL', [contato_id, conversa_id]).catch(() => {});
    }

    // Atualizar conexões WhatsApp (multi-conexão por ticket)
    atualizarConexoesWhatsApp(conversa_id, wnId).catch(() => {});

    // --- Check human control ---
    if (conversaResult.rows[0].controlado_por === 'humano') {
      // Se nunca recebeu mensagem do cliente (resposta a template), ativar IA
      if (!conversaResult.rows[0].ultima_msg_entrada_em) {
        createLogger.info('First client response on template conversation, activating AI', { empresa_id, phone, conversa_id });
        await pool.query(
          `UPDATE conversas SET controlado_por = 'ia', operador_id = NULL, operador_nome = NULL, ultima_msg_entrada_em = NOW(), atualizado_em = NOW() WHERE id = $1`,
          [conversa_id]
        );
        pool.query(`
          INSERT INTO controle_historico (conversa_id, empresa_id, acao, de_controlador, para_controlador, motivo)
          VALUES ($1, $2, 'humano_devolveu', 'humano', 'ia', 'Cliente respondeu template, IA ativada automaticamente')
        `, [conversa_id, empresa_id]).catch(() => {});
        // Continua para processamento pela IA (não retorna)
      } else {
        createLogger.info('Message during human control, skipping AI', { empresa_id, phone, conversa_id });

        addToHistory(empresa_id, conversationKey, 'user', historyText).catch(() => {});

        // Log each message in batch (or single message)
        const humanMsgsToLog = _batchMessages || [{
          messageId, parsed, historyText, mediaSaved, mediaMimeType, mediaFileName,
        }];

        const fila_id = conversaResult.rows[0].fila_id;

        for (const msg of humanMsgsToLog) {
          const replyInfo = await resolveReplyTo(empresa_id, msg.parsed.replyToWamid);
          const logMsgResult = await pool.query(`
            INSERT INTO mensagens_log (conversa_id, empresa_id, direcao, conteudo, remetente_tipo, tipo_mensagem, whatsapp_message_id, midia_url, midia_mime_type, midia_nome_arquivo, midia_tamanho_bytes, whatsapp_number_id, reply_to_message_id, reply_to_wamid, criado_em)
            VALUES ($1, $2, 'entrada', $3, 'cliente', $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW())
            RETURNING id, criado_em
          `, [conversa_id, empresa_id, msg.historyText, msg.parsed.type, msg.messageId,
              msg.mediaSaved?.relativePath || null, msg.mediaSaved ? msg.mediaMimeType : null,
              msg.mediaSaved ? (msg.mediaFileName || null) : null, msg.mediaSaved?.sizeBytes || null,
              wnId || null, replyInfo.reply_to_message_id, replyInfo.reply_to_wamid]);

          if (logMsgResult.rows[0]) {
            emitNovaMensagem(conversa_id, fila_id, {
              id: logMsgResult.rows[0].id,
              conversa_id,
              conteudo: msg.historyText,
              direcao: 'entrada',
              remetente_tipo: 'cliente',
              tipo_mensagem: msg.parsed.type,
              midia_url: msg.mediaSaved?.relativePath || null,
              midia_mime_type: msg.mediaSaved ? msg.mediaMimeType : null,
              midia_nome_arquivo: msg.mediaSaved ? (msg.mediaFileName || null) : null,
              criado_em: logMsgResult.rows[0].criado_em,
              reply_to_message_id: replyInfo.reply_to_message_id,
            });
          }
        }

        pool.query(`UPDATE conversas SET humano_ultima_msg_em = NOW(), ultima_msg_entrada_em = NOW(), atualizado_em = NOW(), lida = false, lida_em = NULL, lida_por = NULL WHERE id = $1`, [conversa_id]).catch(() => {});
        return;
      }
    }
  } else {
    // New conversation

    // --- Roteamento Inteligente: avalia regras de palavra-chave APENAS na 1a msg ---
    // Se uma regra ativa bater, cria o ticket direto na fila configurada,
    // sem chatbot e sem IA, e opcionalmente envia uma resposta automatica.
    const matchRoteamento = await matchRegraRoteamento(empresa_id, historyText);
    if (matchRoteamento) {
      const { rows: [{ get_next_ticket_number: nt }] } = await pool.query(
        `SELECT get_next_ticket_number($1)`, [empresa_id]
      );

      const insertConversaRot = await pool.query(`
        INSERT INTO conversas (empresa_id, contato_whatsapp, contato_nome, contato_id, agente_id, agente_inicial_id, status, controlado_por, fila_id, dados_json, numero_ticket, whatsapp_number_id, conexoes_whatsapp, conexao_ativa_id)
        VALUES ($1, $2, $3, $4, NULL, NULL, 'ativo', 'fila', $5, $6, $7, $8::uuid,
          CASE WHEN $8 IS NOT NULL THEN jsonb_build_array(jsonb_build_object('wn_id', $8::text, 'first_seen', NOW(), 'last_seen', NOW())) ELSE '[]'::jsonb END,
          $8::uuid)
        ON CONFLICT (empresa_id, contato_whatsapp, whatsapp_number_id) WHERE status = 'ativo' AND whatsapp_number_id IS NOT NULL
        DO UPDATE SET atualizado_em = NOW()
        RETURNING id, (xmax = 0) as is_new
      `, [
        empresa_id, phone, contactName || null, contato_id,
        matchRoteamento.fila_id,
        JSON.stringify({ name: contactName || null, source, roteamento_regra_id: matchRoteamento.regra_id, roteamento_regra_nome: matchRoteamento.regra_nome }),
        nt,
        wnId || null,
      ]);

      conversa_id = insertConversaRot.rows[0].id;
      const isNewRot = insertConversaRot.rows[0].is_new;

      if (isNewRot) {
        createLogger.info({
          empresa_id, phone, conversa_id, regra: matchRoteamento.regra_nome, fila_id: matchRoteamento.fila_id,
        }, 'Roteamento Inteligente: nova conversa criada direto na fila');

        addToHistory(empresa_id, conversationKey, 'user', historyText).catch(() => {});

        const rotMsgs = _batchMessages || [{
          messageId, parsed, historyText, mediaSaved, mediaMimeType, mediaFileName,
        }];
        for (const msg of rotMsgs) {
          const replyInfo = await resolveReplyTo(empresa_id, msg.parsed.replyToWamid);
          const logRes = await pool.query(`
            INSERT INTO mensagens_log (conversa_id, empresa_id, direcao, conteudo, remetente_tipo, tipo_mensagem, whatsapp_message_id, midia_url, midia_mime_type, midia_nome_arquivo, midia_tamanho_bytes, whatsapp_number_id, reply_to_message_id, reply_to_wamid, criado_em)
            VALUES ($1, $2, 'entrada', $3, 'cliente', $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW())
            RETURNING id, criado_em
          `, [conversa_id, empresa_id, msg.historyText, msg.parsed.type, msg.messageId,
              msg.mediaSaved?.relativePath || null, msg.mediaSaved ? msg.mediaMimeType : null,
              msg.mediaSaved ? (msg.mediaFileName || null) : null, msg.mediaSaved?.sizeBytes || null,
              wnId || null, replyInfo.reply_to_message_id, replyInfo.reply_to_wamid]);

          if (logRes.rows[0]) {
            emitNovaMensagem(conversa_id, matchRoteamento.fila_id, {
              id: logRes.rows[0].id,
              conversa_id,
              conteudo: msg.historyText,
              direcao: 'entrada',
              remetente_tipo: 'cliente',
              tipo_mensagem: msg.parsed.type,
              midia_url: msg.mediaSaved?.relativePath || null,
              midia_mime_type: msg.mediaSaved ? msg.mediaMimeType : null,
              midia_nome_arquivo: msg.mediaSaved ? (msg.mediaFileName || null) : null,
              criado_em: logRes.rows[0].criado_em,
              reply_to_message_id: replyInfo.reply_to_message_id,
            });
          }
        }

        pool.query(
          `UPDATE conversas SET ultima_msg_entrada_em = NOW(), atualizado_em = NOW() WHERE id = $1`,
          [conversa_id]
        ).catch(() => {});

        emitNovaConversaNaFila(matchRoteamento.fila_id, {
          id: conversa_id,
          contato_whatsapp: phone,
          contato_nome: contactName || null,
          status: 'ativo',
          controlado_por: 'fila',
          fila_id: matchRoteamento.fila_id,
          numero_ticket: nt,
          criado_em: new Date().toISOString(),
        });

        atribuirConversaAutomatica(conversa_id, matchRoteamento.fila_id).catch(() => null);
        calcularStatsFila(matchRoteamento.fila_id).then(stats => emitFilaStats(matchRoteamento.fila_id, stats)).catch(() => {});

        // Resposta automatica opcional
        if (matchRoteamento.resposta_automatica && phoneNumberId && graphToken) {
          try {
            const sendRes = await sendTextMessage(
              phoneNumberId, graphToken, phone, matchRoteamento.resposta_automatica
            );
            if (sendRes.success) {
              await pool.query(`
                INSERT INTO mensagens_log (conversa_id, empresa_id, direcao, conteudo, remetente_tipo, remetente_nome, tipo_mensagem, whatsapp_message_id, status_entrega, whatsapp_number_id, criado_em)
                VALUES ($1, $2, 'saida', $3, 'sistema', 'Roteamento Inteligente', 'text', $4, 'sent', $5, NOW())
              `, [conversa_id, empresa_id, matchRoteamento.resposta_automatica, sendRes.wamid, wnId || null]);
            }
          } catch (err) {
            createLogger.warn({ err: err.message }, 'Falha ao enviar resposta automatica do roteamento');
          }
        }

        return; // bypass total: chatbot e IA nao atuam
      }
      // se nao foi nova (race condition), nada a fazer aqui — segue fluxo existente
      createLogger.info('Roteamento: conversa ja existia (ON CONFLICT), seguindo fluxo padrao', { empresa_id, phone, conversa_id });
    }

    const filaResult = await pool.query(
      `SELECT id FROM filas_atendimento WHERE empresa_id = $1 AND ativo = true ORDER BY is_default DESC, criado_em ASC LIMIT 1`,
      [empresa_id]
    );
    const defaultFilaId = filaResult.rows[0]?.id || null;

    const { rows: [{ get_next_ticket_number: numero_ticket }] } = await pool.query(
      `SELECT get_next_ticket_number($1)`, [empresa_id]
    );

    const insertConversa = await pool.query(`
      INSERT INTO conversas (empresa_id, contato_whatsapp, contato_nome, contato_id, agente_id, agente_inicial_id, status, controlado_por, fila_id, dados_json, numero_ticket, whatsapp_number_id, conexoes_whatsapp, conexao_ativa_id)
      VALUES ($1, $2, $3, $4, $5, $5, 'ativo', $6, $7, $8, $9, $10::uuid,
        CASE WHEN $10 IS NOT NULL THEN jsonb_build_array(jsonb_build_object('wn_id', $10::text, 'first_seen', NOW(), 'last_seen', NOW())) ELSE '[]'::jsonb END,
        $10::uuid)
      ON CONFLICT (empresa_id, contato_whatsapp, whatsapp_number_id) WHERE status = 'ativo' AND whatsapp_number_id IS NOT NULL
      DO UPDATE SET atualizado_em = NOW()
      RETURNING id, (xmax = 0) as is_new
    `, [
      empresa_id, phone, contactName || null, contato_id, agente_id,
      defaultFilaId ? 'fila' : 'ia',
      defaultFilaId,
      JSON.stringify({ name: contactName || null, source }),
      numero_ticket,
      wnId || null
    ]);

    conversa_id = insertConversa.rows[0].id;
    const isNewConversa = insertConversa.rows[0].is_new;
    isNewConversation = isNewConversa;

    if (!isNewConversa) {
      // Race condition: conversa já existia, tratar como existente
      createLogger.info('Conversa already existed (ON CONFLICT), treating as existing', { empresa_id, phone, conversa_id });
    } else if (defaultFilaId) {
      emitNovaConversaNaFila(defaultFilaId, {
        id: conversa_id,
        contato_whatsapp: phone,
        contato_nome: contactName || null,
        status: 'ativo',
        controlado_por: 'fila',
        fila_id: defaultFilaId,
        numero_ticket,
        criado_em: new Date().toISOString(),
      });

      const operador = await atribuirConversaAutomatica(conversa_id, defaultFilaId).catch(() => null);
      if (operador) {
        addToHistory(empresa_id, conversationKey, 'user', historyText).catch(() => {});
        const autoAssignMsgs = _batchMessages || [{
          messageId, parsed, historyText, mediaSaved, mediaMimeType, mediaFileName,
        }];
        for (const msg of autoAssignMsgs) {
          const replyInfo = await resolveReplyTo(empresa_id, msg.parsed.replyToWamid);
          await pool.query(
            `INSERT INTO mensagens_log (conversa_id, empresa_id, direcao, conteudo, remetente_tipo, tipo_mensagem, whatsapp_message_id, midia_url, midia_mime_type, midia_nome_arquivo, midia_tamanho_bytes, reply_to_message_id, reply_to_wamid, criado_em)
             VALUES ($1, $2, 'entrada', $3, 'cliente', $4, $5, $6, $7, $8, $9, $10, $11, NOW())`,
            [conversa_id, empresa_id, msg.historyText, msg.parsed.type, msg.messageId,
             msg.mediaSaved?.relativePath || null, msg.mediaSaved ? msg.mediaMimeType : null,
             msg.mediaSaved ? (msg.mediaFileName || null) : null, msg.mediaSaved?.sizeBytes || null,
             replyInfo.reply_to_message_id, replyInfo.reply_to_wamid]
          );
        }
        return;
      }

      calcularStatsFila(defaultFilaId).then(stats => emitFilaStats(defaultFilaId, stats)).catch(() => {});
    }
  }

  // --- Se conversa existente em fila humana (agente_id null, controlado_por fila), salvar mensagem mas não processar IA ---
  if (conversaResult.rows.length > 0 && !conversaResult.rows[0].conversa_agente_id && conversaResult.rows[0].controlado_por === 'fila') {
    createLogger.info({ empresa_id, phone, conversa_id, fila_id: conversaResult.rows[0].fila_id }, 'Conversa em fila humana sem agente, saving message but skipping AI');

    addToHistory(empresa_id, conversationKey, 'user', historyText).catch(() => {});

    const filaMsgsToLog = _batchMessages || [{
      messageId, parsed, historyText, mediaSaved, mediaMimeType, mediaFileName,
    }];

    const filaId = conversaResult.rows[0].fila_id;

    for (const msg of filaMsgsToLog) {
      const replyInfo = await resolveReplyTo(empresa_id, msg.parsed.replyToWamid);
      const logMsgResult = await pool.query(`
        INSERT INTO mensagens_log (conversa_id, empresa_id, direcao, conteudo, remetente_tipo, tipo_mensagem, whatsapp_message_id, midia_url, midia_mime_type, midia_nome_arquivo, midia_tamanho_bytes, whatsapp_number_id, reply_to_message_id, reply_to_wamid, criado_em)
        VALUES ($1, $2, 'entrada', $3, 'cliente', $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW())
        RETURNING id, criado_em
      `, [conversa_id, empresa_id, msg.historyText, msg.parsed.type, msg.messageId,
          msg.mediaSaved?.relativePath || null, msg.mediaSaved ? msg.mediaMimeType : null,
          msg.mediaSaved ? (msg.mediaFileName || null) : null, msg.mediaSaved?.sizeBytes || null,
          wnId || null, replyInfo.reply_to_message_id, replyInfo.reply_to_wamid]);

      if (logMsgResult.rows[0]) {
        emitNovaMensagem(conversa_id, filaId, {
          id: logMsgResult.rows[0].id,
          conversa_id,
          conteudo: msg.historyText,
          direcao: 'entrada',
          remetente_tipo: 'cliente',
          tipo_mensagem: msg.parsed.type,
          midia_url: msg.mediaSaved?.relativePath || null,
          midia_mime_type: msg.mediaSaved ? msg.mediaMimeType : null,
          midia_nome_arquivo: msg.mediaSaved ? (msg.mediaFileName || null) : null,
          criado_em: logMsgResult.rows[0].criado_em,
          reply_to_message_id: replyInfo.reply_to_message_id,
        });
      }
    }

    pool.query(`UPDATE conversas SET ultima_msg_entrada_em = NOW(), atualizado_em = NOW(), lida = false, lida_em = NULL, lida_por = NULL WHERE id = $1`, [conversa_id]).catch(() => {});
    return;
  }

  // --- Override agent if conversation already has one ---
  if (conversaResult.rows.length > 0 && conversaResult.rows[0].conversa_agente_id) {
    const conversaAgenteId = conversaResult.rows[0].conversa_agente_id;
    if (conversaAgenteId !== agente_id) {
      const overrideResult = await pool.query(`
        SELECT id as agente_id, nome as agente_nome, modelo, temperatura, max_tokens, prompt_ativo,
               cache_enabled, gemini_cache_id, cache_expires_at, mensagem_midia_nao_suportada,
               chatbot_fluxo_id, chatbot_ativo
        FROM agentes WHERE id = $1 AND empresa_id = $2 AND ativo = true
      `, [conversaAgenteId, empresa_id]);

      if (overrideResult.rows.length > 0) {
        agent = overrideResult.rows[0];
        ({ agente_id, agente_nome, modelo, temperatura, max_tokens, prompt_ativo } = agent);
      }
    }
  }

  // --- Log incoming message(s) ---
  // If batch, log each message individually; otherwise log the single message
  const messagesToLog = _batchMessages || [{
    messageId, parsed, historyText, mediaSaved, mediaMimeType, mediaFileName,
  }];

  const conversaForFila = await pool.query('SELECT fila_id FROM conversas WHERE id = $1', [conversa_id]);
  const currentFilaId = conversaForFila.rows[0]?.fila_id;

  for (const msg of messagesToLog) {
    const replyInfo = await resolveReplyTo(empresa_id, msg.parsed.replyToWamid);
    const incomingMsgResult = await pool.query(`
      INSERT INTO mensagens_log (conversa_id, empresa_id, direcao, conteudo, remetente_tipo, tipo_mensagem, whatsapp_message_id, midia_url, midia_mime_type, midia_nome_arquivo, midia_tamanho_bytes, whatsapp_number_id, reply_to_message_id, reply_to_wamid, criado_em)
      VALUES ($1, $2, 'entrada', $3, 'cliente', $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW())
      RETURNING id, criado_em
    `, [conversa_id, empresa_id, msg.historyText, msg.parsed.type, msg.messageId,
        msg.mediaSaved?.relativePath || null, msg.mediaSaved ? msg.mediaMimeType : null,
        msg.mediaSaved ? (msg.mediaFileName || null) : null, msg.mediaSaved?.sizeBytes || null,
        wnId || null, replyInfo.reply_to_message_id, replyInfo.reply_to_wamid]);

    // Emit WebSocket for each incoming message
    if (incomingMsgResult.rows[0]) {
      emitNovaMensagem(conversa_id, currentFilaId, {
        id: incomingMsgResult.rows[0].id,
        conversa_id,
        conteudo: msg.historyText,
        direcao: 'entrada',
        remetente_tipo: 'cliente',
        tipo_mensagem: msg.parsed.type,
        midia_url: msg.mediaSaved?.relativePath || null,
        midia_mime_type: msg.mediaSaved ? msg.mediaMimeType : null,
        midia_nome_arquivo: msg.mediaSaved ? (msg.mediaFileName || null) : null,
        criado_em: incomingMsgResult.rows[0].criado_em,
        reply_to_message_id: replyInfo.reply_to_message_id,
      });
    }
  }

  // Atualizar ultima_msg_entrada_em (janela 24h WhatsApp) + resetar followup
  pool.query(`UPDATE conversas SET ultima_msg_entrada_em = NOW(), atualizado_em = NOW(), followup_count = 0, followup_ultimo_em = NULL WHERE id = $1`, [conversa_id]).catch(() => {});

  // --- Reject non-text media if agent config says so ---
  if (agent.mensagem_midia_nao_suportada && parsed.type !== 'text') {
    const rejectMsg = agent.mensagem_midia_nao_suportada;
    const sendResult = await sendTextMessage(phoneNumberId, graphToken, phone, rejectMsg);

    if (sendResult.wamid) {
      const rejectLogResult = await pool.query(`
        INSERT INTO mensagens_log (conversa_id, empresa_id, direcao, conteudo, remetente_tipo, remetente_nome, tipo_mensagem, whatsapp_message_id, criado_em)
        VALUES ($1, $2, 'saida', $3, 'ia', $4, 'text', $5, NOW())
        RETURNING id, criado_em
      `, [conversa_id, empresa_id, rejectMsg, agente_nome, sendResult.wamid]);

      if (rejectLogResult.rows[0]) {
        const conversaForFila3 = await pool.query('SELECT fila_id FROM conversas WHERE id = $1', [conversa_id]);
        emitNovaMensagem(conversa_id, conversaForFila3.rows[0]?.fila_id, {
          id: rejectLogResult.rows[0].id,
          conversa_id,
          conteudo: rejectMsg,
          direcao: 'saida',
          remetente_tipo: 'ia',
          remetente_nome: agente_nome,
          tipo_mensagem: 'text',
          criado_em: rejectLogResult.rows[0].criado_em,
        });
      }
    }
    // Se é conversa nova e tem chatbot, não retornar — continuar para iniciar o fluxo do chatbot
    if (!(isNewConversation && agent.chatbot_ativo && agent.chatbot_fluxo_id)) {
      return;
    }
    // Conversa nova com chatbot: rejeição enviada, agora continua para iniciar menu do chatbot
  }

  // --- Automações de Entrada (só para conversas novas) ---
  if (isNewConversation) {
    const matchAutomacao = await checkAutomacoesEntrada(empresa_id, phone);
    if (matchAutomacao) {
      createLogger.info({
        empresa_id, phone, conversa_id,
        automacao: matchAutomacao.automacao_nome,
        agente_destino_id: matchAutomacao.agente_destino_id,
      }, 'Automação de entrada: match encontrado, redirecionando para agente destino');

      // Buscar agente destino
      const destResult = await pool.query(`
        SELECT id as agente_id, nome as agente_nome, modelo, temperatura, max_tokens, prompt_ativo,
               cache_enabled, gemini_cache_id, cache_expires_at, mensagem_midia_nao_suportada,
               chatbot_fluxo_id, chatbot_ativo
        FROM agentes WHERE id = $1 AND empresa_id = $2 AND ativo = true
      `, [matchAutomacao.agente_destino_id, empresa_id]);

      if (destResult.rows.length > 0) {
        // Trocar agente na conversa
        agent = destResult.rows[0];
        ({ agente_id, agente_nome, modelo, temperatura, max_tokens, prompt_ativo } = agent);

        await pool.query(
          `UPDATE conversas SET agente_id = $1, atualizado_em = NOW() WHERE id = $2`,
          [agente_id, conversa_id]
        );

        // Injetar dados da automação como contexto no histórico Redis
        const dadosTexto = Object.entries(matchAutomacao.dados)
          .map(([k, v]) => `${k}: ${v}`)
          .join(', ');
        const contexto = `[AUTOMAÇÃO DE ENTRADA - ${matchAutomacao.automacao_nome}]: Cliente identificado com dados pré-aprovados. ${dadosTexto}`;
        await addToHistory(empresa_id, conversationKey, 'user', contexto);
        await addToHistory(empresa_id, conversationKey, 'user', historyText);

        // Buscar API keys do agente destino
        const destKeys = await getActiveKeysForAgent(empresa_id, agente_id);
        if (destKeys.length > 0) {
          // Processar direto com IA (pular chatbot)
          const result = await processAIResponse({
            empresa_id, conversa_id, contato_id, agente_id, agent,
            availableKeys: destKeys, conversationKey,
            messageText: historyText, parts, startTime,
          });

          if (result) {
            const sendResult = await sendTextMessage(phoneNumberId, graphToken, phone, result.text);
            const outgoingMsgResult = await pool.query(`
              INSERT INTO mensagens_log (
                conversa_id, empresa_id, direcao, conteudo, remetente_tipo, remetente_nome, tipo_mensagem,
                tokens_input, tokens_output, tools_invocadas_json,
                modelo_usado, api_key_usada_id, latencia_ms,
                whatsapp_message_id, status_entrega, criado_em
              ) VALUES ($1, $2, 'saida', $3, 'ia', $4, 'text', $5, $6, $7, $8, $9, $10, $11, $12, NOW())
              RETURNING id, criado_em
            `, [
              conversa_id, empresa_id, result.text, agente_nome,
              result.tokensInput, result.tokensOutput,
              result.toolsCalled.length > 0 ? JSON.stringify(result.toolsCalled.map(tc => tc.name)) : null,
              result.modelo, result.usedKeyId, result.processingTime,
              sendResult.wamid, sendResult.success ? 'sent' : 'failed',
            ]);

            if (outgoingMsgResult.rows[0]) {
              const conversaForFila = await pool.query('SELECT fila_id FROM conversas WHERE id = $1', [conversa_id]);
              emitNovaMensagem(conversa_id, conversaForFila.rows[0]?.fila_id, {
                id: outgoingMsgResult.rows[0].id, conversa_id,
                conteudo: result.text, direcao: 'saida',
                remetente_tipo: 'ia', remetente_nome: agente_nome,
                tipo_mensagem: 'text', criado_em: outgoingMsgResult.rows[0].criado_em,
              });
            }

            pool.query(`
              UPDATE uso_diario_agente SET total_atendimentos = total_atendimentos + 1,
                limite_atingido = CASE WHEN total_atendimentos + 1 >= limite_diario THEN true ELSE false END,
                atualizado_em = CURRENT_TIMESTAMP
              WHERE empresa_id = $1 AND agente_id = $2 AND data = CURRENT_DATE
            `, [empresa_id, agente_id]).catch(() => {});

            pool.query(`
              INSERT INTO conversacao_analytics (empresa_id, agente_id, conversation_id, tokens_input, tokens_output, iteracoes, tools_chamadas, tempo_processamento_ms, modelo, sucesso)
              VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
            `, [empresa_id, agente_id, conversationKey, result.tokensInput, result.tokensOutput, result.iteracoes, result.toolsCalled.length, result.processingTime, result.modelo, true]).catch(() => {});
          }
        }
        return; // Automação tratou a conversa, não continua pro chatbot
      }
    }
  }

  // --- Chatbot Flow Engine ---
  createLogger.info({ empresa_id, phone, chatbot_ativo: agent.chatbot_ativo, chatbot_fluxo_id: agent.chatbot_fluxo_id, agente: agente_nome }, 'CHATBOT CHECK');
  if (agent.chatbot_ativo && agent.chatbot_fluxo_id) {
    try {
      const flowState = await getFlowState(empresa_id, phone);
      createLogger.info({ empresa_id, phone, hasFlowState: !!flowState }, 'CHATBOT flow state check');

      // Buscar fluxo JSON do banco
      const fluxoResult = await pool.query(
        'SELECT fluxo_json FROM chatbot_fluxos WHERE id = $1 AND empresa_id = $2 AND ativo = true',
        [agent.chatbot_fluxo_id, empresa_id]
      );
      let fluxoJson = fluxoResult.rows[0]?.fluxo_json;
      createLogger.info({ empresa_id, phone, found: !!fluxoJson, type: typeof fluxoJson, hasNodes: !!(fluxoJson?.nodes), hasStart: !!(fluxoJson?.start_node) }, 'CHATBOT fluxo query result');

      // Se fluxo_json veio como string (double-stringify), fazer parse
      if (typeof fluxoJson === 'string') {
        try { fluxoJson = JSON.parse(fluxoJson); createLogger.info({ empresa_id, phone }, 'CHATBOT parsed string fluxo_json'); } catch { fluxoJson = null; }
      }

      if (!fluxoJson || !fluxoJson.nodes || !fluxoJson.start_node) {
        createLogger.warn({ empresa_id, fluxoId: agent.chatbot_fluxo_id, fluxoJson: fluxoJson ? 'exists but invalid' : 'null' }, 'Chatbot flow JSON invalid or not found');
      }

      if (fluxoJson && fluxoJson.nodes && fluxoJson.start_node) {
        if (isNewConversation) {
          // Nova conversa — sempre iniciar fluxo do zero (limpar flow state residual se existir)
          if (flowState) {
            await clearFlowState(empresa_id, phone);
            createLogger.info({ empresa_id, phone }, 'Flow state residual limpo para nova conversa');
          }
          createLogger.info({ empresa_id, phone, isNewConversation }, 'CHATBOT starting flow');
          const flowResult = await startFlow(empresa_id, phone, agent.chatbot_fluxo_id, fluxoJson);
          if (flowResult?.response) {
            const sendResult = await sendTextMessage(phoneNumberId, graphToken, phone, flowResult.response);
            // Log resposta do chatbot
            const flowLogResult = await pool.query(`
              INSERT INTO mensagens_log (conversa_id, empresa_id, direcao, conteudo, remetente_tipo, remetente_nome, tipo_mensagem, whatsapp_message_id, criado_em)
              VALUES ($1, $2, 'saida', $3, 'chatbot', $4, 'text', $5, NOW())
              RETURNING id, criado_em
            `, [conversa_id, empresa_id, flowResult.response, agente_nome, sendResult.wamid]);

            if (flowLogResult.rows[0]) {
              const conversaForFluxo = await pool.query('SELECT fila_id FROM conversas WHERE id = $1', [conversa_id]);
              emitNovaMensagem(conversa_id, conversaForFluxo.rows[0]?.fila_id, {
                id: flowLogResult.rows[0].id,
                conversa_id,
                conteudo: flowResult.response,
                direcao: 'saida',
                remetente_tipo: 'chatbot',
                remetente_nome: agente_nome,
                tipo_mensagem: 'text',
                criado_em: flowLogResult.rows[0].criado_em,
              });
            }

            addToHistory(empresa_id, conversationKey, 'user', historyText).catch(() => {});
            addToHistory(empresa_id, conversationKey, 'model', flowResult.response).catch(() => {});
            createLogger.info({ empresa_id, phone, fluxoId: agent.chatbot_fluxo_id }, 'Chatbot flow started');
            return;
          }
        } else if (flowState) {
          // Fluxo ativo — processar input
          const flowResult = await processFlowInput(empresa_id, phone, fluxoJson, historyText);

          if (flowResult) {
            // Ação especial: transferir para fila
            if (flowResult.action === 'transfer_queue' && flowResult.queueId) {
              if (flowResult.response) {
                const sendResult = await sendTextMessage(phoneNumberId, graphToken, phone, flowResult.response);
                await pool.query(`
                  INSERT INTO mensagens_log (conversa_id, empresa_id, direcao, conteudo, remetente_tipo, remetente_nome, tipo_mensagem, whatsapp_message_id, criado_em)
                  VALUES ($1, $2, 'saida', $3, 'chatbot', $4, 'text', $5, NOW())
                `, [conversa_id, empresa_id, flowResult.response, agente_nome, sendResult.wamid]);
              }
              // Transferir conversa para fila
              await pool.query(
                `UPDATE conversas SET fila_id = $1, controlado_por = 'fila', atualizado_em = NOW() WHERE id = $2`,
                [flowResult.queueId, conversa_id]
              );
              addToHistory(empresa_id, conversationKey, 'user', historyText).catch(() => {});
              createLogger.info({ empresa_id, phone, queueId: flowResult.queueId }, 'Chatbot flow transferred to queue');
              return;
            }

            // Ação: assign_agent — passa para IA (mesmo agente ou agente destino)
            if (flowResult.action === 'assign_agent') {
              if (flowResult.response) {
                const sendResult = await sendTextMessage(phoneNumberId, graphToken, phone, flowResult.response);
                await pool.query(`
                  INSERT INTO mensagens_log (conversa_id, empresa_id, direcao, conteudo, remetente_tipo, remetente_nome, tipo_mensagem, whatsapp_message_id, criado_em)
                  VALUES ($1, $2, 'saida', $3, 'chatbot', $4, 'text', $5, NOW())
                `, [conversa_id, empresa_id, flowResult.response, agente_nome, sendResult.wamid]);
              }

              // Guardar agente antes da troca para saber se mudou
              const agenteAntesDaTroca = agente_id;

              // Se tem agente destino específico, trocar o agente
              if (flowResult.agentId && flowResult.agentId !== agente_id) {
                const destAgentResult = await pool.query(`
                  SELECT id as agente_id, nome as agente_nome, modelo, temperatura, max_tokens, prompt_ativo,
                         cache_enabled, gemini_cache_id, cache_expires_at, mensagem_midia_nao_suportada,
                         chatbot_fluxo_id, chatbot_ativo
                  FROM agentes WHERE id = $1 AND empresa_id = $2 AND ativo = true
                `, [flowResult.agentId, empresa_id]);

                if (destAgentResult.rows.length > 0) {
                  agent = destAgentResult.rows[0];
                  ({ agente_id, agente_nome, modelo, temperatura, max_tokens, prompt_ativo } = agent);
                  // Atualizar conversa com novo agente + fila (se especificada)
                  if (flowResult.queueId) {
                    await pool.query(
                      `UPDATE conversas SET agente_id = $1, fila_id = $3, controlado_por = 'ia', atualizado_em = NOW() WHERE id = $2`,
                      [agente_id, conversa_id, flowResult.queueId]
                    );
                    createLogger.info({ empresa_id, phone, destAgente: agente_nome, destFila: flowResult.queueId }, 'Chatbot transferred to destination agent + queue');
                  } else {
                    await pool.query(
                      `UPDATE conversas SET agente_id = $1, controlado_por = 'ia', atualizado_em = NOW() WHERE id = $2`,
                      [agente_id, conversa_id]
                    );
                    createLogger.info({ empresa_id, phone, destAgente: agente_nome }, 'Chatbot transferred to destination agent');
                  }
                }
              }

              // Verificar se o agente destino tem chatbot — iniciar fluxo em vez de IA
              // SÓ se o agente MUDOU (veio de outro agente, ex: Triagem → FGTS)
              // Se é o mesmo agente, o fluxo dele acabou de completar — ir pra IA
              const agenteMudou = agente_id !== agenteAntesDaTroca;
              if (agent.chatbot_ativo && agent.chatbot_fluxo_id && agenteMudou) {
                const destFluxoResult = await pool.query(
                  'SELECT fluxo_json FROM chatbot_fluxos WHERE id = $1 AND empresa_id = $2 AND ativo = true',
                  [agent.chatbot_fluxo_id, empresa_id]
                );
                let destFluxoJson = destFluxoResult.rows[0]?.fluxo_json;
                if (typeof destFluxoJson === 'string') {
                  try { destFluxoJson = JSON.parse(destFluxoJson); } catch { destFluxoJson = null; }
                }

                if (destFluxoJson && destFluxoJson.nodes && destFluxoJson.start_node) {
                  // Iniciar chatbot do agente destino
                  const destFlowResult = await startFlow(empresa_id, phone, agent.chatbot_fluxo_id, destFluxoJson);
                  if (destFlowResult?.response) {
                    const sendResult2 = await sendTextMessage(phoneNumberId, graphToken, phone, destFlowResult.response);
                    const flowLogResult2 = await pool.query(`
                      INSERT INTO mensagens_log (conversa_id, empresa_id, direcao, conteudo, remetente_tipo, remetente_nome, tipo_mensagem, whatsapp_message_id, criado_em)
                      VALUES ($1, $2, 'saida', $3, 'chatbot', $4, 'text', $5, NOW())
                      RETURNING id, criado_em
                    `, [conversa_id, empresa_id, destFlowResult.response, agente_nome, sendResult2.wamid]);

                    if (flowLogResult2.rows[0]) {
                      const conversaForFluxo2 = await pool.query('SELECT fila_id FROM conversas WHERE id = $1', [conversa_id]);
                      emitNovaMensagem(conversa_id, conversaForFluxo2.rows[0]?.fila_id, {
                        id: flowLogResult2.rows[0].id,
                        conversa_id,
                        conteudo: destFlowResult.response,
                        direcao: 'saida',
                        remetente_tipo: 'chatbot',
                        remetente_nome: agente_nome,
                        tipo_mensagem: 'text',
                        criado_em: flowLogResult2.rows[0].criado_em,
                      });
                    }

                    addToHistory(empresa_id, conversationKey, 'user', historyText).catch(() => {});
                    addToHistory(empresa_id, conversationKey, 'model', destFlowResult.response).catch(() => {});
                    createLogger.info({ empresa_id, phone, destAgente: agente_nome, fluxoId: agent.chatbot_fluxo_id }, 'Assign agent → destination chatbot started');
                    return;
                  }
                }
              }

              // Sem chatbot no destino — adicionar contexto e continuar pra IA
              // Salvar variáveis coletadas no contato (cpf, nome_completo, etc.)
              if (flowResult.variables && Object.keys(flowResult.variables).length > 0 && contato_id) {
                try {
                  const vars = flowResult.variables;
                  // Atualizar nome do contato se coletado
                  if (vars.nome_completo || vars.nome) {
                    const nomeContato = vars.nome_completo || vars.nome;
                    await pool.query(
                      `UPDATE contatos SET nome = $1, atualizado_em = NOW() WHERE id = $2 AND empresa_id = $3`,
                      [String(nomeContato), contato_id, empresa_id]
                    );
                    // Atualizar também na conversa
                    pool.query(`UPDATE conversas SET contato_nome = $1 WHERE id = $2`, [String(nomeContato), conversa_id]).catch(() => {});
                  }
                  // Salvar todas as variáveis em dados_json do contato
                  const contatoResult = await pool.query(
                    `SELECT dados_json FROM contatos WHERE id = $1 AND empresa_id = $2`,
                    [contato_id, empresa_id]
                  );
                  if (contatoResult.rows.length > 0) {
                    const dadosAtuais = contatoResult.rows[0].dados_json || {};
                    for (const [chave, valor] of Object.entries(vars)) {
                      dadosAtuais[chave] = String(valor);
                    }
                    await pool.query(
                      `UPDATE contatos SET dados_json = $1, atualizado_em = NOW() WHERE id = $2`,
                      [JSON.stringify(dadosAtuais), contato_id]
                    );
                  }
                  createLogger.info({ conversa_id, contato_id, variables: vars }, 'Chatbot variables saved to contact');
                } catch (saveErr) {
                  createLogger.error({ err: saveErr, conversa_id }, 'Error saving chatbot variables to contact');
                }
              }

              if (flowResult.context) {
                await addToHistory(empresa_id, conversationKey, 'user', `[CONTEXTO DO FLUXO]: ${flowResult.context}`);
              }
              await addToHistory(empresa_id, conversationKey, 'user', historyText);
              createLogger.info({ empresa_id, phone, agente: agente_nome, variables: flowResult.variables }, 'Chatbot flow assigned to agent (no dest chatbot)');
              // Continua para processamento pela IA (não retorna)
            }

            // Ação: end — finaliza
            else if (flowResult.action === 'end') {
              if (flowResult.response) {
                const sendResult = await sendTextMessage(phoneNumberId, graphToken, phone, flowResult.response);
                await pool.query(`
                  INSERT INTO mensagens_log (conversa_id, empresa_id, direcao, conteudo, remetente_tipo, remetente_nome, tipo_mensagem, whatsapp_message_id, criado_em)
                  VALUES ($1, $2, 'saida', $3, 'chatbot', $4, 'text', $5, NOW())
                `, [conversa_id, empresa_id, flowResult.response, agente_nome, sendResult.wamid]);
              }
              addToHistory(empresa_id, conversationKey, 'user', historyText).catch(() => {});
              createLogger.info({ empresa_id, phone }, 'Chatbot flow ended');
              return;
            }

            // Fluxo respondeu (handled=true)
            else if (flowResult.handled && flowResult.response) {
              const sendResult = await sendTextMessage(phoneNumberId, graphToken, phone, flowResult.response);
              const flowLogResult = await pool.query(`
                INSERT INTO mensagens_log (conversa_id, empresa_id, direcao, conteudo, remetente_tipo, remetente_nome, tipo_mensagem, whatsapp_message_id, criado_em)
                VALUES ($1, $2, 'saida', $3, 'chatbot', $4, 'text', $5, NOW())
                RETURNING id, criado_em
              `, [conversa_id, empresa_id, flowResult.response, agente_nome, sendResult.wamid]);

              if (flowLogResult.rows[0]) {
                const conversaForFluxo = await pool.query('SELECT fila_id FROM conversas WHERE id = $1', [conversa_id]);
                emitNovaMensagem(conversa_id, conversaForFluxo.rows[0]?.fila_id, {
                  id: flowLogResult.rows[0].id,
                  conversa_id,
                  conteudo: flowResult.response,
                  direcao: 'saida',
                  remetente_tipo: 'chatbot',
                  remetente_nome: agente_nome,
                  tipo_mensagem: 'text',
                  criado_em: flowLogResult.rows[0].criado_em,
                });
              }

              addToHistory(empresa_id, conversationKey, 'user', historyText).catch(() => {});
              addToHistory(empresa_id, conversationKey, 'model', flowResult.response).catch(() => {});
              return;
            }

            // Fallback para IA (handled=false ou handled sem response/action)
            else {
              if (flowResult.context) {
                addToHistory(empresa_id, conversationKey, 'user', `[CONTEXTO DO FLUXO]: ${flowResult.context}`).catch(() => {});
              }
              addToHistory(empresa_id, conversationKey, 'user', historyText).catch(() => {});
              createLogger.info({ empresa_id, phone, handled: flowResult.handled, hasResponse: !!flowResult.response }, 'Chatbot fallback to AI');
              // Continua para processamento pela IA
            }
          }
        }
      }
    } catch (flowError) {
      createLogger.error({ err: flowError, empresa_id, phone }, 'Flow engine error, falling back to AI');
      // Em caso de erro, continua para processamento normal pela IA
    }
  }

  // --- Process with AI ---
  const result = await processAIResponse({
    empresa_id,
    conversa_id,
    contato_id,
    agente_id,
    agent,
    availableKeys,
    conversationKey,
    messageText: historyText,
    parts,
    startTime,
  });

  if (!result) return;

  // --- Send response via Meta directly ---
  const sendResult = await sendTextMessage(phoneNumberId, graphToken, phone, result.text);

  // --- Log outgoing message ---
  const outgoingMsgResult = await pool.query(`
    INSERT INTO mensagens_log (
      conversa_id, empresa_id, direcao, conteudo, remetente_tipo, remetente_nome, tipo_mensagem,
      tokens_input, tokens_output, tools_invocadas_json,
      modelo_usado, api_key_usada_id, latencia_ms,
      whatsapp_message_id, status_entrega, criado_em
    ) VALUES ($1, $2, 'saida', $3, 'ia', $4, 'text', $5, $6, $7, $8, $9, $10, $11, $12, NOW())
    RETURNING id, criado_em
  `, [
    conversa_id, empresa_id, result.text, agente_nome,
    result.tokensInput, result.tokensOutput,
    result.toolsCalled.length > 0 ? JSON.stringify(result.toolsCalled.map(tc => tc.name)) : null,
    result.modelo, result.usedKeyId, result.processingTime,
    sendResult.wamid,
    sendResult.success ? 'sent' : 'failed',
  ]);

  // Emit WebSocket for AI response
  if (outgoingMsgResult.rows[0]) {
    const conversaForFila2 = await pool.query('SELECT fila_id FROM conversas WHERE id = $1', [conversa_id]);
    const currentFilaId2 = conversaForFila2.rows[0]?.fila_id;
    emitNovaMensagem(conversa_id, currentFilaId2, {
      id: outgoingMsgResult.rows[0].id,
      conversa_id,
      conteudo: result.text,
      direcao: 'saida',
      remetente_tipo: 'ia',
      remetente_nome: agente_nome,
      tipo_mensagem: 'text',
      criado_em: outgoingMsgResult.rows[0].criado_em,
    });
  }

  // --- Increment daily usage (fire-and-forget) ---
  pool.query(`
    UPDATE uso_diario_agente
    SET total_atendimentos = total_atendimentos + 1,
        limite_atingido = CASE WHEN total_atendimentos + 1 >= limite_diario THEN true ELSE false END,
        atualizado_em = CURRENT_TIMESTAMP
    WHERE empresa_id = $1 AND agente_id = $2 AND data = CURRENT_DATE
  `, [empresa_id, agente_id]).catch(() => {});

  // --- Log analytics (fire-and-forget) ---
  pool.query(`
    INSERT INTO conversacao_analytics (
      empresa_id, agente_id, conversation_id,
      tokens_input, tokens_output, iteracoes,
      tools_chamadas, tempo_processamento_ms, modelo, sucesso
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
  `, [
    empresa_id, agente_id, conversationKey,
    result.tokensInput, result.tokensOutput,
    result.iteracoes, result.toolsCalled.length,
    result.processingTime, result.modelo, true,
  ]).catch(() => {});

  // --- Transfer check ---
  await checkTransferRules({
    empresa_id, agente_id, conversa_id,
    messageText: historyText, aiResponse: result.text,
    toolsCalled: result.toolsCalled,
  });
}

/**
 * Shared AI processing: daily limit, tools, Gemini, Redis history.
 */
export async function processAIResponse({
  empresa_id, conversa_id, contato_id, agente_id, agent,
  availableKeys, conversationKey, messageText, parts, startTime,
}) {
  const { modelo, temperatura, max_tokens, prompt_ativo } = agent;

  // --- Credit check (pool mensal por empresa) ---
  // 1 crédito = 1 conversa (primeira chamada IA da conversa, não por mensagem)
  const jaConsumiu = await pool.query(
    `SELECT 1 FROM creditos_ia_historico WHERE empresa_id = $1 AND tipo = 'consumo' AND referencia = $2 LIMIT 1`,
    [empresa_id, `conversa:${conversa_id}`]
  );

  if (jaConsumiu.rows.length === 0) {
    // Primeira chamada IA desta conversa — consumir crédito
    const creditResult = await consumirCredito(empresa_id, `conversa:${conversa_id}`);
    if (!creditResult.consumido) {
      createLogger.warn('Créditos IA esgotados', { empresa_id, agente_id, motivo: creditResult.motivo });
      return null;
    }
    if (creditResult.fonte !== 'sem_controle') {
      createLogger.info('Crédito consumido (nova conversa)', { empresa_id, fonte: creditResult.fonte, saldo: creditResult.saldo_restante });
    }
  } else {
    // Já consumiu crédito para esta conversa — verificar se ainda tem saldo (não consumir de novo)
    const creditos = await pool.query(
      `SELECT bloqueado FROM creditos_ia WHERE empresa_id = $1`,
      [empresa_id]
    );
    if (creditos.rows.length > 0 && creditos.rows[0].bloqueado) {
      createLogger.warn('Créditos IA esgotados (conversa já consumida mas conta bloqueada)', { empresa_id, agente_id });
      return null;
    }
  }

  // --- Daily usage tracking (analytics, fire-and-forget) ---
  pool.query(`
    INSERT INTO uso_diario_agente (empresa_id, agente_id, data, total_atendimentos, limite_diario)
    VALUES ($1, $2, CURRENT_DATE, 0, 999999)
    ON CONFLICT (empresa_id, agente_id, data) DO NOTHING
  `, [empresa_id, agente_id]).catch(() => {});

  // --- Get agent tools ---
  const toolsResult = await pool.query(`
    SELECT t.id, t.nome, t.descricao_para_llm, t.url, t.metodo,
           t.headers_json, t.body_template_json, t.parametros_schema_json, t.timeout_ms,
           t.tipo_tool, t.agente_destino_id, t.fila_destino_id
    FROM tools t
    INNER JOIN agente_tools at2 ON t.id = at2.tool_id
    WHERE at2.agente_id = $1 AND t.ativo = true
    ORDER BY at2.ordem_prioridade ASC
  `, [agente_id]);

  const tools = toolsResult.rows;

  // --- Inject attribute tools ---
  const camposResult = await pool.query(
    `SELECT chave, display_name, tipo, contexto, descricao, opcoes FROM campos_personalizados WHERE empresa_id = $1 AND ativo = true ORDER BY contexto, ordem`,
    [empresa_id]
  );
  if (camposResult.rows.length > 0) {
    injectAtributoTools(tools, camposResult.rows);
  }

  // --- Redis history ---
  const history = await getHistory(empresa_id, conversationKey);
  await addToHistory(empresa_id, conversationKey, 'user', messageText);

  // --- Process with Gemini (failover) ---
  const toolDeclarations = buildToolDeclarations(tools);

  // Buscar dados do contato para log de execução
  const convDataForLog = await pool.query(
    `SELECT contato_whatsapp, contato_nome FROM conversas WHERE id = $1`,
    [conversa_id]
  ).catch(() => ({ rows: [] }));
  const logContato = convDataForLog.rows[0] || {};

  // Injetar dados do contato na mensagem (funciona com e sem cache)
  let messageWithContext = messageText;
  let partsWithContext = parts;
  if (logContato.contato_whatsapp || logContato.contato_nome) {
    const dadosContato = [
      logContato.contato_whatsapp ? `Telefone/WhatsApp: ${logContato.contato_whatsapp}` : '',
      logContato.contato_nome ? `Nome do contato: ${logContato.contato_nome}` : '',
    ].filter(Boolean).join(', ');
    const contextPrefix = `[Dados do contato: ${dadosContato}]\n`;
    messageWithContext = contextPrefix + messageText;
    // Se tem parts (mídia), injetar o contexto como primeiro part texto
    if (parts && Array.isArray(parts)) {
      partsWithContext = [{ text: contextPrefix }, ...parts];
    }
  }

  const toolExecutor = async (tool, args) => {
    const toolName = tool.name || tool.nome;
    const toolConfig = tools.find(t => t.nome.toLowerCase() === toolName.toLowerCase());
    if (!toolConfig) throw new Error(`Tool ${toolName} not found`);

    let result;
    if (toolConfig.tipo_tool === 'transferencia') {
      result = await executeTransferTool(toolConfig, { conversa_id, empresa_id });
    } else if (toolConfig.tipo_tool === 'encerramento') {
      result = await executeFinalizarTool({ conversa_id, empresa_id });
    } else if (toolConfig.tipo_tool === 'atributo') {
      result = await executeAtributoTool(
        { conversa_id, empresa_id, contato_id, tipo_atributo: toolConfig._atributo_contexto },
        args
      );
    } else {
      result = await executeTool(toolConfig, args);
    }

    // Log da execução (non-blocking)
    logToolExecution({
      empresa_id,
      tool_id: toolConfig.id,
      tool_nome: toolConfig.nome,
      tipo_tool: toolConfig.tipo_tool || 'http',
      agente_id,
      agente_nome: agent.agente_nome,
      conversa_id,
      contato_whatsapp: logContato.contato_whatsapp,
      contato_nome: logContato.contato_nome,
      parametros: args,
      resultado: result?.data || result?.message || result?.error,
      sucesso: result?.success ?? false,
      erro: result?.success ? null : [result?.error, result?.message, result?.statusText].filter(Boolean).join(' | '),
      tempo_ms: result?.duration_ms,
    });

    return transformResultForLLM(result, 8000);
  };

  // Check cache
  let cachedContentName = null;
  if (agent.cache_enabled && agent.gemini_cache_id && agent.cache_expires_at) {
    if (new Date(agent.cache_expires_at) > new Date()) {
      cachedContentName = agent.gemini_cache_id;
    }
  }

  let result = null;
  let usedKeyId = availableKeys[0]?.id;
  let historyForGemini = formatHistoryForGemini(history);
  let historyCleared = false;

  for (let keyIndex = 0; keyIndex < availableKeys.length; keyIndex++) {
    const currentKey = availableKeys[keyIndex];
    usedKeyId = currentKey.id;

    try {
      result = await processMessageWithTools(
        {
          apiKey: currentKey.gemini_api_key,
          model: modelo,
          systemPrompt: prompt_ativo,
          tools: toolDeclarations,
          history: historyForGemini,
          message: messageWithContext,
          parts: partsWithContext,
          temperature: temperatura,
          maxTokens: max_tokens,
          cachedContentName,
        },
        toolExecutor
      );

      if (currentKey.id) recordKeySuccess(currentKey.id).catch(() => {});
      break;
    } catch (error) {
      const isRetryable = error.code === 'RATE_LIMITED' || error.code === 'INVALID_KEY' || error.code === 'API_ERROR';
      const isDataError = error.code === 'DATA_ERROR';
      if (currentKey.id && !isDataError) recordKeyError(currentKey.id, error.message || 'Unknown error').catch(() => {});

      // DATA_ERROR (INVALID_ARGUMENT): corrupted history — clear and retry once with same key
      if (isDataError && !historyCleared && historyForGemini.length > 0) {
        createLogger.warn('Corrupted history detected, clearing and retrying', { empresa_id, conversa_id, agente_id });
        await clearHistory(empresa_id, conversationKey).catch(() => {});
        historyForGemini = [];
        historyCleared = true;
        keyIndex--; // Retry same key with empty history
        continue;
      }

      createLogger.warn('API key failed', { empresa_id, agente_id, key_index: keyIndex, error_code: error.code });

      if (!isRetryable || keyIndex >= availableKeys.length - 1) throw error;
    }
  }

  if (!result) throw new Error('All API keys failed');

  // --- Save response to Redis ---
  await addToHistory(empresa_id, conversationKey, 'model', result.text);
  for (const toolCall of result.toolsCalled) {
    await addToolCallToHistory(empresa_id, conversationKey, { name: toolCall.name, args: toolCall.args }, toolCall.result);
  }

  const processingTime = Date.now() - startTime;

  return {
    text: result.text,
    tokensInput: result.tokensInput,
    tokensOutput: result.tokensOutput,
    toolsCalled: result.toolsCalled,
    iteracoes: result.iteracoes,
    modelo,
    agente_nome: agent.agente_nome,
    usedKeyId,
    processingTime,
  };
}

/**
 * Check agent transfer rules after AI response.
 */
async function checkTransferRules({ empresa_id, agente_id, conversa_id, messageText, aiResponse, toolsCalled }) {
  try {
    const transferRules = await pool.query(`
      SELECT at2.*, a_dest.nome as agente_destino_nome
      FROM agente_transferencias at2
      JOIN agentes a_dest ON a_dest.id = at2.agente_destino_id AND a_dest.ativo = true
      WHERE at2.agente_origem_id = $1 AND at2.ativo = true
      ORDER BY at2.criado_em ASC
    `, [agente_id]);

    if (transferRules.rows.length === 0) return;

    for (const rule of transferRules.rows) {
      let shouldTransfer = false;

      if (rule.trigger_tipo === 'keyword') {
        const textToCheck = (messageText + ' ' + aiResponse).toLowerCase();
        shouldTransfer = textToCheck.includes(String(rule.trigger_valor).toLowerCase());
      } else if (rule.trigger_tipo === 'tool_result') {
        shouldTransfer = toolsCalled.some(tc =>
          tc.name === rule.trigger_valor ||
          (tc.result && JSON.stringify(tc.result).includes(String(rule.trigger_valor)))
        );
      } else if (rule.trigger_tipo === 'menu_opcao') {
        shouldTransfer = messageText.trim().toLowerCase() === String(rule.trigger_valor).toLowerCase();
      }

      if (shouldTransfer) {
        createLogger.info('Transfer triggered', {
          empresa_id, from_agent: agente_id, to_agent: rule.agente_destino_id,
          trigger: rule.trigger_tipo,
        });

        await pool.query(`UPDATE conversas SET agente_id = $1, atualizado_em = CURRENT_TIMESTAMP WHERE id = $2`,
          [rule.agente_destino_id, conversa_id]);

        pool.query(`
          INSERT INTO controle_historico (empresa_id, conversa_id, acao, de_controlador, para_controlador, motivo)
          VALUES ($1, $2, 'transferencia_agente', 'ia', 'ia', $3)
        `, [empresa_id, conversa_id, rule.trigger_tipo + ':' + rule.trigger_valor]).catch(() => {});

        break;
      }
    }
  } catch (transferError) {
    createLogger.error('Transfer check failed (non-blocking)', { error: transferError.message });
  }
}

/**
 * Inject attribute tools (campos_personalizados) into tools array.
 */
function injectAtributoTools(tools, campos) {
  const contatoCampos = campos.filter(c => c.contexto === 'contato');
  const atendimentoCampos = campos.filter(c => c.contexto === 'atendimento');

  if (contatoCampos.length > 0) {
    const properties = {};
    for (const c of contatoCampos) {
      const prop = { description: c.descricao || c.display_name };
      if (c.tipo === 'number') prop.type = 'number';
      else if (c.tipo === 'checkbox') { prop.type = 'string'; prop.enum = ['true', 'false']; }
      else if (c.tipo === 'list' && c.opcoes?.length > 0) { prop.type = 'string'; prop.enum = c.opcoes; }
      else prop.type = 'string';
      properties[c.chave] = prop;
    }
    tools.push({
      nome: 'salvar_atributo_contato',
      descricao_para_llm: `Salva informacoes do contato/cliente. Use quando o cliente informar dados pessoais como ${contatoCampos.map(c => c.display_name).join(', ')}. Pode salvar um ou mais campos de uma vez.`,
      parametros_schema_json: { type: 'object', properties, required: [] },
      tipo_tool: 'atributo',
      _atributo_contexto: 'contato',
    });
  }

  if (atendimentoCampos.length > 0) {
    const properties = {};
    for (const c of atendimentoCampos) {
      const prop = { description: c.descricao || c.display_name };
      if (c.tipo === 'number') prop.type = 'number';
      else if (c.tipo === 'checkbox') { prop.type = 'string'; prop.enum = ['true', 'false']; }
      else if (c.tipo === 'list' && c.opcoes?.length > 0) { prop.type = 'string'; prop.enum = c.opcoes; }
      else prop.type = 'string';
      properties[c.chave] = prop;
    }
    tools.push({
      nome: 'salvar_atributo_atendimento',
      descricao_para_llm: `Salva informacoes especificas deste atendimento. Use para registrar ${atendimentoCampos.map(c => c.display_name).join(', ')}. Pode salvar um ou mais campos de uma vez.`,
      parametros_schema_json: { type: 'object', properties, required: [] },
      tipo_tool: 'atributo',
      _atributo_contexto: 'atendimento',
    });
  }
}

/**
 * Handle WhatsApp status updates (delivered, read, failed)
 */
/**
 * Trigger the new agent to respond proactively after a transfer.
 * Injects a system context message into Redis history, calls Gemini,
 * and sends the response to the client via WhatsApp.
 */
export async function triggerNewAgentResponse({ conversa_id, empresa_id }) {
  const triggerLogger = createLogger.child({ fn: 'triggerNewAgentResponse' });

  try {
    // 1. Get conversation details
    const convResult = await pool.query(
      `SELECT c.id, c.contato_whatsapp, c.contato_nome, c.contato_id, c.agente_id, c.fila_id,
              c.whatsapp_number_id, c.controlado_por
       FROM conversas c
       WHERE c.id = $1 AND c.empresa_id = $2 AND c.status = 'ativo'`,
      [conversa_id, empresa_id]
    );

    if (convResult.rows.length === 0) {
      triggerLogger.warn({ conversa_id }, 'Conversa not found for trigger');
      return;
    }

    const conv = convResult.rows[0];

    if (!conv.agente_id) {
      triggerLogger.warn({ conversa_id }, 'No agent assigned, skip trigger');
      return;
    }

    // 2. Get new agent config
    const agentResult = await pool.query(
      `SELECT id as agente_id, nome as agente_nome, modelo, temperatura, max_tokens, prompt_ativo,
              cache_enabled, gemini_cache_id, cache_expires_at
       FROM agentes WHERE id = $1 AND empresa_id = $2 AND ativo = true`,
      [conv.agente_id, empresa_id]
    );

    if (agentResult.rows.length === 0) {
      triggerLogger.warn({ conversa_id, agente_id: conv.agente_id }, 'New agent not found');
      return;
    }

    const agent = agentResult.rows[0];

    // 3. Get API keys
    const availableKeys = await getActiveKeysForAgent(empresa_id, agent.agente_id);
    if (availableKeys.length === 0) {
      triggerLogger.warn({ conversa_id, agente_id: agent.agente_id }, 'No API keys for new agent');
      return;
    }

    // 4. Get WhatsApp number credentials
    const wnResult = await pool.query(
      `SELECT wn.phone_number_id, wn.token_graph_api
       FROM whatsapp_numbers wn
       WHERE wn.id = $1 AND wn.empresa_id = $2 AND wn.ativo = true`,
      [conv.whatsapp_number_id, empresa_id]
    );

    if (wnResult.rows.length === 0) {
      triggerLogger.warn({ conversa_id }, 'WhatsApp number not found for trigger');
      return;
    }

    const phoneNumberId = wnResult.rows[0].phone_number_id;
    const graphToken = decrypt(wnResult.rows[0].token_graph_api);
    if (!graphToken) {
      triggerLogger.warn({ conversa_id }, 'No Graph API token for trigger');
      return;
    }

    // 5. Inject transfer context into Redis history
    const conversationKey = `whatsapp:${conv.contato_whatsapp}`;
    const transferContextMsg = '[Sistema] Cliente transferido para você. Inicie o atendimento de acordo com suas instruções. Apresente-se e pergunte como pode ajudar.';
    await addToHistory(empresa_id, conversationKey, 'user', transferContextMsg);

    // 6. Call Gemini via processAIResponse
    const startTime = Date.now();
    const result = await processAIResponse({
      empresa_id,
      conversa_id,
      contato_id: conv.contato_id,
      agente_id: agent.agente_id,
      agent,
      availableKeys,
      conversationKey,
      messageText: transferContextMsg,
      parts: [{ text: transferContextMsg }],
      startTime,
    });

    if (!result || !result.text) {
      triggerLogger.warn({ conversa_id }, 'New agent produced no response');
      return;
    }

    // 7. Send response to WhatsApp
    const sendResult = await sendTextMessage(phoneNumberId, graphToken, conv.contato_whatsapp, result.text);

    // 8. Log outgoing message
    const outMsgResult = await pool.query(`
      INSERT INTO mensagens_log (
        conversa_id, empresa_id, direcao, conteudo, remetente_tipo, remetente_nome, tipo_mensagem,
        tokens_input, tokens_output, modelo_usado, api_key_usada_id, latencia_ms,
        whatsapp_message_id, status_entrega, criado_em
      ) VALUES ($1, $2, 'saida', $3, 'ia', $4, 'text', $5, $6, $7, $8, $9, $10, $11, NOW())
      RETURNING id, criado_em
    `, [
      conversa_id, empresa_id, result.text, agent.agente_nome,
      result.tokensInput, result.tokensOutput,
      result.modelo, result.usedKeyId, result.processingTime,
      sendResult.wamid, sendResult.success ? 'sent' : 'failed',
    ]);

    // 9. Emit WebSocket
    if (outMsgResult.rows[0]) {
      emitNovaMensagem(conversa_id, conv.fila_id, {
        id: outMsgResult.rows[0].id,
        conversa_id,
        conteudo: result.text,
        direcao: 'saida',
        remetente_tipo: 'ia',
        remetente_nome: agent.agente_nome,
        tipo_mensagem: 'text',
        criado_em: outMsgResult.rows[0].criado_em,
      });
    }

    triggerLogger.info({
      conversa_id, agente: agent.agente_nome,
      duration_ms: Date.now() - startTime,
    }, 'New agent triggered successfully after transfer');

  } catch (error) {
    triggerLogger.error({ err: error, conversa_id, empresa_id }, 'Failed to trigger new agent after transfer');
  }
}

export async function handleStatusUpdates(statuses, empresa_id) {
  for (const status of statuses) {
    const wamid = status.id;
    const statusValue = status.status;
    if (!wamid || !statusValue) continue;

    const statusMap = { sent: 'sent', delivered: 'delivered', read: 'read', failed: 'failed' };
    const mappedStatus = statusMap[statusValue];
    if (!mappedStatus) continue;

    try {
      const result = await pool.query(`
        UPDATE mensagens_log SET status_entrega = $1
        WHERE whatsapp_message_id = $2 AND empresa_id = $3
        RETURNING id, conversa_id
      `, [mappedStatus, wamid, empresa_id]);

      if (result.rows.length > 0) {
        emitStatusEntrega(result.rows[0].conversa_id, {
          mensagem_id: result.rows[0].id,
          whatsapp_message_id: wamid,
          status_entrega: mappedStatus,
        });
      }
    } catch (err) {
      createLogger.error('Failed to update status', { error: err.message, wamid });
    }
  }
}
