import crypto from 'crypto';
import { logger } from '../../config/logger.js';
import { redis } from '../../config/redis.js';
import { metaQueue } from '../../queues/queues.js';
import { processMetaStatuses } from '../../services/meta-message-processor.js';

/**
 * Webhook do canal Meta Oficial (Embedded Signup).
 *
 * Totalmente separado do webhook whatsapp_numbers legado.
 * - HMAC validado contra META_APP_SECRET (app único do Tech Provider wschat)
 * - Verify token: META_WEBHOOK_VERIFY_TOKEN (variável própria — não compartilha com WHATSAPP_VERIFY_TOKEN)
 * - Mensagens → enfileiradas em queue 'meta-message'
 * - Statuses (delivery/read/pricing) → processados direto (billing + update)
 */

const createLogger = logger.child({ module: 'meta-webhook' });

const metaWebhookRoutes = async (fastify) => {
  // GET: verify challenge da Meta
  fastify.get('/', async (request, reply) => {
    const mode = request.query['hub.mode'];
    const token = request.query['hub.verify_token'];
    const challenge = request.query['hub.challenge'];

    const verifyToken = process.env.META_WEBHOOK_VERIFY_TOKEN;
    if (!verifyToken) {
      createLogger.error('META_WEBHOOK_VERIFY_TOKEN não configurado');
      return reply.code(500).send('Server not configured');
    }

    if (mode === 'subscribe' && token === verifyToken) {
      createLogger.info('Meta webhook verificado');
      return reply.code(200).send(challenge);
    }
    createLogger.warn({ mode, tokenMatch: token === verifyToken }, 'Verificação webhook Meta falhou');
    return reply.code(403).send('Verification failed');
  });

  // POST: eventos (messages + statuses)
  fastify.post('/', {
    config: { rawBody: true },
    preParsing: async (request, _reply, payload) => {
      const chunks = [];
      for await (const chunk of payload) chunks.push(chunk);
      const rawBody = Buffer.concat(chunks);
      request.rawBodyBuffer = rawBody;
      const { Readable } = await import('stream');
      return Readable.from(rawBody);
    },
  }, async (request, reply) => {
    try {
      const body = request.body;
      if (!body?.entry?.[0]?.changes?.[0]?.value) {
        return reply.code(200).send('OK');
      }

      // HMAC
      const appSecret = process.env.META_APP_SECRET;
      if (!appSecret) {
        createLogger.error('META_APP_SECRET não configurado — bloqueando webhook');
        return reply.code(500).send('Server not configured');
      }
      const signature = request.headers['x-hub-signature-256'];
      if (!signature) {
        createLogger.warn('Assinatura ausente');
        return reply.code(401).send('Missing signature');
      }
      const rawBody = request.rawBodyBuffer || Buffer.from(JSON.stringify(body));
      const expected = crypto.createHmac('sha256', appSecret).update(rawBody).digest('hex');
      const received = signature.replace('sha256=', '');
      const expBuf = Buffer.from(expected, 'utf8');
      const recBuf = Buffer.from(received, 'utf8');
      if (expBuf.length !== recBuf.length || !crypto.timingSafeEqual(expBuf, recBuf)) {
        createLogger.warn('HMAC inválido');
        return reply.code(401).send('Invalid signature');
      }

      // Processa cada entry/change
      for (const entry of body.entry) {
        for (const change of (entry.changes || [])) {
          const value = change.value || {};
          const phoneNumberId = value.metadata?.phone_number_id;
          if (!phoneNumberId) continue;

          // Statuses (delivery/read/pricing) — síncrono, leve
          if (Array.isArray(value.statuses) && value.statuses.length > 0) {
            processMetaStatuses({ phoneNumberId, statuses: value.statuses })
              .catch(err => createLogger.error({ err }, 'Erro ao processar statuses Meta'));
          }

          // Messages → enqueue
          const messages = value.messages || [];
          const contacts = value.contacts || [];
          for (const message of messages) {
            const dedupKey = `dedup:meta:${message.id}`;
            const novo = await redis.set(dedupKey, '1', 'EX', 300, 'NX');
            if (!novo) continue;

            await metaQueue.add('process-message', {
              phoneNumberId,
              message,
              contacts,
            }, {
              jobId: `meta:${message.id}`,
              removeOnComplete: true,
            });
          }
        }
      }

      return reply.code(200).send('OK');
    } catch (error) {
      createLogger.error({ err: error }, 'Erro webhook Meta');
      return reply.code(200).send('OK');
    }
  });
};

export default metaWebhookRoutes;
