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
import { getHistory, addToHistory, addToolCallToHistory, formatHistoryForGemini } from './memory.js';
import { processMessageWithTools, buildToolDeclarations } from './gemini.js';
import { executeTool, executeTransferTool, executeFinalizarTool, executeAtributoTool, transformResultForLLM, logToolExecution } from './tool-runner.js';
import { parseMetaMessage, buildGeminiParts } from './media-handler.js';
import { saveMedia } from './media-storage.js';
import { sendTextMessage, markAsRead } from './whatsapp-sender.js';
import { atribuirConversaAutomatica, calcularStatsFila } from './fila-manager.js';
import { emitNovaMensagem, emitNovaConversaNaFila, emitFilaStats, emitStatusEntrega } from './websocket.js';

const createLogger = logger.child({ module: 'message-processor' });

/**
 * Process an incoming WhatsApp message (from Meta webhook).
 * This is the heavy logic extracted from whatsapp.js webhook route.
 */
export async function processWhatsAppMessage({ message, contacts, phoneNumberId, empresa_id, wnId }) {
  const startTime = Date.now();
  const phone = message.from;
  const contactName = contacts[0]?.profile?.name || null;
  const messageId = message.id;

  // Get Graph API token for this WhatsApp number
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

  // Mark as read (non-blocking)
  markAsRead(phoneNumberId, graphToken, messageId).catch(() => {});

  // --- Parse message (text, image, audio, etc.) ---
  const parsed = parseMetaMessage(message);

  if (parsed.type === 'unknown' && !parsed.text) {
    createLogger.debug('Ignoring unknown message type', { type: message.type, phone });
    return;
  }

  if (parsed.type === 'reaction') {
    createLogger.debug('Ignoring reaction', { phone });
    return;
  }

  // Build Gemini parts (downloads media if needed)
  const { parts, historyText, mediaBuffer, mediaMimeType, mediaFileName } = await buildGeminiParts(parsed, graphToken);

  // Save media to disk if present
  let mediaSaved = null;
  if (mediaBuffer) {
    try {
      mediaSaved = await saveMedia(mediaBuffer, empresa_id, mediaMimeType, mediaFileName);
    } catch (err) {
      createLogger.error('Failed to save media to disk', { error: err.message, empresa_id, type: parsed.type });
    }
  }

  createLogger.info('Processing WhatsApp message', {
    empresa_id, phone, type: parsed.type,
    historyText: historyText.substring(0, 100),
    mediaSaved: !!mediaSaved,
  });

  // --- Process shared logic ---
  await processMessageCommon({
    empresa_id,
    phone,
    contactName,
    messageId,
    phoneNumberId,
    graphToken,
    historyText,
    parsed,
    parts,
    mediaSaved,
    mediaMimeType,
    mediaFileName,
    startTime,
    wnId,
    source: 'whatsapp_direct',
  });
}

/**
 * Process an incoming n8n message.
 * This is the heavy logic extracted from n8n.js webhook route.
 */
export async function processN8nMessage({ message, phone, name, phoneNumberId, empresa_id, agentId, metadata, n8nResponseUrl, webhookToken }) {
  const startTime = Date.now();

  // --- Resolve agent ---
  let agentQuery, agentParams;
  if (agentId) {
    agentQuery = `
      SELECT id as agente_id, nome as agente_nome, modelo, temperatura, max_tokens, prompt_ativo,
             cache_enabled, gemini_cache_id, cache_expires_at, mensagem_midia_nao_suportada
      FROM agentes WHERE id = $1 AND empresa_id = $2 AND ativo = true LIMIT 1
    `;
    agentParams = [agentId, empresa_id];
  } else {
    agentQuery = `
      SELECT id as agente_id, nome as agente_nome, modelo, temperatura, max_tokens, prompt_ativo,
             cache_enabled, gemini_cache_id, cache_expires_at, mensagem_midia_nao_suportada
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
    SELECT id, controlado_por, humano_nome, fila_id FROM conversas
    WHERE empresa_id = $1 AND contato_whatsapp = $2 AND status = 'ativo'
    ORDER BY criado_em DESC LIMIT 1
  `, [empresa_id, phone]);

  if (conversaResult.rows.length > 0) {
    conversa_id = conversaResult.rows[0].id;

    if (contato_id) {
      pool.query('UPDATE conversas SET contato_id = $1 WHERE id = $2 AND contato_id IS NULL', [contato_id, conversa_id]).catch(() => {});
    }

    // --- Check human control ---
    if (conversaResult.rows[0].controlado_por === 'humano') {
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

      pool.query(`UPDATE conversas SET humano_ultima_msg_em = NOW(), atualizado_em = NOW() WHERE id = $1`, [conversa_id]).catch(() => {});

      return {
        response: null,
        human_controlled: true,
        conversation_id: conversa_id,
        processing_time_ms: Date.now() - startTime,
      };
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
      INSERT INTO conversas (empresa_id, contato_whatsapp, contato_nome, contato_id, agente_id, agente_inicial_id, status, controlado_por, fila_id, dados_json, numero_ticket)
      VALUES ($1, $2, $3, $4, $5, $5, 'ativo', $6, $7, $8, $9)
      RETURNING id
    `, [
      empresa_id, phone, name || null, contato_id, agente_id,
      defaultFilaId ? 'fila' : 'ia',
      defaultFilaId,
      JSON.stringify({ name: name || null, source: 'n8n' }),
      numero_ticket
    ]);

    conversa_id = insertConversa.rows[0].id;

    if (defaultFilaId) {
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
  startTime, wnId, source,
}) {
  // --- Resolve default agent ---
  const agentResult = await pool.query(`
    SELECT id as agente_id, nome as agente_nome, modelo, temperatura, max_tokens, prompt_ativo,
           cache_enabled, gemini_cache_id, cache_expires_at, mensagem_midia_nao_suportada
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
  const conversaResult = await pool.query(`
    SELECT id, controlado_por, humano_nome, fila_id, agente_id as conversa_agente_id FROM conversas
    WHERE empresa_id = $1 AND contato_whatsapp = $2 AND status = 'ativo'
    ORDER BY criado_em DESC LIMIT 1
  `, [empresa_id, phone]);

  if (conversaResult.rows.length > 0) {
    conversa_id = conversaResult.rows[0].id;

    if (contato_id) {
      pool.query('UPDATE conversas SET contato_id = $1 WHERE id = $2 AND contato_id IS NULL', [contato_id, conversa_id]).catch(() => {});
    }

    // --- Check human control ---
    if (conversaResult.rows[0].controlado_por === 'humano') {
      createLogger.info('Message during human control, skipping AI', { empresa_id, phone, conversa_id });

      addToHistory(empresa_id, conversationKey, 'user', historyText).catch(() => {});

      const logMsgResult = await pool.query(`
        INSERT INTO mensagens_log (conversa_id, empresa_id, direcao, conteudo, remetente_tipo, tipo_mensagem, midia_url, midia_mime_type, midia_nome_arquivo, midia_tamanho_bytes, criado_em)
        VALUES ($1, $2, 'entrada', $3, 'cliente', $4, $5, $6, $7, $8, NOW())
        RETURNING id, criado_em
      `, [conversa_id, empresa_id, historyText, parsed.type,
          mediaSaved?.relativePath || null, mediaSaved ? mediaMimeType : null,
          mediaSaved ? (mediaFileName || null) : null, mediaSaved?.sizeBytes || null]);

      const fila_id = conversaResult.rows[0].fila_id;
      if (logMsgResult.rows[0]) {
        emitNovaMensagem(conversa_id, fila_id, {
          id: logMsgResult.rows[0].id,
          conversa_id,
          conteudo: historyText,
          direcao: 'entrada',
          remetente_tipo: 'cliente',
          tipo_mensagem: parsed.type,
          midia_url: mediaSaved?.relativePath || null,
          midia_mime_type: mediaSaved ? mediaMimeType : null,
          midia_nome_arquivo: mediaSaved ? (mediaFileName || null) : null,
          criado_em: logMsgResult.rows[0].criado_em,
        });
      }

      pool.query(`UPDATE conversas SET humano_ultima_msg_em = NOW(), atualizado_em = NOW() WHERE id = $1`, [conversa_id]).catch(() => {});
      return;
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
      INSERT INTO conversas (empresa_id, contato_whatsapp, contato_nome, contato_id, agente_id, agente_inicial_id, status, controlado_por, fila_id, dados_json, numero_ticket, whatsapp_number_id)
      VALUES ($1, $2, $3, $4, $5, $5, 'ativo', $6, $7, $8, $9, $10)
      RETURNING id
    `, [
      empresa_id, phone, contactName || null, contato_id, agente_id,
      defaultFilaId ? 'fila' : 'ia',
      defaultFilaId,
      JSON.stringify({ name: contactName || null, source }),
      numero_ticket,
      wnId
    ]);

    conversa_id = insertConversa.rows[0].id;

    if (defaultFilaId) {
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
        await pool.query(
          `INSERT INTO mensagens_log (conversa_id, empresa_id, direcao, conteudo, remetente_tipo, tipo_mensagem, midia_url, midia_mime_type, midia_nome_arquivo, midia_tamanho_bytes, criado_em)
           VALUES ($1, $2, 'entrada', $3, 'cliente', $4, $5, $6, $7, $8, NOW())`,
          [conversa_id, empresa_id, historyText, parsed.type,
           mediaSaved?.relativePath || null, mediaSaved ? mediaMimeType : null,
           mediaSaved ? (mediaFileName || null) : null, mediaSaved?.sizeBytes || null]
        );
        return;
      }

      calcularStatsFila(defaultFilaId).then(stats => emitFilaStats(defaultFilaId, stats)).catch(() => {});
    }
  }

  // --- Override agent if conversation already has one ---
  if (conversaResult.rows.length > 0 && conversaResult.rows[0].conversa_agente_id) {
    const conversaAgenteId = conversaResult.rows[0].conversa_agente_id;
    if (conversaAgenteId !== agente_id) {
      const overrideResult = await pool.query(`
        SELECT id as agente_id, nome as agente_nome, modelo, temperatura, max_tokens, prompt_ativo,
               cache_enabled, gemini_cache_id, cache_expires_at, mensagem_midia_nao_suportada
        FROM agentes WHERE id = $1 AND empresa_id = $2 AND ativo = true
      `, [conversaAgenteId, empresa_id]);

      if (overrideResult.rows.length > 0) {
        agent = overrideResult.rows[0];
        ({ agente_id, agente_nome, modelo, temperatura, max_tokens, prompt_ativo } = agent);
      }
    }
  }

  // --- Log incoming message ---
  const incomingMsgResult = await pool.query(`
    INSERT INTO mensagens_log (conversa_id, empresa_id, direcao, conteudo, remetente_tipo, tipo_mensagem, whatsapp_message_id, midia_url, midia_mime_type, midia_nome_arquivo, midia_tamanho_bytes, criado_em)
    VALUES ($1, $2, 'entrada', $3, 'cliente', $4, $5, $6, $7, $8, $9, NOW())
    RETURNING id, criado_em
  `, [conversa_id, empresa_id, historyText, parsed.type, messageId,
      mediaSaved?.relativePath || null, mediaSaved ? mediaMimeType : null,
      mediaSaved ? (mediaFileName || null) : null, mediaSaved?.sizeBytes || null]);

  // Emit WebSocket for incoming message
  if (incomingMsgResult.rows[0]) {
    const conversaForFila = await pool.query('SELECT fila_id FROM conversas WHERE id = $1', [conversa_id]);
    const currentFilaId = conversaForFila.rows[0]?.fila_id;
    emitNovaMensagem(conversa_id, currentFilaId, {
      id: incomingMsgResult.rows[0].id,
      conversa_id,
      conteudo: historyText,
      direcao: 'entrada',
      remetente_tipo: 'cliente',
      tipo_mensagem: parsed.type,
      midia_url: mediaSaved?.relativePath || null,
      midia_mime_type: mediaSaved ? mediaMimeType : null,
      midia_nome_arquivo: mediaSaved ? (mediaFileName || null) : null,
      criado_em: incomingMsgResult.rows[0].criado_em,
    });
  }

  // --- Reject non-text media if agent config says so ---
  if (agent.mensagem_midia_nao_suportada && parsed.type !== 'text') {
    const rejectMsg = agent.mensagem_midia_nao_suportada;
    const sendResult = await sendTextMessage(phoneNumberId, graphToken, phone, rejectMsg);

    if (sendResult.wamid) {
      const rejectLogResult = await pool.query(`
        INSERT INTO mensagens_log (conversa_id, empresa_id, direcao, conteudo, remetente_tipo, tipo_mensagem, whatsapp_message_id, criado_em)
        VALUES ($1, $2, 'saida', $3, 'ia', 'text', $4, NOW())
        RETURNING id, criado_em
      `, [conversa_id, empresa_id, rejectMsg, sendResult.wamid]);

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
    return;
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
      conversa_id, empresa_id, direcao, conteudo, remetente_tipo, tipo_mensagem,
      tokens_input, tokens_output, tools_invocadas_json,
      modelo_usado, api_key_usada_id, latencia_ms,
      whatsapp_message_id, status_entrega, criado_em
    ) VALUES ($1, $2, 'saida', $3, 'ia', 'text', $4, $5, $6, $7, $8, $9, $10, $11, NOW())
    RETURNING id, criado_em
  `, [
    conversa_id, empresa_id, result.text,
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
async function processAIResponse({
  empresa_id, conversa_id, contato_id, agente_id, agent,
  availableKeys, conversationKey, messageText, parts, startTime,
}) {
  const { modelo, temperatura, max_tokens, prompt_ativo } = agent;

  // --- Daily limit check ---
  await pool.query(`
    INSERT INTO uso_diario_agente (empresa_id, agente_id, data, total_atendimentos, limite_diario)
    SELECT $1, $2, CURRENT_DATE, 0, COALESCE(
      (SELECT max_mensagens_mes / 30 FROM empresa_limits WHERE empresa_id = $1), 500
    )
    ON CONFLICT (empresa_id, agente_id, data) DO NOTHING
  `, [empresa_id, agente_id]);

  const usageResult = await pool.query(`
    SELECT total_atendimentos, limite_diario, limite_atingido
    FROM uso_diario_agente
    WHERE empresa_id = $1 AND agente_id = $2 AND data = CURRENT_DATE
  `, [empresa_id, agente_id]);

  if (usageResult.rows.length > 0) {
    const usage = usageResult.rows[0];
    if (usage.limite_atingido || usage.total_atendimentos >= usage.limite_diario) {
      createLogger.warn('Daily limit reached', { empresa_id, agente_id });
      return null;
    }
  }

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
      resultado: result?.data || result?.error,
      sucesso: result?.success ?? false,
      erro: result?.success ? null : (result?.error || result?.message),
      tempo_ms: result?.duration_ms,
    });

    return transformResultForLLM(result, 2000);
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
          history: formatHistoryForGemini(history),
          message: messageText,
          parts,
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
      if (currentKey.id) recordKeyError(currentKey.id, error.message || 'Unknown error').catch(() => {});

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
          INSERT INTO controle_historico (empresa_id, conversa_id, acao, motivo)
          VALUES ($1, $2, 'transferencia_agente', $3)
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
        conversa_id, empresa_id, direcao, conteudo, remetente_tipo, tipo_mensagem,
        tokens_input, tokens_output, modelo_usado, api_key_usada_id, latencia_ms,
        whatsapp_message_id, status_entrega, criado_em
      ) VALUES ($1, $2, 'saida', $3, 'ia', 'text', $4, $5, $6, $7, $8, $9, $10, NOW())
      RETURNING id, criado_em
    `, [
      conversa_id, empresa_id, result.text,
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
