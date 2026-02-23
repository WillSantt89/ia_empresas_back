import Fastify from 'fastify';
import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import rateLimit from '@fastify/rate-limit';
import sensible from '@fastify/sensible';
import { config } from './config/env.js';
import { logger } from './config/logger.js';
import { testConnection, closePool } from './config/database.js';
import { testRedisConnection, closeRedis } from './config/redis.js';

// Import middlewares
import { authMiddleware, webhookAuthMiddleware } from './middleware/auth.js';
import { tenantMiddleware } from './middleware/tenant.js';

// Import routes
import authRoutes from './routes/auth.js';

// Create Fastify instance
const fastify = Fastify({
  logger: logger,
  trustProxy: true,
  requestIdHeader: 'x-request-id',
  requestIdLogLabel: 'requestId',
  disableRequestLogging: false,
  ajv: {
    customOptions: {
      removeAdditional: 'all',
      coerceTypes: true,
      useDefaults: true,
    },
  },
});

// Register plugins
async function registerPlugins() {
  // CORS
  await fastify.register(cors, {
    origin: config.CORS_ORIGIN,
    credentials: config.CORS_CREDENTIALS,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  });

  // JWT
  await fastify.register(jwt, {
    secret: config.JWT_SECRET,
    sign: {
      expiresIn: config.JWT_EXPIRES_IN,
    },
    verify: {
      maxAge: config.JWT_EXPIRES_IN,
    },
  });

  // Rate Limiting
  await fastify.register(rateLimit, {
    global: true,
    max: config.RATE_LIMIT_MAX_REQUESTS,
    timeWindow: config.RATE_LIMIT_WINDOW_MS,
    cache: 10000,
    skipOnError: false,
    keyGenerator: (request) => {
      return request.headers['x-empresa-id'] || request.ip;
    },
    errorResponseBuilder: (request, context) => {
      return {
        success: false,
        error: {
          code: 'RATE_LIMIT_EXCEEDED',
          message: `Too many requests, please try again later. Retry after ${context.after}`,
          statusCode: 429,
          retry_after: context.after,
        },
      };
    },
  });

  // Error handling
  await fastify.register(sensible);

  // Register custom authentication decorator
  fastify.decorate('authenticate', authMiddleware);
  fastify.decorate('authenticateWebhook', webhookAuthMiddleware);

  // Add tenant middleware to all routes except public ones
  fastify.addHook('preHandler', tenantMiddleware);
}

// Health check route
fastify.get('/health', {
  config: {
    rateLimit: false,
  },
}, async (request, reply) => {
  const dbHealthy = await testConnection();
  const redisHealthy = await testRedisConnection();

  const status = {
    status: dbHealthy && redisHealthy ? 'healthy' : 'unhealthy',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    services: {
      database: dbHealthy ? 'connected' : 'disconnected',
      redis: redisHealthy ? 'connected' : 'disconnected',
    },
    environment: config.NODE_ENV,
  };

  if (!dbHealthy || !redisHealthy) {
    reply.code(503);
  }

  return status;
});

// Global error handler
fastify.setErrorHandler((error, request, reply) => {
  const { statusCode = 500, validation, code } = error;

  // Log error
  if (statusCode >= 500) {
    logger.error({
      error: {
        message: error.message,
        stack: error.stack,
        code: error.code,
      },
      request: {
        id: request.id,
        method: request.method,
        url: request.url,
        empresa_id: request.empresaId,
        user_id: request.user?.id,
      },
    }, 'Internal server error');
  }

  // Handle validation errors
  if (validation) {
    reply.status(400).send({
      success: false,
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Validation failed',
        details: validation,
      },
    });
    return;
  }

  // Send error response
  reply.status(statusCode).send({
    success: false,
    error: {
      code: code || 'INTERNAL_ERROR',
      message: statusCode < 500 ? error.message : 'Internal server error',
      ...(config.isDevelopment && { stack: error.stack }),
    },
  });
});

// 404 handler
fastify.setNotFoundHandler((request, reply) => {
  reply.status(404).send({
    success: false,
    error: {
      code: 'NOT_FOUND',
      message: 'Route not found',
      path: request.url,
    },
  });
});

// Graceful shutdown
async function gracefulShutdown() {
  logger.info('Starting graceful shutdown...');

  try {
    await fastify.close();
    await closePool();
    await closeRedis();
    logger.info('Graceful shutdown completed');
    process.exit(0);
  } catch (error) {
    logger.error('Error during graceful shutdown:', error);
    process.exit(1);
  }
}

// Handle shutdown signals
process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);

// Uncaught exception handler
process.on('uncaughtException', (error) => {
  logger.fatal(error, 'Uncaught exception');
  process.exit(1);
});

// Unhandled rejection handler
process.on('unhandledRejection', (reason, promise) => {
  logger.fatal({ reason, promise }, 'Unhandled rejection');
  process.exit(1);
});

// Start server
async function start() {
  try {
    // Register plugins
    await registerPlugins();

    // Test database and Redis connections
    const dbConnected = await testConnection();
    const redisConnected = await testRedisConnection();

    if (!dbConnected || !redisConnected) {
      throw new Error('Failed to connect to required services');
    }

    // Register routes
    await fastify.register(authRoutes, { prefix: '/api/auth' });

    // TODO: Register other routes as they are created
    // await fastify.register(chatRoutes, { prefix: '/api/chat' });
    // await fastify.register(agentesRoutes, { prefix: '/api/agentes' });
    // etc...

    // Start listening
    await fastify.listen({
      port: config.PORT,
      host: '0.0.0.0',
    });

    logger.info(`Server listening on port ${config.PORT} in ${config.NODE_ENV} mode`);
  } catch (error) {
    logger.fatal(error, 'Failed to start server');
    process.exit(1);
  }
}

// Start the server
start();