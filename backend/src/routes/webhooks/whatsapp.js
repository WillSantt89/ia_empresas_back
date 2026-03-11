import crypto from 'crypto';
import { logger } from '../../config/logger.js';
import { pool } from '../../config/database.js';
import { decrypt } from '../../config/encryption.js';
import { whatsappQueue } from '../../queues/queues.js';
import { handleStatusUpdates } from '../../services/message-processor.js';
import { emitStatusEntrega } from '../../services/websocket.js';

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
   * FAST PATH: validates HMAC, enqueues job, responds 200 in <100ms.
   * Heavy processing (Gemini AI, sending, logging) happens in BullMQ workers.
   */
  fastify.post('/', {
    config: { rawBody: true },
  }, async (request, reply) => {
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

      // --- Lookup company by phone_number_id (fast query, indexed) ---
      const wnResult = await pool.query(
        `SELECT wn.id as wn_id, wn.empresa_id, wn.token_graph_api, wn.whatsapp_app_secret, e.nome as empresa_nome
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

      // --- HMAC signature validation ---
      if (!whatsappNumber.whatsapp_app_secret) {
        createLogger.warn('whatsapp_app_secret not configured — skipping HMAC validation', { phoneNumberId, empresa_id });
      } else {
        const appSecret = decrypt(whatsappNumber.whatsapp_app_secret);
        const signature = request.headers['x-hub-signature-256'];

        if (!appSecret || !signature) {
          createLogger.warn('Missing HMAC secret or signature header', { phoneNumberId, empresa_id });
          return reply.code(401).send('Missing signature');
        }

        const rawBody = request.raw.rawBody || JSON.stringify(request.body);
        const expectedSig = crypto.createHmac('sha256', appSecret).update(rawBody).digest('hex');
        const receivedSig = signature.replace('sha256=', '');

        const expected = Buffer.from(expectedSig, 'utf8');
        const received = Buffer.from(receivedSig, 'utf8');
        if (expected.length !== received.length || !crypto.timingSafeEqual(expected, received)) {
          createLogger.warn('Invalid HMAC signature', { phoneNumberId, empresa_id });
        }
      }

      const graphToken = decrypt(whatsappNumber.token_graph_api);
      if (!graphToken) {
        createLogger.error('No valid Graph API token', { phoneNumberId, empresa_id });
        return reply.code(200).send('OK');
      }

      // --- Handle status updates (delivered, read, etc.) — lightweight, stays here ---
      if (value.statuses && value.statuses.length > 0) {
        handleStatusUpdates(value.statuses, empresa_id).catch(err => {
          createLogger.error('Failed to handle status updates', { error: err.message });
        });
        return reply.code(200).send('OK');
      }

      // --- Handle messages: ENQUEUE to BullMQ ---
      const messages = value.messages;
      if (!messages || messages.length === 0) {
        return reply.code(200).send('OK');
      }

      const contacts = value.contacts || [];

      for (const message of messages) {
        try {
          await whatsappQueue.add('process-message', {
            message,
            contacts,
            phoneNumberId,
            empresa_id,
            wnId: whatsappNumber.wn_id,
          }, {
            // Deduplicate: Meta may re-send webhooks
            jobId: `wa-${message.id}`,
          });

          createLogger.info({ empresa_id, phone: message.from, type: message.type, jobId: `wa-${message.id}` }, 'WhatsApp message enqueued');
        } catch (err) {
          // If jobId already exists, BullMQ rejects — that's ok (dedup)
          if (err.message?.includes('Job already exists')) {
            createLogger.debug({ messageId: message.id }, 'Duplicate message ignored');
          } else {
            createLogger.error({ err, empresa_id, messageId: message.id }, 'Failed to enqueue WhatsApp message');
          }
        }
      }

      return reply.code(200).send('OK');

    } catch (error) {
      createLogger.error({ err: error }, 'WhatsApp webhook error');
      return reply.code(200).send('OK');
    }
  });
};

export default whatsappWebhookRoutes;
