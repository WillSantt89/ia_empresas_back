import { Queue } from 'bullmq';
import { REDIS_CONNECTION, QUEUE_NAMES, DEFAULT_JOB_OPTIONS } from './config.js';

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

// Graceful close
export async function closeQueues() {
  await whatsappQueue.close();
  await n8nQueue.close();
  await deadLetterQueue.close();
}
