import { logger } from '../config/logger.js';
import { validateApiKey, getActiveKeysForAgent, recordKeyError, recordKeySuccess } from '../services/api-key-manager.js';
import { getHistory, addToHistory, addToolCallToHistory, formatHistoryForGemini } from '../services/memory.js';
import { processMessageWithTools, buildToolDeclarations } from '../services/gemini.js';
import { executeTool, transformResultForLLM } from '../services/tool-runner.js';
import { decrypt } from '../config/encryption.js';
import { pool, tenantQuery } from '../config/database.js';
import { DEFAULT_LIMITS } from '../config/constants.js';

/**
 * Chat Routes
 * Main endpoint for AI agent interactions
 */

const createLogger = logger.child({ module: 'chat-routes' });

const chatRoutes = async (fastify) => {
  // Chat message schema
  const chatMessageSchema = {
    type: 'object',
    properties: {
      message: { type: 'string', minLength: 1, maxLength: 4000 },
      conversation_id: { type: 'integer' },
      context: {
        type: 'object',
        properties: {
          contact_id: { type: 'integer' },
          inbox_id: { type: 'integer' },
          account_id: { type: 'integer' }
        }
      }
    },
    required: ['message', 'conversation_id']
  };

  // API key header schema
  const apiKeyHeaderSchema = {
    type: 'object',
    properties: {
      'x-api-key': { type: 'string' }
    },
    required: ['x-api-key']
  };

  /**
   * POST /api/chat/message
   * Process a message through AI agent
   */
  fastify.post('/message', {
    schema: {
      body: chatMessageSchema,
      headers: apiKeyHeaderSchema,
      response: {
        200: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            data: {
              type: 'object',
              properties: {
                response: { type: 'string' },
                tokens_used: {
                  type: 'object',
                  properties: {
                    input: { type: 'integer' },
                    output: { type: 'integer' },
                    total: { type: 'integer' }
                  }
                },
                tools_called: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      name: { type: 'string' },
                      duration_ms: { type: 'integer' }
                    }
                  }
                },
                processing_time_ms: { type: 'integer' }
              }
            }
          }
        }
      }
    }
  }, async (request, reply) => {
    const startTime = Date.now();
    const { message, conversation_id, context } = request.body;
    const apiKey = request.headers['x-api-key'];
    let keyData;

    try {

      // Resolve agent data and available API keys
      let availableKeys = [];

      if (apiKey === 'internal-webhook-call' &&
          request.headers['x-empresa-id'] &&
          request.headers['x-agente-id']) {

        // Internal call from webhook - get agent data directly
        const empresaId = request.headers['x-empresa-id'];
        const agenteId = request.headers['x-agente-id'];

        const agentQuery = `
          SELECT
            a.id as agente_id,
            a.nome as agente_nome,
            a.modelo,
            a.temperatura,
            a.max_tokens,
            a.prompt_ativo
          FROM agentes a
          WHERE a.id = $1 AND a.empresa_id = $2
            AND a.ativo = true
          LIMIT 1
        `;

        const agentResult = await pool.query(agentQuery, [agenteId, empresaId]);

        if (agentResult.rows.length === 0) {
          return reply.code(404).send({
            success: false,
            error: {
              code: 'AGENT_NOT_FOUND',
              message: 'Active agent not found'
            }
          });
        }

        const agent = agentResult.rows[0];

        // Get all active keys for failover
        availableKeys = await getActiveKeysForAgent(empresaId, agenteId);

        if (availableKeys.length === 0) {
          return reply.code(400).send({
            success: false,
            error: {
              code: 'NO_API_KEYS',
              message: 'No active API keys configured for this agent'
            }
          });
        }

        keyData = {
          empresa_id: empresaId,
          agente_id: agent.agente_id,
          agente_nome: agent.agente_nome,
          gemini_api_key: availableKeys[0].gemini_api_key,
          modelo: agent.modelo,
          temperatura: agent.temperatura,
          max_tokens: agent.max_tokens,
          prompt_ativo: agent.prompt_ativo
        };

      } else {
        // External call - validate API key normally
        keyData = await validateApiKey(apiKey);
        if (!keyData) {
          return reply.code(401).send({
            success: false,
            error: {
              code: 'INVALID_API_KEY',
              message: 'Invalid or expired API key'
            }
          });
        }

        // Also load all keys for failover
        if (keyData.agente_id) {
          availableKeys = await getActiveKeysForAgent(keyData.empresa_id, keyData.agente_id);
        }
        if (availableKeys.length === 0) {
          availableKeys = [{ id: null, gemini_api_key: keyData.gemini_api_key }];
        }
      }

      const {
        empresa_id,
        agente_id,
        agente_nome,
        gemini_api_key,
        modelo,
        temperatura,
        max_tokens,
        prompt_ativo
      } = keyData;

      createLogger.info('Processing chat message', {
        empresa_id,
        agente_id,
        conversation_id,
        message_length: message.length
      });

      // ========== DAILY LIMIT CHECK ==========
      const limitCheck = await pool.query(`
        INSERT INTO uso_diario_agente (empresa_id, agente_id, data, total_atendimentos, limite_diario)
        SELECT $1, $2, CURRENT_DATE, 0, COALESCE(
          (SELECT max_mensagens_mes / 30 FROM empresa_limits WHERE empresa_id = $1),
          500
        )
        ON CONFLICT (empresa_id, agente_id, data) DO NOTHING
        RETURNING *
      `, [empresa_id, agente_id]);

      // Check if limit reached
      const usageResult = await pool.query(`
        SELECT total_atendimentos, limite_diario, limite_atingido
        FROM uso_diario_agente
        WHERE empresa_id = $1 AND agente_id = $2 AND data = CURRENT_DATE
      `, [empresa_id, agente_id]);

      if (usageResult.rows.length > 0) {
        const usage = usageResult.rows[0];
        if (usage.limite_atingido || usage.total_atendimentos >= usage.limite_diario) {
          createLogger.warn('Daily limit reached', {
            empresa_id, agente_id,
            current: usage.total_atendimentos,
            limit: usage.limite_diario
          });

          // Get custom limit message from agent
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
              tokens_used: { input: 0, output: 0, total: 0 },
              tools_called: [],
              processing_time_ms: Date.now() - startTime,
              limit_reached: true
            }
          };
        }
      }
      // ========== END DAILY LIMIT CHECK ==========

      // Get agent's tools
      const toolsQuery = `
        SELECT
          t.id,
          t.nome,
          t.descricao_para_llm,
          t.url,
          t.metodo,
          t.headers_json,
          t.body_template_json,
          t.parametros_schema_json,
          t.timeout_ms
        FROM tools t
        INNER JOIN agente_tools at2 ON t.id = at2.tool_id
        WHERE at2.agente_id = $1
          AND t.ativo = true
        ORDER BY at2.ordem_prioridade ASC
      `;

      const toolsResult = await pool.query(toolsQuery, [agente_id]);

      const tools = toolsResult.rows;

      // Get conversation history
      const history = await getHistory(empresa_id, conversation_id);

      // ========== RESOLVE CONVERSA_ID FOR MENSAGENS_LOG ==========
      let conversa_id_interno = null;
      try {
        const conversaLookup = await pool.query(`
          SELECT id FROM conversas
          WHERE empresa_id = $1 AND status = 'ativo'
          ORDER BY criado_em DESC LIMIT 1
        `, [empresa_id]);

        if (conversaLookup.rows.length > 0) {
          conversa_id_interno = conversaLookup.rows[0].id;
        }
      } catch (conversaErr) {
        createLogger.warn('Failed to resolve conversa_id for mensagens_log', { error: conversaErr.message });
      }
      // ========== END RESOLVE CONVERSA_ID ==========

      // Add user message to history
      await addToHistory(empresa_id, conversation_id, 'user', message);

      // Log incoming message to mensagens_log (async, non-blocking)
      if (conversa_id_interno) {
        pool.query(`
          INSERT INTO mensagens_log (conversa_id, empresa_id, direcao, conteudo, criado_em)
          VALUES ($1, $2, 'entrada', $3, NOW())
        `, [conversa_id_interno, empresa_id, message]).catch(err => {
          createLogger.warn('Failed to log incoming message to mensagens_log', { error: err.message });
        });
      }

      // Build tool declarations for Gemini
      const toolDeclarations = buildToolDeclarations(tools);

      // Tool executor function
      const toolExecutor = async (tool, args) => {
        const toolConfig = tools.find(t => t.nome.toLowerCase() === tool.nome.toLowerCase());
        if (!toolConfig) {
          throw new Error(`Tool ${tool.nome} not found`);
        }

        const result = await executeTool(toolConfig, args);
        return transformResultForLLM(result, 8000);
      };

      // Process message with Gemini (with failover across API keys)
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
              maxTokens: max_tokens
            },
            toolExecutor
          );

          // Success - record it and break
          if (currentKey.id) {
            recordKeySuccess(currentKey.id).catch(() => {});
          }

          if (keyIndex > 0) {
            createLogger.info('Failover successful', {
              empresa_id,
              agente_id,
              failed_keys: keyIndex,
              successful_key_index: keyIndex
            });
          }

          break; // Success, exit loop

        } catch (error) {
          const isRetryable = error.code === 'RATE_LIMITED' || error.code === 'INVALID_KEY' || error.code === 'API_ERROR';

          // Record error on this key
          if (currentKey.id) {
            recordKeyError(currentKey.id, error.message || error.code || 'Unknown error').catch(() => {});
          }

          createLogger.warn('API key failed, attempting failover', {
            empresa_id,
            agente_id,
            key_index: keyIndex,
            total_keys: availableKeys.length,
            error_code: error.code,
            error_message: error.message,
            will_retry: isRetryable && keyIndex < availableKeys.length - 1
          });

          // If it's the last key or non-retryable error, throw
          if (!isRetryable || keyIndex >= availableKeys.length - 1) {
            throw error;
          }

          // Otherwise continue to next key
        }
      }

      if (!result) {
        throw new Error('All API keys failed');
      }

      // Add assistant response to history
      await addToHistory(empresa_id, conversation_id, 'model', result.text);

      // Add tool calls to history
      for (const toolCall of result.toolsCalled) {
        await addToolCallToHistory(
          empresa_id,
          conversation_id,
          { name: toolCall.name, args: toolCall.args },
          toolCall.result
        );
      }

      // Log outgoing message to mensagens_log (async, non-blocking)
      if (conversa_id_interno) {
        const chatProcessingTime = Date.now() - startTime;
        pool.query(`
          INSERT INTO mensagens_log (
            conversa_id, empresa_id, direcao, conteudo,
            tokens_input, tokens_output, tools_invocadas_json,
            modelo_usado, api_key_usada_id, latencia_ms, criado_em
          ) VALUES ($1, $2, 'saida', $3, $4, $5, $6, $7, $8, $9, NOW())
        `, [
          conversa_id_interno, empresa_id, result.text,
          result.tokensInput, result.tokensOutput,
          result.toolsCalled.length > 0 ? JSON.stringify(result.toolsCalled.map(tc => tc.name)) : null,
          modelo, usedKeyId, chatProcessingTime
        ]).catch(err => {
          createLogger.warn('Failed to log outgoing message to mensagens_log', { error: err.message });
        });
      }

      // ========== INCREMENT DAILY USAGE ==========
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
      // ========== END INCREMENT DAILY USAGE ==========

      // ========== TRANSFER CHECK ==========
      let transferExecuted = false;
      try {
        // Load transfer rules for this agent
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
              // Check if response or user message contains keyword
              const textToCheck = (message + ' ' + result.text).toLowerCase();
              shouldTransfer = textToCheck.includes(String(rule.trigger_valor).toLowerCase());
            } else if (rule.trigger_tipo === 'tool_result') {
              // Check if a specific tool was called with matching result
              shouldTransfer = result.toolsCalled.some(tc =>
                tc.name === rule.trigger_valor ||
                (tc.result && JSON.stringify(tc.result).includes(String(rule.trigger_valor)))
              );
            } else if (rule.trigger_tipo === 'menu_opcao') {
              // Check if user message matches menu option
              shouldTransfer = message.trim().toLowerCase() === String(rule.trigger_valor).toLowerCase();
            }

            if (shouldTransfer) {
              createLogger.info('Transfer triggered', {
                empresa_id,
                from_agent: agente_id,
                to_agent: rule.agente_destino_id,
                trigger: rule.trigger_tipo,
                trigger_valor: rule.trigger_valor,
                conversation_id
              });

              // Update conversation to point to new agent
              await pool.query(`
                UPDATE conversas
                SET agente_id = $1, atualizado_em = CURRENT_TIMESTAMP
                WHERE empresa_id = $2
                  AND id::text = $3::text
              `, [rule.agente_destino_id, empresa_id, conversation_id]);

              // Log transfer in controle_historico
              pool.query(`
                INSERT INTO controle_historico (
                  empresa_id, conversa_id, acao, motivo
                ) SELECT $1, c.id, 'transferencia_agente', $3
                FROM conversas c
                WHERE c.empresa_id = $1
                  AND c.id::text = $2::text
                LIMIT 1
              `, [empresa_id, conversation_id,
                  rule.trigger_tipo + ':' + rule.trigger_valor
              ]).catch(err => {
                createLogger.error('Failed to log transfer history', { error: err.message });
              });

              transferExecuted = true;
              break; // Only execute first matching rule
            }
          }
        }
      } catch (transferError) {
        createLogger.error('Transfer check failed (non-blocking)', {
          error: transferError.message, empresa_id, agente_id
        });
      }
      // ========== END TRANSFER CHECK ==========

      const processingTime = Date.now() - startTime;

      // Log conversation analytics
      const analyticsQuery = `
        INSERT INTO conversacao_analytics (
          empresa_id,
          agente_id,
          conversation_id,
          tokens_input,
          tokens_output,
          iteracoes,
          tools_chamadas,
          tempo_processamento_ms,
          modelo,
          sucesso
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      `;

      pool.query(analyticsQuery, [
        empresa_id,
        agente_id,
        conversation_id,
        result.tokensInput,
        result.tokensOutput,
        result.iteracoes,
        result.toolsCalled.length,
        processingTime,
        modelo,
        true
      ]).catch(err => {
        createLogger.error('Failed to log analytics', {
          error: err.message
        });
      });

      createLogger.info('Chat message processed successfully', {
        empresa_id,
        agente_id,
        conversation_id,
        tokens_total: result.tokensInput + result.tokensOutput,
        tools_called: result.toolsCalled.length,
        processing_time_ms: processingTime
      });

      return {
        success: true,
        data: {
          response: result.text,
          tokens_used: {
            input: result.tokensInput,
            output: result.tokensOutput,
            total: result.tokensInput + result.tokensOutput
          },
          tools_called: result.toolsCalled.map(tc => ({
            name: tc.name,
            duration_ms: tc.result?.duration_ms || 0
          })),
          processing_time_ms: processingTime
        }
      };

    } catch (error) {
      const processingTime = Date.now() - startTime;

      createLogger.error('Chat processing failed', {
        conversation_id,
        error: error.message,
        code: error.code,
        processing_time_ms: processingTime
      });

      // Log failed analytics
      if (keyData) {
        pool.query(
          `INSERT INTO conversacao_analytics (
            empresa_id, agente_id, conversation_id,
            tokens_input, tokens_output, iteracoes,
            tools_chamadas, tempo_processamento_ms,
            modelo, sucesso, erro
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
          [
            keyData.empresa_id,
            keyData.agente_id,
            conversation_id,
            error.partialResult?.tokensInput || 0,
            error.partialResult?.tokensOutput || 0,
            error.partialResult?.iteracoes || 0,
            error.partialResult?.toolsCalled?.length || 0,
            processingTime,
            keyData.modelo,
            false,
            error.message
          ]
        ).catch(err => {
          createLogger.error('Failed to log error analytics', {
            error: err.message
          });
        });
      }

      // Handle specific error types
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
        return reply.code(401).send({
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

      // Generic error response
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
   * POST /api/chat/clear
   * Clear conversation history
   */
  fastify.post('/clear', {
    schema: {
      body: {
        type: 'object',
        properties: {
          conversation_id: { type: 'integer' }
        },
        required: ['conversation_id']
      },
      headers: apiKeyHeaderSchema
    }
  }, async (request, reply) => {
    const { conversation_id } = request.body;
    const apiKey = request.headers['x-api-key'];

    try {
      // Validate API key
      const keyData = await validateApiKey(apiKey);
      if (!keyData) {
        return reply.code(401).send({
          success: false,
          error: {
            code: 'INVALID_API_KEY',
            message: 'Invalid or expired API key'
          }
        });
      }

      const { clearHistory } = await import('../services/memory.js');
      const cleared = await clearHistory(keyData.empresa_id, conversation_id);

      createLogger.info('Conversation history cleared', {
        empresa_id: keyData.empresa_id,
        conversation_id,
        cleared
      });

      return {
        success: true,
        data: {
          cleared
        }
      };

    } catch (error) {
      createLogger.error('Failed to clear history', {
        conversation_id,
        error: error.message
      });

      return reply.code(500).send({
        success: false,
        error: {
          code: 'CLEAR_ERROR',
          message: 'Failed to clear conversation history'
        }
      });
    }
  });

  /**
   * GET /api/chat/history/:conversationId
   * Get conversation history
   */
  fastify.get('/history/:conversationId', {
    schema: {
      params: {
        type: 'object',
        properties: {
          conversationId: { type: 'string' }
        },
        required: ['conversationId']
      },
      headers: apiKeyHeaderSchema
    }
  }, async (request, reply) => {
    const conversationId = parseInt(request.params.conversationId);
    const apiKey = request.headers['x-api-key'];

    try {
      // Validate API key
      const keyData = await validateApiKey(apiKey);
      if (!keyData) {
        return reply.code(401).send({
          success: false,
          error: {
            code: 'INVALID_API_KEY',
            message: 'Invalid or expired API key'
          }
        });
      }

      const history = await getHistory(keyData.empresa_id, conversationId);

      return {
        success: true,
        data: {
          history: history.map(msg => ({
            role: msg.role,
            content: msg.parts[0]?.text || msg.parts[0]?.functionCall?.name || 'function_response',
            timestamp: msg.timestamp
          }))
        }
      };

    } catch (error) {
      createLogger.error('Failed to get history', {
        conversation_id: conversationId,
        error: error.message
      });

      return reply.code(500).send({
        success: false,
        error: {
          code: 'HISTORY_ERROR',
          message: 'Failed to retrieve conversation history'
        }
      });
    }
  });

};

export default chatRoutes;