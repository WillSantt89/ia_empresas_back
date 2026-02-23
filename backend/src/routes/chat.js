import { logger } from '../config/logger.js';
import { validateApiKey } from '../services/api-key-manager.js';
import { getHistory, addToHistory, addToolCallToHistory, formatHistoryForGemini } from '../services/memory.js';
import { processMessageWithTools, buildToolDeclarations } from '../services/gemini.js';
import { executeTool, transformResultForLLM } from '../services/tool-runner.js';
import { sendMessage as sendToChatwoot, sendTypingIndicator } from '../services/chatwoot.js';
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

    try {
      // Validate API key and get agent configuration
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
        INNER JOIN agent_tools at ON t.id = at.tool_id
        WHERE at.agente_id = $1 AND at.empresa_id = $2
          AND t.is_active = true
        ORDER BY at.prioridade ASC
      `;

      const toolsResult = await tenantQuery(
        pool,
        empresa_id,
        toolsQuery,
        [agente_id, empresa_id]
      );

      const tools = toolsResult.rows;

      // Get conversation history
      const history = await getHistory(empresa_id, conversation_id);

      // Send typing indicator if Chatwoot context provided
      if (context?.account_id) {
        sendTypingIndicator({
          baseUrl: process.env.CHATWOOT_BASE_URL,
          accountId: context.account_id,
          apiKey: process.env.CHATWOOT_API_KEY,
          conversationId: conversation_id,
          status: 'on'
        }).catch(err => {
          createLogger.warn('Failed to send typing indicator', {
            error: err.message
          });
        });
      }

      // Add user message to history
      await addToHistory(empresa_id, conversation_id, 'user', message);

      // Build tool declarations for Gemini
      const toolDeclarations = buildToolDeclarations(tools);

      // Tool executor function
      const toolExecutor = async (tool, args) => {
        const toolConfig = tools.find(t => t.nome === tool.nome);
        if (!toolConfig) {
          throw new Error(`Tool ${tool.nome} not found`);
        }

        const result = await executeTool(toolConfig, args);
        return transformResultForLLM(result, 2000); // Limit result size
      };

      // Process message with Gemini
      const result = await processMessageWithTools(
        {
          apiKey: gemini_api_key,
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

      // Send response to Chatwoot if context provided
      if (context?.account_id && process.env.CHATWOOT_API_KEY) {
        sendToChatwoot({
          baseUrl: process.env.CHATWOOT_BASE_URL,
          accountId: context.account_id,
          apiKey: process.env.CHATWOOT_API_KEY,
          conversationId: conversation_id,
          content: result.text,
          messageType: 'outgoing'
        }).catch(err => {
          createLogger.error('Failed to send to Chatwoot', {
            error: err.message
          });
        });
      }

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

  /**
   * POST /api/chat/typing
   * Send typing indicator
   */
  fastify.post('/typing', {
    schema: {
      body: {
        type: 'object',
        properties: {
          conversation_id: { type: 'integer' },
          status: { type: 'string', enum: ['on', 'off'] },
          context: {
            type: 'object',
            properties: {
              account_id: { type: 'integer' }
            }
          }
        },
        required: ['conversation_id', 'status']
      },
      headers: apiKeyHeaderSchema
    }
  }, async (request, reply) => {
    const { conversation_id, status, context } = request.body;
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

      if (!context?.account_id || !process.env.CHATWOOT_API_KEY) {
        return {
          success: true,
          data: {
            message: 'Typing indicator not sent (Chatwoot not configured)'
          }
        };
      }

      await sendTypingIndicator({
        baseUrl: process.env.CHATWOOT_BASE_URL,
        accountId: context.account_id,
        apiKey: process.env.CHATWOOT_API_KEY,
        conversationId: conversation_id,
        status
      });

      return {
        success: true,
        data: {
          status
        }
      };

    } catch (error) {
      createLogger.error('Failed to send typing indicator', {
        conversation_id,
        error: error.message
      });

      // Don't fail the request for typing indicators
      return {
        success: true,
        data: {
          message: 'Typing indicator failed but request continued'
        }
      };
    }
  });
};

export default chatRoutes;