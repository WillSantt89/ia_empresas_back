import crypto from 'crypto';
import { logger } from '../../config/logger.js';
import { pool } from '../../config/database.js';
import { decrypt } from '../../config/encryption.js';
import { getActiveKeysForAgent, recordKeyError, recordKeySuccess } from '../../services/api-key-manager.js';
import { getHistory, addToHistory, addToolCallToHistory, formatHistoryForGemini } from '../../services/memory.js';
import { processMessageWithTools, buildToolDeclarations } from '../../services/gemini.js';
import { executeTool, transformResultForLLM } from '../../services/tool-runner.js';
import { parseMetaMessage, buildGeminiParts } from '../../services/media-handler.js';
import { saveMedia } from '../../services/media-storage.js';
import { sendTextMessage, markAsRead } from '../../services/whatsapp-sender.js';
import { atribuirConversaAutomatica, calcularStatsFila } from '../../services/fila-manager.js';
import { emitNovaMensagem, emitNovaConversaNaFila, emitFilaStats, emitStatusEntrega } from '../../services/websocket.js';

const createLogger = logger.child({ module: 'whatsapp-webhook' });

const whatsappWebhookRoutes = async (fastify) => {

  /**
   * GET /api/webhooks/whatsapp
   * Meta webhook verification (challenge-response)
   */
  fastify.get('/', async (request, reply) => {
    const mode = request.query['hub.mode'];
    const token = request.query['hub.verify_token'];
    const challenge = request.query['hub.challenge'];

    const verifyToken = process.env.WHATSAPP_VERIFY_TOKEN;

    if (!verifyToken) {
      createLogger.error('WHATSAPP_VERIFY_TOKEN not configured');
      return reply.code(500).send('Server not configured for webhook verification');
    }

    if (mode === 'subscribe' && token === verifyToken) {
      createLogger.info('Meta webhook verified successfully');
      return reply.code(200).send(challenge);
    }

    createLogger.warn('Meta webhook verification failed', { mode, tokenMatch: token === verifyToken });
    return reply.code(403).send('Verification failed');
  });

  /**
   * POST /api/webhooks/whatsapp
   * Receive messages directly from Meta WhatsApp Cloud API
   *
   * Multi-tenant: identifies company by phone_number_id via whatsapp_numbers table
   */
  fastify.post('/', {
    config: { rawBody: true },
  }, async (request, reply) => {
    const startTime = Date.now();

    // Always return 200 immediately to Meta (avoid re-delivery)
    // We process async but still within the request lifecycle
    try {
      const body = request.body;

      if (!body?.entry?.[0]?.changes?.[0]?.value) {
        return reply.code(200).send('OK');
      }

      const value = body.entry[0].changes[0].value;
      const metadata = value.metadata || {};
      const phoneNumberId = metadata.phone_number_id;

      if (!phoneNumberId) {
        createLogger.warn('No phone_number_id in Meta payload');
        return reply.code(200).send('OK');
      }

      // --- Lookup company by phone_number_id ---
      const wnResult = await pool.query(
        `SELECT wn.id as wn_id, wn.empresa_id, wn.token_graph_api, wn.whatsapp_app_secret, e.nome as empresa_nome, e.n8n_response_url
         FROM whatsapp_numbers wn
         JOIN empresas e ON e.id = wn.empresa_id AND e.ativo = true
         WHERE wn.phone_number_id = $1 AND wn.ativo = true
         LIMIT 1`,
        [phoneNumberId]
      );

      if (wnResult.rows.length === 0) {
        createLogger.warn('No active company found for phone_number_id', { phoneNumberId });
        return reply.code(200).send('OK');
      }

      const whatsappNumber = wnResult.rows[0];
      const empresa_id = whatsappNumber.empresa_id;

      // --- HMAC signature validation (if app_secret is configured) ---
      if (whatsappNumber.whatsapp_app_secret) {
        const appSecret = decrypt(whatsappNumber.whatsapp_app_secret);
        const signature = request.headers['x-hub-signature-256'];

        if (appSecret && signature) {
          const rawBody = request.raw.rawBody || JSON.stringify(request.body);
          const expectedSig = crypto.createHmac('sha256', appSecret).update(rawBody).digest('hex');
          const receivedSig = signature.replace('sha256=', '');

          if (expectedSig !== receivedSig) {
            createLogger.warn('Invalid HMAC signature', { phoneNumberId, empresa_id });
            return reply.code(401).send('Invalid signature');
          }
        }
      }

      const graphToken = decrypt(whatsappNumber.token_graph_api);
      if (!graphToken) {
        createLogger.error('No valid Graph API token', { phoneNumberId, empresa_id });
        return reply.code(200).send('OK');
      }

      // --- Handle status updates (delivered, read, etc.) ---
      if (value.statuses && value.statuses.length > 0) {
        handleStatusUpdates(value.statuses, empresa_id).catch(err => {
          createLogger.error('Failed to handle status updates', { error: err.message });
        });
        return reply.code(200).send('OK');
      }

      // --- Handle messages ---
      const messages = value.messages;
      if (!messages || messages.length === 0) {
        return reply.code(200).send('OK');
      }

      const contacts = value.contacts || [];

      // Process each message (usually just one)
      for (const message of messages) {
        try {
          await processIncomingMessage({
            message,
            contacts,
            phoneNumberId,
            graphToken,
            empresa_id,
            startTime,
            wnId: whatsappNumber.wn_id,
          });
        } catch (err) {
          createLogger.error('Failed to process incoming message', {
            error: err.message,
            empresa_id,
            messageType: message.type,
          });
        }
      }

      return reply.code(200).send('OK');

    } catch (error) {
      createLogger.error('WhatsApp webhook error', { error: error.message, stack: error.stack });
      // Still return 200 to prevent Meta from retrying
      return reply.code(200).send('OK');
    }
  });

  /**
   * Process a single incoming WhatsApp message
   * Reuses the same logic as n8n.js webhook
   */
  async function processIncomingMessage({ message, contacts, phoneNumberId, graphToken, empresa_id, startTime, wnId }) {
    const phone = message.from;
    const contactName = contacts[0]?.profile?.name || null;
    const messageId = message.id;

    // Mark as read (non-blocking)
    markAsRead(phoneNumberId, graphToken, messageId).catch(() => {});

    // --- Parse message (text, image, audio, etc.) ---
    const parsed = parseMetaMessage(message);

    if (parsed.type === 'unknown' && !parsed.text) {
      createLogger.debug('Ignoring unknown message type', { type: message.type, phone });
      return;
    }

    // Skip reactions (don't process with AI)
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

    createLogger.info('WhatsApp message received', {
      empresa_id, phone, type: parsed.type,
      historyText: historyText.substring(0, 100),
      mediaSaved: !!mediaSaved,
    });

    // --- Resolve agent ---
    const agentResult = await pool.query(`
      SELECT id as agente_id, nome as agente_nome, modelo, temperatura, max_tokens, prompt_ativo,
             cache_enabled, gemini_cache_id, cache_expires_at, mensagem_midia_nao_suportada
      FROM agentes
      WHERE empresa_id = $1 AND ativo = true
      ORDER BY criado_em ASC
      LIMIT 1
    `, [empresa_id]);

    if (agentResult.rows.length === 0) {
      createLogger.warn('No active agent for company', { empresa_id });
      return;
    }

    const agent = agentResult.rows[0];
    const { agente_id, agente_nome, modelo, temperatura, max_tokens, prompt_ativo } = agent;

    // --- Get API keys with failover ---
    const availableKeys = await getActiveKeysForAgent(empresa_id, agente_id);
    if (availableKeys.length === 0) {
      createLogger.warn('No API keys for agent', { empresa_id, agente_id });
      return;
    }

    // --- Conversation key ---
    const conversationKey = `whatsapp:${phone}`;

    // --- Find or create contato ---
    let contato_id = null;
    try {
      const contatoResult = await pool.query(`
        INSERT INTO contatos (empresa_id, whatsapp, nome)
        VALUES ($1, $2, $3)
        ON CONFLICT (empresa_id, whatsapp) DO UPDATE SET
          nome = COALESCE(NULLIF($3, ''), contatos.nome),
          atualizado_em = NOW()
        RETURNING id
      `, [empresa_id, phone, contactName || null]);
      contato_id = contatoResult.rows[0].id;
    } catch (err) {
      createLogger.error('Failed to upsert contato', { error: err.message });
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
      const controlador = conversaResult.rows[0].controlado_por;
      if (controlador === 'humano') {
        createLogger.info('Message during human control, skipping AI', { empresa_id, phone, conversa_id });

        addToHistory(empresa_id, conversationKey, 'user', historyText).catch(err => {
          createLogger.error('Failed to save msg during human control', { error: err.message });
        });

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
        `SELECT id FROM filas_atendimento WHERE empresa_id = $1 AND is_default = true AND ativo = true LIMIT 1`,
        [empresa_id]
      );
      const defaultFilaId = filaResult.rows[0]?.id || null;

      // Gerar número de ticket sequencial
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
        JSON.stringify({ name: contactName || null, source: 'whatsapp_direct' }),
        numero_ticket,
        wnId
      ]);

      conversa_id = insertConversa.rows[0].id;

      if (defaultFilaId) {
        createLogger.info('New conversation routed to fila', { conversa_id, fila_id: defaultFilaId });

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

        const operador = await atribuirConversaAutomatica(conversa_id, defaultFilaId).catch(err => {
          createLogger.error('Auto-assignment failed', { error: err.message });
          return null;
        });

        if (operador) {
          createLogger.info('Conversation auto-assigned', { conversa_id, operador: operador.nome });
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

        calcularStatsFila(defaultFilaId).then(stats => {
          emitFilaStats(defaultFilaId, stats);
        }).catch(() => {});
      }
    }

    // --- Daily limit check ---
    await pool.query(`
      INSERT INTO uso_diario_agente (empresa_id, agente_id, data, total_atendimentos, limite_diario)
      SELECT $1, $2, CURRENT_DATE, 0, COALESCE(
        (SELECT max_mensagens_mes / 30 FROM empresa_limits WHERE empresa_id = $1),
        500
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
        const limitMsgResult = await pool.query(
          'SELECT mensagem_limite_atingido FROM agentes WHERE id = $1', [agente_id]
        );
        const limitMessage = limitMsgResult.rows[0]?.mensagem_limite_atingido
          || 'Desculpe, nosso limite de atendimentos foi atingido. Tente novamente amanhã.';

        // Send limit message directly
        const sendResult = await sendTextMessage(phoneNumberId, graphToken, phone, limitMessage);
        if (sendResult.wamid) {
          await pool.query(`
            INSERT INTO mensagens_log (conversa_id, empresa_id, direcao, conteudo, remetente_tipo, tipo_mensagem, whatsapp_message_id, criado_em)
            VALUES ($1, $2, 'saida', $3, 'ia', 'text', $4, NOW())
          `, [conversa_id, empresa_id, limitMessage, sendResult.wamid]);
        }
        return;
      }
    }

    // --- Get agent tools ---
    const toolsResult = await pool.query(`
      SELECT t.id, t.nome, t.descricao_para_llm, t.url, t.metodo,
             t.headers_json, t.body_template_json, t.parametros_schema_json, t.timeout_ms
      FROM tools t
      INNER JOIN agente_tools at2 ON t.id = at2.tool_id
      WHERE at2.agente_id = $1 AND t.ativo = true
      ORDER BY at2.ordem_prioridade ASC
    `, [agente_id]);

    const tools = toolsResult.rows;

    // --- Redis history ---
    const history = await getHistory(empresa_id, conversationKey);

    // --- Add user message to Redis (descriptive text, no base64) ---
    await addToHistory(empresa_id, conversationKey, 'user', historyText);

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

    // --- Reject non-text media if agent has mensagem_midia_nao_suportada configured ---
    // (runs AFTER incoming message is saved + emitted, so operators see the media in chat)
    if (agent.mensagem_midia_nao_suportada && parsed.type !== 'text') {
      createLogger.info('Non-text message rejected by agent config', {
        empresa_id, phone, type: parsed.type, agente_id,
      });

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

    // --- Process with Gemini (failover) ---
    const toolDeclarations = buildToolDeclarations(tools);

    const toolExecutor = async (tool, args) => {
      const toolConfig = tools.find(t => t.nome.toLowerCase() === tool.nome.toLowerCase());
      if (!toolConfig) throw new Error(`Tool ${tool.nome} not found`);
      const result = await executeTool(toolConfig, args);
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
            message: historyText,
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

        createLogger.warn('API key failed', {
          empresa_id, agente_id, key_index: keyIndex,
          error_code: error.code,
        });

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

    // --- Send response via Meta directly ---
    const sendResult = await sendTextMessage(phoneNumberId, graphToken, phone, result.text);

    // --- Log outgoing message with wamid ---
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
      modelo, usedKeyId, processingTime,
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

    // --- Increment daily usage ---
    pool.query(`
      UPDATE uso_diario_agente
      SET total_atendimentos = total_atendimentos + 1,
          limite_atingido = CASE WHEN total_atendimentos + 1 >= limite_diario THEN true ELSE false END,
          atualizado_em = CURRENT_TIMESTAMP
      WHERE empresa_id = $1 AND agente_id = $2 AND data = CURRENT_DATE
    `, [empresa_id, agente_id]).catch(err => {
      createLogger.error('Failed to increment daily usage', { error: err.message });
    });

    // --- Log analytics ---
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
      processingTime, modelo, true,
    ]).catch(err => {
      createLogger.error('Failed to log analytics', { error: err.message });
    });

    // --- Transfer check ---
    try {
      const transferRules = await pool.query(`
        SELECT at2.*, a_dest.nome as agente_destino_nome
        FROM agente_transferencias at2
        JOIN agentes a_dest ON a_dest.id = at2.agente_destino_id AND a_dest.ativo = true
        WHERE at2.agente_origem_id = $1 AND at2.ativo = true
        ORDER BY at2.criado_em ASC
      `, [agente_id]);

      if (transferRules.rows.length > 0) {
        for (const rule of transferRules.rows) {
          let shouldTransfer = false;

          if (rule.trigger_tipo === 'keyword') {
            const textToCheck = (historyText + ' ' + result.text).toLowerCase();
            shouldTransfer = textToCheck.includes(String(rule.trigger_valor).toLowerCase());
          } else if (rule.trigger_tipo === 'tool_result') {
            shouldTransfer = result.toolsCalled.some(tc =>
              tc.name === rule.trigger_valor ||
              (tc.result && JSON.stringify(tc.result).includes(String(rule.trigger_valor)))
            );
          } else if (rule.trigger_tipo === 'menu_opcao') {
            shouldTransfer = historyText.trim().toLowerCase() === String(rule.trigger_valor).toLowerCase();
          }

          if (shouldTransfer) {
            createLogger.info('Transfer triggered', {
              empresa_id, from_agent: agente_id, to_agent: rule.agente_destino_id,
              trigger: rule.trigger_tipo, phone,
            });

            await pool.query(`UPDATE conversas SET agente_id = $1, atualizado_em = CURRENT_TIMESTAMP WHERE id = $2`,
              [rule.agente_destino_id, conversa_id]);

            pool.query(`
              INSERT INTO controle_historico (empresa_id, conversa_id, acao, motivo)
              VALUES ($1, $2, 'transferencia_agente', $3)
            `, [empresa_id, conversa_id, rule.trigger_tipo + ':' + rule.trigger_valor])
              .catch(err => createLogger.error('Failed to log transfer', { error: err.message }));

            break;
          }
        }
      }
    } catch (transferError) {
      createLogger.error('Transfer check failed (non-blocking)', { error: transferError.message });
    }

    createLogger.info('WhatsApp message processed', {
      empresa_id, agente_id, phone, type: parsed.type,
      processing_time_ms: processingTime,
      tokens_total: result.tokensInput + result.tokensOutput,
      tools_called: result.toolsCalled.length,
      wamid: sendResult.wamid,
    });
  }

  /**
   * Handle status updates from Meta (delivered, read, failed)
   * Updates status_entrega in mensagens_log
   */
  async function handleStatusUpdates(statuses, empresa_id) {
    for (const status of statuses) {
      const wamid = status.id;
      const statusValue = status.status; // sent, delivered, read, failed

      if (!wamid || !statusValue) continue;

      // Map Meta status to our status_entrega values
      const statusMap = {
        'sent': 'sent',
        'delivered': 'delivered',
        'read': 'read',
        'failed': 'failed',
      };

      const mappedStatus = statusMap[statusValue];
      if (!mappedStatus) continue;

      try {
        const result = await pool.query(`
          UPDATE mensagens_log SET status_entrega = $1
          WHERE whatsapp_message_id = $2 AND empresa_id = $3
          RETURNING id, conversa_id
        `, [mappedStatus, wamid, empresa_id]);

        if (result.rows.length > 0) {
          createLogger.debug('Status updated', { wamid, status: mappedStatus });

          // Emit WebSocket status update
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
};

export default whatsappWebhookRoutes;
