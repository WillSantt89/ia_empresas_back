/**
 * BullMQ Message Workers
 *
 * Processes WhatsApp and n8n message jobs from queues.
 * Each worker instance handles WORKER_CONCURRENCY jobs in parallel.
 *
 * WhatsApp messages use debounce: multiple rapid messages from the same
 * contact are accumulated in Redis and processed as a single batch.
 */
import { Worker } from 'bullmq';
import { REDIS_CONNECTION, QUEUE_NAMES, WORKER_CONCURRENCY } from '../queues/config.js';
import { deadLetterQueue } from '../queues/queues.js';
import { processWhatsAppBatch, processN8nMessage } from '../services/message-processor.js';
import { redis } from '../config/redis.js';
import { logger } from '../config/logger.js';

const createLogger = logger.child({ module: 'message-worker' });

// Lock TTL — max time a conversation can be locked (safety net)
const LOCK_TTL_MS = 300000; // 5 min

// WhatsApp message worker
export const whatsappWorker = new Worker(
  QUEUE_NAMES.WHATSAPP_MESSAGE,
  async (job) => {
    const { empresa_id, phone, debounceKey } = job.data;

    // --- Acquire lock per conversation (phone + empresa) ---
    const lockKey = `lock:conv:${empresa_id}:${phone}`;
    const lockAcquired = await redis.set(lockKey, job.id, 'PX', LOCK_TTL_MS, 'NX');

    if (!lockAcquired) {
      // Another job is processing this conversation — re-enqueue with small delay
      createLogger.info({ jobId: job.id, phone, empresa_id }, 'Conversation locked, re-queuing');
      const { whatsappQueue } = await import('../queues/queues.js');
      await whatsappQueue.add('process-batch', { empresa_id, phone, debounceKey }, {
        delay: 5000, // wait 5s and try again
      });
      return;
    }

    try {
      // --- Read all accumulated messages from Redis ---
      const rawMessages = await redis.lrange(debounceKey, 0, -1);
      await redis.del(debounceKey); // Clear immediately to avoid re-processing

      if (!rawMessages || rawMessages.length === 0) {
        createLogger.debug({ jobId: job.id, phone }, 'No messages in debounce buffer');
        return;
      }

      const batch = rawMessages.map(raw => JSON.parse(raw));

      createLogger.info({
        jobId: job.id,
        empresa_id,
        phone,
        batchSize: batch.length,
        attempt: job.attemptsMade + 1,
      }, 'Processing WhatsApp batch');

      await processWhatsAppBatch(batch);
    } finally {
      // Always release lock
      await redis.del(lockKey);
    }
  },
  {
    connection: REDIS_CONNECTION,
    concurrency: WORKER_CONCURRENCY,
    lockDuration: 300000, // 5 min — tools podem demorar até 120s + Gemini thinking + múltiplas iterações
    stalledInterval: 300000, // checar stalled jobs a cada 5 min
  }
);

// n8n message worker
export const n8nWorker = new Worker(
  QUEUE_NAMES.N8N_MESSAGE,
  async (job) => {
    const { message, phone, name, phoneNumberId, empresa_id, agentId, metadata, n8nResponseUrl, webhookToken } = job.data;
    createLogger.info('Processing n8n job', {
      jobId: job.id,
      empresa_id,
      phone,
      attempt: job.attemptsMade + 1,
    });

    await processN8nMessage({ message, phone, name, phoneNumberId, empresa_id, agentId, metadata, n8nResponseUrl, webhookToken });
  },
  {
    connection: REDIS_CONNECTION,
    concurrency: WORKER_CONCURRENCY,
    lockDuration: 300000,
    stalledInterval: 300000,
  }
);

// --- Event handlers ---

whatsappWorker.on('completed', (job) => {
  createLogger.debug('WhatsApp job completed', { jobId: job.id });
});

whatsappWorker.on('failed', async (job, err) => {
  createLogger.error(`WhatsApp job failed: ${err.message} | jobId=${job?.id} attempt=${job?.attemptsMade}/${job?.opts?.attempts || 3} | ${err.stack?.split('\n')[1]?.trim() || ''}`);

  // Release lock on failure
  if (job?.data?.empresa_id && job?.data?.phone) {
    const lockKey = `lock:conv:${job.data.empresa_id}:${job.data.phone}`;
    await redis.del(lockKey).catch(() => {});
  }

  // Move to dead letter queue after all retries exhausted
  if (job && job.attemptsMade >= (job.opts?.attempts || 3)) {
    try {
      await deadLetterQueue.add('failed-whatsapp', {
        originalJob: job.data,
        error: err.message,
        stack: err.stack,
        failedAt: new Date().toISOString(),
        attempts: job.attemptsMade,
      });
      createLogger.warn('Job moved to dead letter queue', { jobId: job.id });
    } catch (dlqErr) {
      createLogger.error('Failed to add to DLQ', { error: dlqErr.message });
    }
  }
});

n8nWorker.on('completed', (job) => {
  createLogger.debug('n8n job completed', { jobId: job.id });
});

n8nWorker.on('failed', async (job, err) => {
  createLogger.error(`n8n job failed: ${err.message} | jobId=${job?.id} attempt=${job?.attemptsMade}/${job?.opts?.attempts || 3} | ${err.stack?.split('\n')[1]?.trim() || ''}`);

  if (job && job.attemptsMade >= (job.opts?.attempts || 3)) {
    try {
      await deadLetterQueue.add('failed-n8n', {
        originalJob: job.data,
        error: err.message,
        stack: err.stack,
        failedAt: new Date().toISOString(),
        attempts: job.attemptsMade,
      });
    } catch (dlqErr) {
      createLogger.error('Failed to add to DLQ', { error: dlqErr.message });
    }
  }
});

// Graceful shutdown
export async function closeWorkers() {
  createLogger.info('Closing workers...');
  await whatsappWorker.close();
  await n8nWorker.close();
  createLogger.info('Workers closed');
}
