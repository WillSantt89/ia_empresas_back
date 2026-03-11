import { Queue } from 'bullmq';
import { REDIS_CONNECTION, QUEUE_NAMES, DEFAULT_JOB_OPTIONS } from './config.js';
import { logger } from '../config/logger.js';

const queueLogger = logger.child({ module: 'bullmq-queue' });

// WhatsApp message processing queue
export const whatsappQueue = new Queue(QUEUE_NAMES.WHATSAPP_MESSAGE, {
  connection: REDIS_CONNECTION,
  defaultJobOptions: DEFAULT_JOB_OPTIONS,
});

// n8n message processing queue
export const n8nQueue = new Queue(QUEUE_NAMES.N8N_MESSAGE, {
  connection: REDIS_CONNECTION,
  defaultJobOptions: DEFAULT_JOB_OPTIONS,
});

// Dead letter queue for failed jobs (after all retries exhausted)
export const deadLetterQueue = new Queue(QUEUE_NAMES.DEAD_LETTER, {
  connection: REDIS_CONNECTION,
  defaultJobOptions: {
    removeOnComplete: false,
    removeOnFail: { age: 604800 }, // keep 7 days
  },
});

// Log queue connection events
for (const [name, queue] of [['whatsapp', whatsappQueue], ['n8n', n8nQueue], ['dead-letter', deadLetterQueue]]) {
  queue.on('error', (err) => {
    queueLogger.error(`Queue "${name}" error: ${err.message}`, { stack: err.stack });
  });
}

// Wait for all queues to be ready (call during server startup)
export async function waitForQueues() {
  try {
    const clients = await Promise.all([
      whatsappQueue.client,
      n8nQueue.client,
      deadLetterQueue.client,
    ]);
    queueLogger.info('All BullMQ queues connected to Redis', {
      queues: [QUEUE_NAMES.WHATSAPP_MESSAGE, QUEUE_NAMES.N8N_MESSAGE, QUEUE_NAMES.DEAD_LETTER],
    });
    return true;
  } catch (err) {
    queueLogger.error('Failed to connect BullMQ queues to Redis', { error: err.message, stack: err.stack });
    return false;
  }
}

// Graceful close
export async function closeQueues() {
  await whatsappQueue.close();
  await n8nQueue.close();
  await deadLetterQueue.close();
}
