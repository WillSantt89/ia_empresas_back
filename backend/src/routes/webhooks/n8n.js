import { logger } from '../../config/logger.js';
import { pool } from '../../config/database.js';
import { getActiveKeysForAgent, recordKeyError, recordKeySuccess } from '../../services/api-key-manager.js';
import { getHistory, addToHistory, addToolCallToHistory, formatHistoryForGemini, syncChatwootHistory, archiveConversation } from '../../services/memory.js';
import { processMessageWithTools, buildToolDeclarations } from '../../services/gemini.js';
import { executeTool, transformResultForLLM } from '../../services/tool-runner.js';
import { sendMessage as chatwootSendMessage, getConversationMessages, unassignAgent } from '../../services/chatwoot.js';

const createLogger = logger.child({ module: 'n8n-webhook' });

const n8nWebhookRoutes = async (fastify) => {
  /**
   * POST /api/webhooks/n8n
   * Gateway endpoint for n8n → AI processing → synchronous response
   *
   * Authentication: x-webhook-token header validated against empresas.webhook_token
   */
  fastify.post('/', {
    schema: {
      body: {
        type: 'object',
        properties: {
          message: { type: 'string', minLength: 1, maxLength: 4000 },
          phone: { type: 'string', minLength: 1, maxLength: 30 },
          name: { type: 'string', maxLength: 255 },
          phone_number_id: { type: 'string', maxLength: 50 },
          agent_id: { type: 'string', format: 'uuid' },
          metadata: { type: 'object' }
        },
        required: ['message', 'phone']
      }
    }
  }, async (request, reply) => {
    const startTime = Date.now();
    const { message, phone, name, phone_number_id, agent_id: requestAgentId, metadata } = request.body;
    const webhookToken = request.headers['x-webhook-token'];

    // --- 1. Authenticate via webhook_token ---
    if (!webhookToken) {
      return reply.code(401).send({
        success: false,
        error: {
          code: 'MISSING_TOKEN',
          message: 'Header x-webhook-token is required'
        }
      });
    }

    let empresa;
    try {
      const empresaResult = await pool.query(
        'SELECT id, nome, n8n_response_url FROM empresas WHERE webhook_token = $1 AND ativo = true LIMIT 1',
        [webhookToken]
      );

      if (empresaResult.rows.length === 0) {
        return reply.code(401).send({
          success: false,
          error: {
            code: 'INVALID_TOKEN',
            message: 'Invalid or inactive webhook token'
          }
        });
      }

      empresa = empresaResult.rows[0];
    } catch (err) {
      createLogger.error('Token lookup failed', { error: err.message });
      return reply.code(500).send({
        success: false,
        error: { code: 'DB_ERROR', message: 'Failed to validate token' }
      });
    }

    const empresa_id = empresa.id;

    createLogger.info('n8n webhook received', {
      empresa_id,
      phone,
      name,
      message_length: message.length
    });

    try {
      // --- 2. Resolve agent ---
      let agentQuery;
      let agentParams;

      if (requestAgentId) {
        agentQuery = `
          SELECT id as agente_id, nome as agente_nome, modelo, temperatura, max_tokens, prompt_ativo,
                 cache_enabled, gemini_cache_id, cache_expires_at
          FROM agentes
          WHERE id = $1 AND empresa_id = $2 AND ativo = true
          LIMIT 1
        `;
        agentParams = [requestAgentId, empresa_id];
      } else {
        agentQuery = `
          SELECT id as agente_id, nome as agente_nome, modelo, temperatura, max_tokens, prompt_ativo,
                 cache_enabled, gemini_cache_id, cache_expires_at
          FROM agentes
          WHERE empresa_id = $1 AND ativo = true
          ORDER BY criado_em ASC
          LIMIT 1
        `;
        agentParams = [empresa_id];
      }

      const agentResult = await pool.query(agentQuery, agentParams);

      if (agentResult.rows.length === 0) {
        return reply.code(404).send({
          success: false,
          error: {
            code: 'AGENT_NOT_FOUND',
            message: requestAgentId
              ? 'Specified agent not found or inactive'
              : 'No active agent found for this company'
          }
        });
      }

      const agent = agentResult.rows[0];
      const { agente_id, agente_nome, modelo, temperatura, max_tokens, prompt_ativo } = agent;

      // --- 3. Get API keys with failover ---
      const availableKeys = await getActiveKeysForAgent(empresa_id, agente_id);

      if (availableKeys.length === 0) {
        return reply.code(400).send({
          success: false,
          error: {
            code: 'NO_API_KEYS',
            message: 'No active API keys configured for this agent'
          }
        });
      }

      // --- 4. Generate consistent conversation_id ---
      const conversationKey = `whatsapp:${phone}`;

      // --- 5. Find or create conversa record ---
      let conversa_id;

      const conversaResult = await pool.query(`
        SELECT id, controlado_por, humano_nome FROM conversas
        WHERE empresa_id = $1 AND contato_whatsapp = $2 AND status = 'ativo'
        ORDER BY criado_em DESC
        LIMIT 1
      `, [empresa_id, phone]);

      if (conversaResult.rows.length > 0) {
        conversa_id = conversaResult.rows[0].id;

        // --- Check human control ---
        if (conversaResult.rows[0].controlado_por === 'humano') {
          createLogger.info('Message received during human control, skipping AI', {
            empresa_id, phone, conversa_id,
            humano_nome: conversaResult.rows[0].humano_nome
          });

          // Save client message to Redis (preserves context for when IA resumes)
          addToHistory(empresa_id, conversationKey, 'user', message).catch(err => {
            createLogger.error('Failed to save message during human control', { error: err.message });
          });

          // Log to mensagens_log for audit
          pool.query(`
            INSERT INTO mensagens_log (conversa_id, empresa_id, direcao, conteudo, criado_em)
            VALUES ($1, $2, 'entrada', $3, NOW())
          `, [conversa_id, empresa_id, message]).catch(err => {
            createLogger.error('Failed to log message during human control', { error: err.message });
          });

          // Update humano_ultima_msg_em to prevent premature timeout
          pool.query(`
            UPDATE conversas SET humano_ultima_msg_em = NOW(), atualizado_em = NOW()
            WHERE id = $1
          `, [conversa_id]).catch(err => {
            createLogger.error('Failed to update humano_ultima_msg_em', { error: err.message });
          });

          return {
            success: true,
            data: {
              response: null,
              human_controlled: true,
              conversation_id: conversa_id,
              agent_name: null,
              tools_called: [],
              tokens_used: { input: 0, output: 0 },
              processing_time_ms: Date.now() - startTime
            }
          };
        }
      } else {
        const insertConversa = await pool.query(`
          INSERT INTO conversas (empresa_id, contato_whatsapp, agente_id, agente_inicial_id, status, dados_json)
          VALUES ($1, $2, $3, $3, 'ativo', $4)
          RETURNING id
        `, [empresa_id, phone, agente_id, JSON.stringify({ name: name || null, source: 'n8n' })]);

        conversa_id = insertConversa.rows[0].id;
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
            'SELECT mensagem_limite_atingido FROM agentes WHERE id = $1',
            [agente_id]
          );
          const limitMessage = limitMsgResult.rows[0]?.mensagem_limite_atingido
            || 'Desculpe, nosso limite de atendimentos foi atingido. Tente novamente amanhã.';

          return {
            success: true,
            data: {
              response: limitMessage,
              conversation_id: conversa_id,
              agent_name: agente_nome,
              tools_called: [],
              tokens_used: { input: 0, output: 0 },
              processing_time_ms: Date.now() - startTime,
              limit_reached: true
            }
          };
        }
      }

      // --- 6. Get agent tools ---
      const toolsResult = await pool.query(`
        SELECT
          t.id, t.nome, t.descricao_para_llm, t.url, t.metodo,
          t.headers_json, t.body_template_json, t.parametros_schema_json, t.timeout_ms
        FROM tools t
        INNER JOIN agente_tools at2 ON t.id = at2.tool_id
        WHERE at2.agente_id = $1 AND t.ativo = true
        ORDER BY at2.ordem_prioridade ASC
      `, [agente_id]);

      const tools = toolsResult.rows;

      // --- 7. Get Redis history ---
      const history = await getHistory(empresa_id, conversationKey);

      // --- 8. Add user message to Redis ---
      await addToHistory(empresa_id, conversationKey, 'user', message);

      // --- 9. Log incoming message to mensagens_log ---
      pool.query(`
        INSERT INTO mensagens_log (conversa_id, empresa_id, direcao, conteudo, criado_em)
        VALUES ($1, $2, 'entrada', $3, NOW())
      `, [conversa_id, empresa_id, message]).catch(err => {
        createLogger.error('Failed to log incoming message', { error: err.message });
      });

      // --- 10. Process with Gemini (failover) ---
      const toolDeclarations = buildToolDeclarations(tools);

      const toolExecutor = async (tool, args) => {
        const toolConfig = tools.find(t => t.nome.toLowerCase() === tool.nome.toLowerCase());
        if (!toolConfig) {
          throw new Error(`Tool ${tool.nome} not found`);
        }
        const result = await executeTool(toolConfig, args);
        return transformResultForLLM(result, 2000);
      };

      // Check if agent has active, non-expired cache
      let cachedContentName = null;
      if (agent.cache_enabled && agent.gemini_cache_id && agent.cache_expires_at) {
        if (new Date(agent.cache_expires_at) > new Date()) {
          cachedContentName = agent.gemini_cache_id;
          createLogger.debug('Using context cache for agent', { agente_id, cacheName: cachedContentName });
        } else {
          createLogger.warn('Agent cache expired, using normal flow', { agente_id, expired_at: agent.cache_expires_at });
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
              message,
              temperature: temperatura,
              maxTokens: max_tokens,
              cachedContentName
            },
            toolExecutor
          );

          if (currentKey.id) {
            recordKeySuccess(currentKey.id).catch(() => {});
          }

          if (keyIndex > 0) {
            createLogger.info('Failover successful', {
              empresa_id, agente_id,
              failed_keys: keyIndex,
              successful_key_index: keyIndex
            });
          }

          break;
        } catch (error) {
          const isRetryable = error.code === 'RATE_LIMITED' || error.code === 'INVALID_KEY' || error.code === 'API_ERROR';

          if (currentKey.id) {
            recordKeyError(currentKey.id, error.message || error.code || 'Unknown error').catch(() => {});
          }

          createLogger.warn('API key failed, attempting failover', {
            empresa_id, agente_id,
            key_index: keyIndex,
            total_keys: availableKeys.length,
            error_code: error.code,
            will_retry: isRetryable && keyIndex < availableKeys.length - 1
          });

          if (!isRetryable || keyIndex >= availableKeys.length - 1) {
            throw error;
          }
        }
      }

      if (!result) {
        throw new Error('All API keys failed');
      }

      // --- 11. Save response to Redis ---
      await addToHistory(empresa_id, conversationKey, 'model', result.text);

      for (const toolCall of result.toolsCalled) {
        await addToolCallToHistory(
          empresa_id,
          conversationKey,
          { name: toolCall.name, args: toolCall.args },
          toolCall.result
        );
      }

      const processingTime = Date.now() - startTime;

      // --- 12. Log response to mensagens_log ---
      pool.query(`
        INSERT INTO mensagens_log (
          conversa_id, empresa_id, direcao, conteudo,
          tokens_input, tokens_output, tools_invocadas_json,
          modelo_usado, api_key_usada_id, latencia_ms, criado_em
        ) VALUES ($1, $2, 'saida', $3, $4, $5, $6, $7, $8, $9, NOW())
      `, [
        conversa_id, empresa_id, result.text,
        result.tokensInput, result.tokensOutput,
        result.toolsCalled.length > 0 ? JSON.stringify(result.toolsCalled.map(tc => tc.name)) : null,
        modelo, usedKeyId, processingTime
      ]).catch(err => {
        createLogger.error('Failed to log outgoing message', { error: err.message });
      });

      // --- 13. Increment daily usage ---
      pool.query(`
        UPDATE uso_diario_agente
        SET total_atendimentos = total_atendimentos + 1,
            limite_atingido = CASE
              WHEN total_atendimentos + 1 >= limite_diario THEN true
              ELSE false
            END,
            atualizado_em = CURRENT_TIMESTAMP
        WHERE empresa_id = $1 AND agente_id = $2 AND data = CURRENT_DATE
      `, [empresa_id, agente_id]).catch(err => {
        createLogger.error('Failed to increment daily usage', { error: err.message });
      });

      // --- 14. Log analytics ---
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
        processingTime, modelo, true
      ]).catch(err => {
        createLogger.error('Failed to log analytics', { error: err.message });
      });

      // --- 15. Transfer check ---
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
              const textToCheck = (message + ' ' + result.text).toLowerCase();
              shouldTransfer = textToCheck.includes(String(rule.trigger_valor).toLowerCase());
            } else if (rule.trigger_tipo === 'tool_result') {
              shouldTransfer = result.toolsCalled.some(tc =>
                tc.name === rule.trigger_valor ||
                (tc.result && JSON.stringify(tc.result).includes(String(rule.trigger_valor)))
              );
            } else if (rule.trigger_tipo === 'menu_opcao') {
              shouldTransfer = message.trim().toLowerCase() === String(rule.trigger_valor).toLowerCase();
            }

            if (shouldTransfer) {
              createLogger.info('Transfer triggered (n8n)', {
                empresa_id,
                from_agent: agente_id,
                to_agent: rule.agente_destino_id,
                trigger: rule.trigger_tipo,
                phone
              });

              await pool.query(`
                UPDATE conversas
                SET agente_id = $1, atualizado_em = CURRENT_TIMESTAMP
                WHERE id = $2
              `, [rule.agente_destino_id, conversa_id]);

              pool.query(`
                INSERT INTO controle_historico (empresa_id, conversa_id, acao, motivo)
                VALUES ($1, $2, 'transferencia_agente', $3)
              `, [empresa_id, conversa_id, rule.trigger_tipo + ':' + rule.trigger_valor])
                .catch(err => createLogger.error('Failed to log transfer history', { error: err.message }));

              break;
            }
          }
        }
      } catch (transferError) {
        createLogger.error('Transfer check failed (non-blocking)', {
          error: transferError.message, empresa_id, agente_id
        });
      }

      // --- 16. Send response to n8n Flow 2 (async, non-blocking) ---
      if (empresa.n8n_response_url && phone_number_id) {
        let whatsappToken = null;
        try {
          const wnResult = await pool.query(
            'SELECT token_graph_api FROM whatsapp_numbers WHERE phone_number_id = $1 AND empresa_id = $2 AND ativo = true LIMIT 1',
            [phone_number_id, empresa_id]
          );
          if (wnResult.rows.length > 0 && wnResult.rows[0].token_graph_api) {
            whatsappToken = await fastify.decrypt(wnResult.rows[0].token_graph_api);
          }
        } catch (err) {
          createLogger.error('Failed to get WhatsApp token for Flow 2', { error: err.message, phone_number_id });
        }

        const flow2Payload = {
          phone,
          message: result.text,
          phone_number_id,
          token: whatsappToken,
          webhook_token: webhookToken
        };

        fetch(empresa.n8n_response_url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(flow2Payload),
          signal: AbortSignal.timeout(10000)
        }).then(res => {
          createLogger.info('Flow 2 response sent', { status: res.status, phone, phone_number_id });
        }).catch(err => {
          createLogger.error('Failed to send to Flow 2', { error: err.message, url: empresa.n8n_response_url, phone });
        });
      }

      // --- Return synchronous response to n8n ---
      createLogger.info('n8n webhook processed', {
        empresa_id, agente_id, phone,
        processing_time_ms: processingTime,
        tokens_total: result.tokensInput + result.tokensOutput,
        tools_called: result.toolsCalled.length
      });

      return {
        success: true,
        data: {
          response: result.text,
          conversation_id: conversa_id,
          agent_name: agente_nome,
          tools_called: result.toolsCalled.map(tc => tc.name),
          tokens_used: {
            input: result.tokensInput,
            output: result.tokensOutput
          },
          processing_time_ms: processingTime
        }
      };

    } catch (error) {
      const processingTime = Date.now() - startTime;

      createLogger.error('n8n webhook processing failed', {
        empresa_id,
        phone,
        error: error.message,
        code: error.code,
        processing_time_ms: processingTime
      });

      // Log failed analytics
      pool.query(`
        INSERT INTO conversacao_analytics (
          empresa_id, conversation_id,
          tokens_input, tokens_output, iteracoes,
          tools_chamadas, tempo_processamento_ms, modelo, sucesso, erro
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      `, [
        empresa_id, `whatsapp:${phone}`,
        error.partialResult?.tokensInput || 0,
        error.partialResult?.tokensOutput || 0,
        error.partialResult?.iteracoes || 0,
        error.partialResult?.toolsCalled?.length || 0,
        processingTime, null, false, error.message
      ]).catch(() => {});

      if (error.code === 'RATE_LIMITED') {
        return reply.code(429).send({
          success: false,
          error: {
            code: 'RATE_LIMITED',
            message: 'AI API rate limit exceeded. Please try again later.'
          }
        });
      }

      if (error.code === 'INVALID_KEY') {
        return reply.code(500).send({
          success: false,
          error: {
            code: 'INVALID_GEMINI_KEY',
            message: 'Invalid Gemini API key configured for this agent'
          }
        });
      }

      if (error.code === 'TIMEOUT') {
        return reply.code(504).send({
          success: false,
          error: {
            code: 'TIMEOUT',
            message: 'Request timeout. Please try again with a shorter message.'
          }
        });
      }

      return reply.code(500).send({
        success: false,
        error: {
          code: 'PROCESSING_ERROR',
          message: 'Failed to process message. Please try again.'
        }
      });
    }
  });

  /**
   * POST /api/webhooks/n8n/confirmar-envio
   * Endpoint for n8n Flow 2 to confirm WhatsApp message was sent successfully
   * Saves the whatsapp_message_id (wamid) in mensagens_log
   *
   * Authentication: webhook_token in body (sent by backend to Flow 2)
   */
  fastify.post('/confirmar-envio', {
    schema: {
      body: {
        type: 'object',
        properties: {
          phone: { type: 'string', minLength: 1, maxLength: 30 },
          whatsapp_message_id: { type: 'string', minLength: 1, maxLength: 255 },
          webhook_token: { type: 'string', minLength: 1 }
        },
        required: ['phone', 'whatsapp_message_id', 'webhook_token']
      }
    }
  }, async (request, reply) => {
    const { phone, whatsapp_message_id, webhook_token } = request.body;

    // --- Auth via webhook_token ---
    let empresa;
    try {
      const empresaResult = await pool.query(
        'SELECT id, nome FROM empresas WHERE webhook_token = $1 AND ativo = true LIMIT 1',
        [webhook_token]
      );

      if (empresaResult.rows.length === 0) {
        return reply.code(401).send({
          success: false,
          error: { code: 'INVALID_TOKEN', message: 'Invalid or inactive webhook token' }
        });
      }

      empresa = empresaResult.rows[0];
    } catch (err) {
      createLogger.error('Token lookup failed (confirmar-envio)', { error: err.message });
      return reply.code(500).send({
        success: false,
        error: { code: 'DB_ERROR', message: 'Failed to validate token' }
      });
    }

    const empresa_id = empresa.id;

    try {
      // Find the most recent outgoing message for this phone/empresa
      const result = await pool.query(`
        UPDATE mensagens_log SET whatsapp_message_id = $1
        WHERE id = (
          SELECT ml.id FROM mensagens_log ml
          JOIN conversas c ON c.id = ml.conversa_id
          WHERE c.contato_whatsapp = $2 AND ml.empresa_id = $3 AND ml.direcao = 'saida'
          ORDER BY ml.criado_em DESC LIMIT 1
        )
        RETURNING id
      `, [whatsapp_message_id, phone, empresa_id]);

      if (result.rows.length === 0) {
        createLogger.warn('No outgoing message found to update wamid', { phone, empresa_id });
        return { success: true, data: { updated: false, reason: 'no_message_found' } };
      }

      createLogger.info('WhatsApp message ID saved', { whatsapp_message_id, phone, empresa_id, mensagem_id: result.rows[0].id });
      return { success: true, data: { updated: true, mensagem_id: result.rows[0].id } };

    } catch (err) {
      createLogger.error('Failed to save wamid', { error: err.message, phone, empresa_id });
      return reply.code(500).send({
        success: false,
        error: { code: 'DB_ERROR', message: 'Failed to save message confirmation' }
      });
    }
  });

  /**
   * POST /api/webhooks/n8n/controle-humano
   * Endpoint for n8n to notify when a human operator assumes/releases a conversation in Chatwoot
   *
   * Authentication: x-webhook-token header validated against empresas.webhook_token
   */
  fastify.post('/controle-humano', {
    schema: {
      body: {
        type: 'object',
        properties: {
          phone: { type: 'string', minLength: 1, maxLength: 30 },
          acao: { type: 'string', enum: ['assumir', 'devolver', 'encerrar'] },
          operador_nome: { type: 'string', maxLength: 255 }
        },
        required: ['phone', 'acao']
      }
    }
  }, async (request, reply) => {
    const { phone, acao, operador_nome } = request.body;
    const webhookToken = request.headers['x-webhook-token'];

    // --- Auth via webhook_token ---
    if (!webhookToken) {
      return reply.code(401).send({
        success: false,
        error: { code: 'MISSING_TOKEN', message: 'Header x-webhook-token is required' }
      });
    }

    let empresa;
    try {
      const empresaResult = await pool.query(
        'SELECT id, nome FROM empresas WHERE webhook_token = $1 AND ativo = true LIMIT 1',
        [webhookToken]
      );

      if (empresaResult.rows.length === 0) {
        return reply.code(401).send({
          success: false,
          error: { code: 'INVALID_TOKEN', message: 'Invalid or inactive webhook token' }
        });
      }

      empresa = empresaResult.rows[0];
    } catch (err) {
      createLogger.error('Token lookup failed (controle-humano)', { error: err.message });
      return reply.code(500).send({
        success: false,
        error: { code: 'DB_ERROR', message: 'Failed to validate token' }
      });
    }

    const empresa_id = empresa.id;

    createLogger.info('Controle humano request', { empresa_id, phone, acao, operador_nome });

    if (acao === 'devolver') {
      try {
        // Find active conversation for this phone (with config and chatwoot data)
        const conversaResult = await pool.query(`
          SELECT c.*, cch.mensagem_retorno_ia, cch.notificar_admin_ao_devolver,
                 e.chatwoot_url, e.chatwoot_api_token, e.chatwoot_account_id
          FROM conversas c
          JOIN empresas e ON e.id = c.empresa_id
          LEFT JOIN config_controle_humano cch ON cch.empresa_id = c.empresa_id
          WHERE c.empresa_id = $1 AND c.contato_whatsapp = $2 AND c.status = 'ativo'
          ORDER BY c.criado_em DESC
          LIMIT 1
        `, [empresa_id, phone]);

        if (conversaResult.rows.length === 0) {
          return reply.code(404).send({
            success: false,
            error: {
              code: 'CONVERSA_NOT_FOUND',
              message: 'Nenhuma conversa ativa encontrada para este telefone'
            }
          });
        }

        const conversa = conversaResult.rows[0];

        if (conversa.controlado_por === 'ia') {
          return reply.code(400).send({
            success: false,
            error: {
              code: 'ALREADY_AI_CONTROLLED',
              message: 'Conversa já está sendo controlada pela IA'
            }
          });
        }

        // Update conversation back to AI control
        await pool.query(`
          UPDATE conversas
          SET
            controlado_por = 'ia',
            humano_devolveu_em = NOW(),
            atualizado_em = NOW()
          WHERE id = $1
        `, [conversa.id]);

        // Log in controle_historico
        await pool.query(`
          INSERT INTO controle_historico (
            id, conversa_id, empresa_id, acao,
            de_controlador, para_controlador,
            humano_nome, motivo, criado_em
          )
          VALUES (
            gen_random_uuid(), $1, $2, 'humano_devolveu',
            'humano', 'ia',
            $3, 'Operador devolveu via Chatwoot (n8n webhook)', NOW()
          )
        `, [conversa.id, empresa_id, operador_nome || 'Operador Chatwoot']);

        // Create notification if configured
        if (conversa.notificar_admin_ao_devolver !== false) {
          pool.query(`
            INSERT INTO notificacoes (
              id, empresa_id, tipo, titulo, mensagem,
              severidade, lida, criado_em
            )
            VALUES (
              gen_random_uuid(), $1, 'conversa_devolvida',
              'Conversa devolvida para IA',
              $2,
              'info', false, NOW()
            )
          `, [
            empresa_id,
            `${operador_nome || 'Operador'} devolveu a conversa com ${phone} para a IA via Chatwoot`
          ]).catch(err => {
            createLogger.error('Failed to create notification', { error: err.message });
          });
        }

        // Non-blocking: send return message via Chatwoot
        if (conversa.mensagem_retorno_ia && conversa.chatwoot_url && conversa.chatwoot_api_token && conversa.chatwoot_account_id && conversa.conversation_id_chatwoot) {
          chatwootSendMessage({
            baseUrl: conversa.chatwoot_url,
            accountId: conversa.chatwoot_account_id,
            apiKey: conversa.chatwoot_api_token,
            conversationId: conversa.conversation_id_chatwoot,
            content: conversa.mensagem_retorno_ia,
          }).catch(err => {
            createLogger.error('Failed to send return message to Chatwoot', { error: err.message });
          });
        }

        // Non-blocking: sync Chatwoot messages to Redis (so AI has context of human conversation)
        if (conversa.chatwoot_url && conversa.chatwoot_api_token && conversa.chatwoot_account_id && conversa.conversation_id_chatwoot && conversa.humano_assumiu_em) {
          (async () => {
            try {
              const chatwootMessages = await getConversationMessages({
                baseUrl: conversa.chatwoot_url,
                accountId: conversa.chatwoot_account_id,
                apiKey: conversa.chatwoot_api_token,
                conversationId: conversa.conversation_id_chatwoot,
                after: conversa.humano_assumiu_em
              });

              const conversationKey = `whatsapp:${conversa.contato_whatsapp}`;
              if (chatwootMessages.length > 0) {
                const synced = await syncChatwootHistory(empresa_id, conversationKey, chatwootMessages);
                createLogger.info('Synced Chatwoot messages to Redis', { conversa_id: conversa.id, synced });
              }
            } catch (err) {
              createLogger.error('Failed to sync Chatwoot history', { error: err.message, conversa_id: conversa.id });
            }
          })();
        }

        createLogger.info('Human control deactivated via n8n', {
          empresa_id, conversa_id: conversa.id, phone, operador_nome
        });

        return {
          success: true,
          data: {
            conversa_id: conversa.id,
            controlado_por: 'ia',
            operador_nome: operador_nome || 'Operador Chatwoot'
          }
        };

      } catch (error) {
        createLogger.error('Failed to process devolver', {
          empresa_id, phone, error: error.message
        });
        return reply.code(500).send({
          success: false,
          error: { code: 'PROCESSING_ERROR', message: 'Falha ao processar devolução' }
        });
      }
    }

    // --- acao === 'encerrar' ---
    if (acao === 'encerrar') {
      try {
        // Find active conversation for this phone
        const conversaResult = await pool.query(`
          SELECT c.id, c.contato_whatsapp, c.status, c.controlado_por,
                 c.conversation_id_chatwoot
          FROM conversas c
          WHERE c.empresa_id = $1 AND c.contato_whatsapp = $2 AND c.status = 'ativo'
          ORDER BY c.criado_em DESC
          LIMIT 1
        `, [empresa_id, phone]);

        if (conversaResult.rows.length === 0) {
          return reply.code(404).send({
            success: false,
            error: {
              code: 'CONVERSA_NOT_FOUND',
              message: 'Nenhuma conversa ativa encontrada para este telefone'
            }
          });
        }

        const conversa = conversaResult.rows[0];

        // Update conversation status to finalizado
        await pool.query(`
          UPDATE conversas
          SET
            status = 'finalizado',
            humano_devolveu_em = CASE WHEN controlado_por = 'humano' THEN NOW() ELSE humano_devolveu_em END,
            atualizado_em = NOW()
          WHERE id = $1
        `, [conversa.id]);

        // Finalize any active atendimentos
        await pool.query(`
          UPDATE atendimentos
          SET status = 'finalizado', finalizado_em = NOW()
          WHERE conversa_id = $1 AND status = 'ativo'
        `, [conversa.id]);

        // Log in controle_historico
        await pool.query(`
          INSERT INTO controle_historico (
            id, conversa_id, empresa_id, acao,
            de_controlador, para_controlador,
            humano_nome, motivo, criado_em
          )
          VALUES (
            gen_random_uuid(), $1, $2, 'humano_devolveu',
            $3, 'ia',
            $4, 'Atendimento encerrado via Chatwoot (n8n webhook)', NOW()
          )
        `, [conversa.id, empresa_id, conversa.controlado_por, operador_nome || 'Operador Chatwoot']);

        // Archive conversation history in Redis (move to archive with 30-day TTL)
        const conversationKey = `whatsapp:${conversa.contato_whatsapp}`;
        archiveConversation(empresa_id, conversationKey).catch(err => {
          createLogger.error('Failed to archive conversation', { error: err.message, conversa_id: conversa.id });
        });

        // Create notification
        pool.query(`
          INSERT INTO notificacoes (
            id, empresa_id, tipo, titulo, mensagem,
            severidade, lida, criado_em
          )
          VALUES (
            gen_random_uuid(), $1, 'conversa_encerrada',
            'Atendimento encerrado',
            $2,
            'info', false, NOW()
          )
        `, [
          empresa_id,
          `Atendimento com ${phone} foi encerrado no Chatwoot${operador_nome ? ` por ${operador_nome}` : ''}`
        ]).catch(err => {
          createLogger.error('Failed to create notification', { error: err.message });
        });

        createLogger.info('Conversation closed via n8n', {
          empresa_id, conversa_id: conversa.id, phone, operador_nome
        });

        return {
          success: true,
          data: {
            conversa_id: conversa.id,
            status: 'finalizado'
          }
        };

      } catch (error) {
        createLogger.error('Failed to process encerrar', {
          empresa_id, phone, error: error.message
        });
        return reply.code(500).send({
          success: false,
          error: { code: 'PROCESSING_ERROR', message: 'Falha ao encerrar conversa' }
        });
      }
    }

    // --- acao === 'assumir' ---
    try {
      // Find active conversation for this phone
      const conversaResult = await pool.query(`
        SELECT id, controlado_por FROM conversas
        WHERE empresa_id = $1 AND contato_whatsapp = $2 AND status = 'ativo'
        ORDER BY criado_em DESC
        LIMIT 1
      `, [empresa_id, phone]);

      if (conversaResult.rows.length === 0) {
        return reply.code(404).send({
          success: false,
          error: {
            code: 'CONVERSA_NOT_FOUND',
            message: 'Nenhuma conversa ativa encontrada para este telefone'
          }
        });
      }

      const conversa = conversaResult.rows[0];

      if (conversa.controlado_por === 'humano') {
        return reply.code(400).send({
          success: false,
          error: {
            code: 'ALREADY_HUMAN_CONTROLLED',
            message: 'Conversa já está sendo controlada por humano'
          }
        });
      }

      // Update conversation to human control
      await pool.query(`
        UPDATE conversas
        SET
          controlado_por = 'humano',
          humano_nome = $1,
          humano_assumiu_em = NOW(),
          humano_ultima_msg_em = NOW(),
          atualizado_em = NOW()
        WHERE id = $2
      `, [operador_nome || 'Operador Chatwoot', conversa.id]);

      // Log in controle_historico
      await pool.query(`
        INSERT INTO controle_historico (
          id, conversa_id, empresa_id, acao,
          de_controlador, para_controlador,
          humano_nome, motivo, criado_em
        )
        VALUES (
          gen_random_uuid(), $1, $2, 'humano_assumiu',
          'ia', 'humano',
          $3, 'Operador assumiu via Chatwoot (n8n webhook)', NOW()
        )
      `, [conversa.id, empresa_id, operador_nome || 'Operador Chatwoot']);

      // Create notification
      pool.query(`
        INSERT INTO notificacoes (
          id, empresa_id, tipo, titulo, mensagem,
          severidade, lida, criado_em
        )
        VALUES (
          gen_random_uuid(), $1, 'conversa_assumida',
          'Operador assumiu conversa',
          $2,
          'info', false, NOW()
        )
      `, [
        empresa_id,
        `${operador_nome || 'Operador'} assumiu a conversa com ${phone} via Chatwoot`
      ]).catch(err => {
        createLogger.error('Failed to create notification', { error: err.message });
      });

      createLogger.info('Human control activated via n8n', {
        empresa_id, conversa_id: conversa.id, phone, operador_nome
      });

      return {
        success: true,
        data: {
          conversa_id: conversa.id,
          controlado_por: 'humano',
          operador_nome: operador_nome || 'Operador Chatwoot'
        }
      };

    } catch (error) {
      createLogger.error('Failed to process controle-humano', {
        empresa_id, phone, acao, error: error.message
      });
      return reply.code(500).send({
        success: false,
        error: { code: 'PROCESSING_ERROR', message: 'Falha ao processar controle humano' }
      });
    }
  });

  /**
   * GET /api/webhooks/n8n/health
   * Health check for n8n webhook endpoint
   */
  fastify.get('/health', async () => {
    return {
      success: true,
      data: {
        status: 'healthy',
        webhook: 'n8n',
        timestamp: new Date().toISOString()
      }
    };
  });
};

export default n8nWebhookRoutes;
