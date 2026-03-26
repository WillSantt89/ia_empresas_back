import { config } from '../config/env.js';

/**
 * BullMQ Queue Configuration
 *
 * BullMQ requires maxRetriesPerRequest: null (different from ioredis default of 3).
 * We parse the same REDIS_URL but create separate connection config.
 */

// Parse Redis URL for BullMQ connection
function parseRedisForBullMQ(url) {
  const redisUrl = new URL(url);
  return {
    host: redisUrl.hostname,
    port: parseInt(redisUrl.port || '6379', 10),
    password: redisUrl.password || undefined,
    username: redisUrl.username || 'default',
    maxRetriesPerRequest: null,  // REQUIRED by BullMQ
    enableReadyCheck: false,     // recommended for BullMQ
  };
}

export const REDIS_CONNECTION = parseRedisForBullMQ(config.REDIS_URL);

// Queue names
export const QUEUE_NAMES = {
  WHATSAPP_MESSAGE: 'whatsapp-message',
  N8N_MESSAGE: 'n8n-message',
  BULK_OPERATIONS: 'bulk-operations',
  DEAD_LETTER: 'dead-letter',
};

// Default job options
export const DEFAULT_JOB_OPTIONS = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 2000 }, // 2s, 4s, 8s
  removeOnComplete: { age: 3600, count: 5000 },  // keep 1h or 5000 completed jobs
  removeOnFail: { age: 86400 },                   // keep failed jobs 24h
};

// Worker concurrency (configurable via env)
export const WORKER_CONCURRENCY = parseInt(process.env.WORKER_CONCURRENCY || '5', 10);
