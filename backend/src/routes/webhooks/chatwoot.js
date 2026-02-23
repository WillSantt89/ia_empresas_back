import { logger } from '../../config/logger.js';
import { pool, tenantQuery } from '../../config/database.js';
import { validateWebhookSignature, parseWebhookEvent } from '../../services/chatwoot.js';
import { config } from '../../config/env.js';
import fetch from 'node-fetch';

/**
 * Chatwoot Webhook Routes
 * Receives and processes events from Chatwoot
 */

const createLogger = logger.child({ module: 'chatwoot-webhook' });

const chatwootWebhookRoutes = async (fastify) => {
  // Webhook event schema
  const webhookEventSchema = {
    type: 'object',
    properties: {
      event: { type: 'string' },
      id: { type: ['string', 'number'] },
      content: { type: ['string', 'null'] },
      message_type: { type: 'string' },
      conversation: {
        type: 'object',
        properties: {
          id: { type: 'number' },
          status: { type: 'string' },
          account_id: { type: 'number' },
          inbox_id: { type: 'number' }
        }
      },
      sender: {
        type: 'object',
        properties: {
          id: { type: 'number' },
          name: { type: ['string', 'null'] },
          email: { type: ['string', 'null'] },
          phone_number: { type: ['string', 'null'] }
        }
      },
      account: {
        type: 'object',
        properties: {
          id: { type: 'number' },
          name: { type: 'string' }
        }
      }
    }
  };

  /**
   * POST /api/webhooks/chatwoot
   * Receive events from Chatwoot
   */
  fastify.post('/', {
    config: {
      rawBody: true // Need raw body for signature verification
    },
    schema: {
      body: webhookEventSchema
    }
  }, async (request, reply) => {
    const startTime = Date.now();

    try {
      // Verify webhook signature if secret is configured
      if (config.CHATWOOT_WEBHOOK_SECRET) {
        const signature = request.headers['x-chatwoot-signature'];
        const rawBody = request.rawBody;

        if (!signature || !validateWebhookSignature(rawBody, signature, config.CHATWOOT_WEBHOOK_SECRET)) {
          createLogger.warn('Invalid webhook signature', {
            has_signature: !!signature,
            ip: request.ip
          });

          return reply.code(401).send({
            success: false,
            error: {
              code: 'INVALID_SIGNATURE',
              message: 'Invalid webhook signature'
            }
          });
        }
      }

      // Parse event
      const event = parseWebhookEvent(request.body);

      createLogger.info('Webhook event received', {
        event_type: event.event,
        conversation_id: event.conversation?.id,
        account_id: event.account?.id,
        message_type: event.message_type
      });

      // Only process incoming messages
      if (event.event !== 'message_created' || event.message_type !== 'incoming') {
        return {
          success: true,
          data: {
            processed: false,
            reason: 'Not an incoming message'
          }
        };
      }

      // Skip if no content
      if (!event.content || event.content.trim() === '') {
        return {
          success: true,
          data: {
            processed: false,
            reason: 'Empty message content'
          }
        };
      }

      // Find empresa by account_id
      const empresaQuery = `
        SELECT
          e.id as empresa_id,
          ce.agente_id,
          ce.api_key_id,
          ak.key_hash
        FROM chatwoot_empresas ce
        INNER JOIN empresas e ON ce.empresa_id = e.id
        LEFT JOIN api_keys ak ON ce.api_key_id = ak.id
        WHERE ce.chatwoot_account_id = $1
          AND ce.is_active = true
          AND e.is_active = true
        LIMIT 1
      `;

      const empresaResult = await pool.query(empresaQuery, [event.account.id]);

      if (empresaResult.rows.length === 0) {
        createLogger.warn('No active empresa found for account', {
          account_id: event.account.id
        });

        return {
          success: true,
          data: {
            processed: false,
            reason: 'No active configuration found'
          }
        };
      }

      const { empresa_id, agente_id, api_key_id } = empresaResult.rows[0];

      // Get API key for this configuration
      if (!api_key_id) {
        createLogger.error('No API key configured', {
          empresa_id,
          account_id: event.account.id
        });

        return {
          success: true,
          data: {
            processed: false,
            reason: 'No API key configured'
          }
        };
      }

      // Get the actual API key
      const keyQuery = `
        SELECT 'sk_live_' || encode(random_bytes(32), 'base64') as temp_key
        FROM api_keys
        WHERE id = $1 AND is_active = true
      `;

      // Note: In production, we would need to store and retrieve the actual API key
      // For now, we'll use the internal API endpoint

      // Call our chat API internally
      const chatApiUrl = `http://localhost:${config.PORT}/api/chat/message`;

      // Get the API key value (in real implementation, this would be retrieved securely)
      // For now, we'll make an internal call without the API key validation
      const internalRequest = {
        message: event.content,
        conversation_id: event.conversation.id,
        context: {
          contact_id: event.conversation.contact_id,
          inbox_id: event.conversation.inbox_id,
          account_id: event.account.id
        }
      };

      // Create internal flag to bypass API key validation
      request.server.decorate('internalWebhookCall', true);

      // Process the message
      const chatResponse = await fetch(chatApiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': 'internal-webhook-call',
          'x-empresa-id': empresa_id,
          'x-agente-id': agente_id
        },
        body: JSON.stringify(internalRequest)
      });

      const chatResult = await chatResponse.json();

      if (!chatResponse.ok) {
        createLogger.error('Chat API error', {
          status: chatResponse.status,
          error: chatResult.error
        });

        return {
          success: true,
          data: {
            processed: false,
            reason: 'Chat processing failed',
            error: chatResult.error
          }
        };
      }

      const processingTime = Date.now() - startTime;

      createLogger.info('Webhook processed successfully', {
        empresa_id,
        conversation_id: event.conversation.id,
        processing_time_ms: processingTime,
        tokens_used: chatResult.data?.tokens_used?.total
      });

      // Log webhook event
      const webhookLogQuery = `
        INSERT INTO webhook_logs (
          empresa_id,
          tipo,
          evento,
          payload,
          status,
          processado_em,
          tempo_processamento_ms,
          resposta
        ) VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP, $6, $7)
      `;

      pool.query(webhookLogQuery, [
        empresa_id,
        'chatwoot',
        event.event,
        JSON.stringify(request.body),
        'success',
        processingTime,
        JSON.stringify(chatResult.data)
      ]).catch(err => {
        createLogger.error('Failed to log webhook event', {
          error: err.message
        });
      });

      return {
        success: true,
        data: {
          processed: true,
          conversation_id: event.conversation.id,
          tokens_used: chatResult.data?.tokens_used,
          processing_time_ms: processingTime
        }
      };

    } catch (error) {
      const processingTime = Date.now() - startTime;

      createLogger.error('Webhook processing failed', {
        error: error.message,
        event_type: request.body?.event,
        processing_time_ms: processingTime
      });

      // Log error
      if (request.body?.account?.id) {
        pool.query(
          `INSERT INTO webhook_logs (
            tipo, evento, payload, status,
            processado_em, tempo_processamento_ms, erro
          ) VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP, $5, $6)`,
          [
            'chatwoot',
            request.body.event,
            JSON.stringify(request.body),
            'error',
            processingTime,
            error.message
          ]
        ).catch(err => {
          createLogger.error('Failed to log webhook error', {
            error: err.message
          });
        });
      }

      // Return success to avoid webhook retries for processing errors
      return {
        success: true,
        data: {
          processed: false,
          reason: 'Processing error',
          error: error.message
        }
      };
    }
  });

  /**
   * GET /api/webhooks/chatwoot/health
   * Health check for webhook endpoint
   */
  fastify.get('/health', async (request, reply) => {
    return {
      success: true,
      data: {
        status: 'healthy',
        webhook: 'chatwoot',
        timestamp: new Date().toISOString()
      }
    };
  });
};

export default chatwootWebhookRoutes;