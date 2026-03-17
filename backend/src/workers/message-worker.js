/**
 * BullMQ Message Workers
 *
 * Processes WhatsApp and n8n message jobs from queues.
 * Each worker instance handles WORKER_CONCURRENCY jobs in parallel.
 */
import { Worker } from 'bullmq';
import { REDIS_CONNECTION, QUEUE_NAMES, WORKER_CONCURRENCY } from '../queues/config.js';
import { deadLetterQueue } from '../queues/queues.js';
import { processWhatsAppMessage, processN8nMessage } from '../services/message-processor.js';
import { logger } from '../config/logger.js';

const createLogger = logger.child({ module: 'message-worker' });

// WhatsApp message worker
export const whatsappWorker = new Worker(
  QUEUE_NAMES.WHATSAPP_MESSAGE,
  async (job) => {
    const { message, contacts, phoneNumberId, empresa_id, wnId } = job.data;
    createLogger.info('Processing WhatsApp job', {
      jobId: job.id,
      empresa_id,
      phone: message?.from,
      attempt: job.attemptsMade + 1,
    });

    await processWhatsAppMessage({ message, contacts, phoneNumberId, empresa_id, wnId });
  },
  {
    connection: REDIS_CONNECTION,
    concurrency: WORKER_CONCURRENCY,
    lockDuration: 180000, // 3 min — tools podem demorar até 120s + tempo do Gemini
    stalledInterval: 180000, // checar stalled jobs a cada 3 min
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
    lockDuration: 180000,
    stalledInterval: 180000,
  }
);

// --- Event handlers ---

whatsappWorker.on('completed', (job) => {
  createLogger.debug('WhatsApp job completed', { jobId: job.id });
});

whatsappWorker.on('failed', async (job, err) => {
  createLogger.error(`WhatsApp job failed: ${err.message} | jobId=${job?.id} attempt=${job?.attemptsMade}/${job?.opts?.attempts || 3} | ${err.stack?.split('\n')[1]?.trim() || ''}`);

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
