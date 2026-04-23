import { Worker } from 'bullmq';
import { REDIS_CONNECTION, QUEUE_NAMES, WORKER_CONCURRENCY } from '../queues/config.js';
import { logger } from '../config/logger.js';
import { processMetaMessage } from '../services/meta-message-processor.js';

/**
 * Meta Message Worker
 *
 * Consome a fila 'meta-message' (canal Meta Oficial, totalmente separado
 * do canal WhatsApp legado) e delega ao meta-message-processor.
 */

const createLogger = logger.child({ module: 'meta-message-worker' });

export const metaWorker = new Worker(
  QUEUE_NAMES.META_MESSAGE,
  async (job) => {
    const { phoneNumberId, message, contacts } = job.data || {};
    if (!phoneNumberId || !message) {
      createLogger.warn({ jobId: job.id }, 'Job Meta sem phoneNumberId/message — descartando');
      return;
    }

    createLogger.info({
      jobId: job.id,
      wamid: message.id,
      type: message.type,
      phoneNumberId,
      attempt: job.attemptsMade + 1,
    }, 'Processando mensagem Meta');

    await processMetaMessage({ phoneNumberId, message, contacts });
  },
  {
    connection: REDIS_CONNECTION,
    concurrency: WORKER_CONCURRENCY,
    lockDuration: 300000,
    stalledInterval: 300000,
  }
);

metaWorker.on('failed', (job, err) => {
  createLogger.error({
    jobId: job?.id,
    err: err.message,
    attempts: job?.attemptsMade,
    wamid: job?.data?.message?.id,
  }, 'Job Meta falhou');
});

metaWorker.on('completed', (job) => {
  createLogger.debug({ jobId: job.id, wamid: job.data?.message?.id }, 'Job Meta completo');
});

export async function closeMetaWorker() {
  await metaWorker.close();
}
