import { pool } from '../config/database.js';
import { redis } from '../config/redis.js';

export default async function healthRoutes(fastify) {
  // Basic health check
  fastify.get('/health', async (request, reply) => {
    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      environment: process.env.NODE_ENV || 'development'
    };
  });

  // Detailed health check
  fastify.get('/health/detailed', async (request, reply) => {
    const health = {
      status: 'ok',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      environment: process.env.NODE_ENV || 'development',
      checks: {
        database: { status: 'unknown' },
        redis: { status: 'unknown' },
        memory: {},
        config: {}
      }
    };

    // Check database
    try {
      const result = await pool.query('SELECT NOW() as time, COUNT(*) as tables FROM information_schema.tables WHERE table_schema = $1', ['public']);
      health.checks.database = {
        status: 'ok',
        time: result.rows[0].time,
        tables: parseInt(result.rows[0].tables)
      };
    } catch (error) {
      health.status = 'degraded';
      health.checks.database = {
        status: 'error',
        error: error.message
      };
    }

    // Check Redis
    try {
      const pong = await redis.ping();
      const info = await redis.info('server');
      const version = info.match(/redis_version:([^\r\n]+)/);

      health.checks.redis = {
        status: pong === 'PONG' ? 'ok' : 'error',
        version: version ? version[1] : 'unknown'
      };
    } catch (error) {
      health.status = 'degraded';
      health.checks.redis = {
        status: 'error',
        error: error.message
      };
    }

    // Memory usage
    const memUsage = process.memoryUsage();
    health.checks.memory = {
      rss: `${Math.round(memUsage.rss / 1024 / 1024)} MB`,
      heapUsed: `${Math.round(memUsage.heapUsed / 1024 / 1024)} MB`,
      heapTotal: `${Math.round(memUsage.heapTotal / 1024 / 1024)} MB`
    };

    // Configuration status
    health.checks.config = {
      port: process.env.PORT || 3000,
      corsOrigin: process.env.CORS_ORIGIN || '*',
      jwtConfigured: !!process.env.JWT_SECRET,
      encryptionConfigured: !!process.env.ENCRYPTION_KEY && process.env.ENCRYPTION_KEY.length === 32,
      webhookConfigured: !!process.env.WEBHOOK_API_KEY
    };

    return health;
  });

  // Liveness probe for k8s
  fastify.get('/health/live', async (request, reply) => {
    return { status: 'alive' };
  });

  // Readiness probe for k8s
  fastify.get('/health/ready', async (request, reply) => {
    try {
      // Quick DB check
      await pool.query('SELECT 1');
      // Quick Redis check
      await redis.ping();

      return { status: 'ready' };
    } catch (error) {
      reply.code(503).send({ status: 'not_ready', error: error.message });
    }
  });
}