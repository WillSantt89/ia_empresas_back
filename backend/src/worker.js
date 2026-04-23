/**
 * Worker Entry Point
 *
 * Separate process that processes BullMQ jobs.
 * Run with: node src/worker.js
 *
 * Does NOT start Fastify HTTP server.
 * Uses @socket.io/redis-emitter for WebSocket broadcasts via Redis.
 */
import { config } from './config/env.js';
import { logger } from './config/logger.js';
import { testConnection, closePool } from './config/database.js';
import { testRedisConnection, closeRedis, publisher } from './config/redis.js';
import { setEmitter } from './services/websocket.js';
import { Emitter } from '@socket.io/redis-emitter';
import { closeQueues } from './queues/queues.js';

const createLogger = logger.child({ module: 'worker-main' });

async function startWorker() {
  createLogger.info('Starting BullMQ worker process...', {
    concurrency: process.env.WORKER_CONCURRENCY || 5,
    pid: process.pid,
  });

  // Test connections
  const dbConnected = await testConnection();
  const redisConnected = await testRedisConnection();

  if (!dbConnected || !redisConnected) {
    throw new Error('Failed to connect to required services');
  }

  // Setup Socket.IO Redis Emitter (for WebSocket broadcasts without HTTP server)
  const emitter = new Emitter(publisher);
  setEmitter(emitter);
  createLogger.info('Socket.IO Redis emitter initialized');

  // Import and start workers (auto-registers with BullMQ)
  const { whatsappWorker, n8nWorker, closeWorkers } = await import('./workers/message-worker.js');
  const { bulkOperationsWorker, closeBulkOperationsWorker } = await import('./workers/bulk-operations-worker.js');
  const { metaWorker, closeMetaWorker } = await import('./workers/meta-message-worker.js');

  createLogger.info('Workers started and listening for jobs', {
    queues: ['whatsapp-message', 'n8n-message', 'meta-message', 'bulk-operations'],
  });

  // Graceful shutdown
  async function shutdown() {
    createLogger.info('Starting graceful shutdown...');
    try {
      await closeWorkers();
      await closeBulkOperationsWorker();
      await closeMetaWorker();
      await closeQueues();
      await closePool();
      await closeRedis();
      createLogger.info('Worker shutdown completed');
      process.exit(0);
    } catch (error) {
      createLogger.error('Error during worker shutdown:', error);
      process.exit(1);
    }
  }

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  process.on('uncaughtException', (error) => {
    createLogger.fatal(error, 'Uncaught exception in worker');
    process.exit(1);
  });

  process.on('unhandledRejection', (reason) => {
    createLogger.fatal({ reason }, 'Unhandled rejection in worker');
    process.exit(1);
  });
}

startWorker().catch((error) => {
  createLogger.fatal(error, 'Failed to start worker');
  process.exit(1);
});
