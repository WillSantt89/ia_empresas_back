import crypto from 'crypto';
import { logger } from '../../config/logger.js';
import { pool } from '../../config/database.js';
import { decrypt } from '../../config/encryption.js';
import { redis } from '../../config/redis.js';
import { whatsappQueue } from '../../queues/queues.js';
import { handleStatusUpdates } from '../../services/message-processor.js';
import { emitStatusEntrega } from '../../services/websocket.js';

const createLogger = logger.child({ module: 'whatsapp-webhook' });

// Debounce delay in ms — waits for more messages before processing
const DEBOUNCE_DELAY_MS = parseInt(process.env.WA_DEBOUNCE_MS || '4000', 10);

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
   * DEBOUNCE: accumulates rapid messages in Redis, waits 4s of silence,
   * then processes all messages as a single batch.
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
        // NÃO fazer return — payload pode conter messages junto com statuses
      }

      // --- Handle messages: DEBOUNCE + ENQUEUE ---
      const messages = value.messages;
      if (!messages || messages.length === 0) {
        return reply.code(200).send('OK');
      }

      const contacts = value.contacts || [];

      for (const message of messages) {
        const phone = message.from;
        const debounceKey = `debounce:${empresa_id}:${phone}`;
        const dedupKey = `dedup:wa:${message.id}`;

        // Deduplicação: Meta pode reenviar o mesmo webhook
        const alreadySeen = await redis.set(dedupKey, '1', 'EX', 300, 'NX');
        if (!alreadySeen) {
          createLogger.debug({ messageId: message.id }, 'Duplicate message ignored (dedup)');
          continue;
        }

        // Acumula mensagem no Redis (lista com TTL)
        await redis.rpush(debounceKey, JSON.stringify({
          message,
          contacts,
          phoneNumberId,
          empresa_id,
          wnId: whatsappNumber.wn_id,
        }));
        await redis.expire(debounceKey, 60); // TTL 60s safety net

        // Remove ANY previous debounce job (delayed, waiting, completed, or failed)
        const debounceJobId = `debounce-${empresa_id}-${phone}`;
        try {
          const existingJob = await whatsappQueue.getJob(debounceJobId);
          if (existingJob) {
            await existingJob.remove().catch(() => {});
          }
        } catch (err) {
          // Job may not exist or is active — that's fine
        }

        try {
          await whatsappQueue.add('process-batch', {
            empresa_id,
            phone,
            debounceKey,
          }, {
            jobId: debounceJobId,
            delay: DEBOUNCE_DELAY_MS,
            removeOnComplete: true, // Clean up immediately so jobId can be reused
            removeOnFail: true,
          });

          createLogger.info({ empresa_id, phone, type: message.type, messageId: message.id, delay: DEBOUNCE_DELAY_MS }, 'WhatsApp message debounced');
        } catch (err) {
          if (err.message?.includes('Job already exists')) {
            // Job is currently being processed — message is in Redis and will be picked up
            // by the lock+re-queue mechanism or the next debounce cycle
            createLogger.debug({ messageId: message.id }, 'Debounce job active, message buffered in Redis');
          } else {
            createLogger.error({ err, empresa_id, messageId: message.id }, 'Failed to enqueue debounce job');
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
