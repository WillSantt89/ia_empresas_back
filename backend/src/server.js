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
import { requirePermission } from './middleware/permission.js';
import { checkLimit } from './middleware/limit.js';
import { globalRateLimit, setupRouteRateLimits } from './middleware/rate-limit.js';

// Import routes
import healthRoutes from './routes/health.js';
import authRoutes from './routes/auth.js';
import chatRoutes from './routes/chat.js';
import webhookRoutes from './routes/webhooks/index.js';
import empresasRoutes from './routes/empresas.js';
import usuariosRoutes from './routes/usuarios.js';
import agentesRoutes from './routes/agentes.js';
import toolsRoutes from './routes/tools.js';
import apiKeysRoutes from './routes/api-keys.js';
import chatwootConfigRoutes from './routes/chatwoot-config.js';
import analyticsRoutes from './routes/analytics.js';
import planosRoutes from './routes/planos.js';
import itensCobraveisRoutes from './routes/itens-cobraveis.js';
import assinaturasRoutes from './routes/assinaturas.js';
import promptsRoutes from './routes/prompts.js';
import transferenciasRoutes from './routes/transferencias.js';
import agenteToolsRoutes from './routes/agente-tools.js';
import inboxesRoutes from './routes/inboxes.js';
import whatsappNumbersRoutes from './routes/whatsapp-numbers.js';
import conversasRoutes from './routes/conversas.js';
import dashboardRoutes from './routes/dashboard.js';
import logsRoutes from './routes/logs.js';
import configuracoesRoutes from './routes/configuracoes.js';
import notificacoesRoutes from './routes/notificacoes.js';

// Import jobs
import timeoutChecker from './jobs/timeout-checker.js';
import dailyReset from './jobs/daily-reset.js';

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
  await fastify.register(rateLimit, globalRateLimit);

  // Error handling
  await fastify.register(sensible);

  // Register custom authentication decorator
  fastify.decorate('authenticate', authMiddleware);
  fastify.decorate('authenticateWebhook', webhookAuthMiddleware);
  fastify.decorate('requirePermission', requirePermission);
  fastify.decorate('checkLimit', checkLimit);
  fastify.decorate('addTenantFilter', tenantMiddleware);

  // Setup route-specific rate limits
  setupRouteRateLimits(fastify);

  // Add raw body parser for webhook signature validation
  fastify.addContentTypeParser('application/json', { parseAs: 'string' }, function (req, body, done) {
    try {
      const json = JSON.parse(body);
      done(null, json);
    } catch (err) {
      err.statusCode = 400;
      done(err, undefined);
    }
  });

  fastify.addHook('preHandler', async (request, reply) => {
    // Store raw body for webhook signature validation
    if (request.routeOptions.config?.rawBody && request.body) {
      request.rawBody = request.payload || JSON.stringify(request.body);
    }
  });
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
    await fastify.register(healthRoutes);  // Health routes without prefix
    await fastify.register(authRoutes, { prefix: '/api/auth' });
    await fastify.register(chatRoutes, { prefix: '/api/chat' });
    await fastify.register(webhookRoutes, { prefix: '/api/webhooks' });
    await fastify.register(empresasRoutes, { prefix: '/api/empresas' });
    await fastify.register(usuariosRoutes, { prefix: '/api/usuarios' });
    await fastify.register(agentesRoutes, { prefix: '/api/agentes' });
    await fastify.register(toolsRoutes, { prefix: '/api/tools' });
    await fastify.register(apiKeysRoutes, { prefix: '/api/api-keys' });
    await fastify.register(chatwootConfigRoutes, { prefix: '/api/chatwoot-config' });
    await fastify.register(analyticsRoutes, { prefix: '/api/analytics' });
    await fastify.register(planosRoutes, { prefix: '/api/planos' });
    await fastify.register(itensCobraveisRoutes, { prefix: '/api/itens-cobraveis' });
    await fastify.register(assinaturasRoutes, { prefix: '/api/assinaturas' });
    await fastify.register(promptsRoutes, { prefix: '/api/agentes' });
    await fastify.register(transferenciasRoutes, { prefix: '/api' });
    await fastify.register(agenteToolsRoutes, { prefix: '/api/agentes' });
    await fastify.register(inboxesRoutes, { prefix: '/api/inboxes' });
    await fastify.register(whatsappNumbersRoutes, { prefix: '/api/whatsapp-numbers' });
    await fastify.register(conversasRoutes, { prefix: '/api/conversas' });
    await fastify.register(dashboardRoutes, { prefix: '/api/dashboard' });
    await fastify.register(logsRoutes, { prefix: '/api/logs' });
    await fastify.register(configuracoesRoutes, { prefix: '/api/configuracoes' });
    await fastify.register(notificacoesRoutes, { prefix: '/api/notificacoes' });

    // Start listening
    await fastify.listen({
      port: config.PORT,
      host: '0.0.0.0',
    });

    logger.info(`Server listening on port ${config.PORT} in ${config.NODE_ENV} mode`);

    // Start background jobs
    timeoutChecker.start();
    dailyReset.start();
    logger.info('Background jobs started');
  } catch (error) {
    logger.fatal(error, 'Failed to start server');
    process.exit(1);
  }
}

// Start the server
start();