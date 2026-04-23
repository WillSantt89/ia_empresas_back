import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import jwt from '@fastify/jwt';
import rateLimit from '@fastify/rate-limit';
import sensible from '@fastify/sensible';
import multipart from '@fastify/multipart';
import { config } from './config/env.js';
import { logger } from './config/logger.js';
import { testConnection, closePool, query, pool } from './config/database.js';
import { testRedisConnection, closeRedis } from './config/redis.js';
import { readdir, readFile } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

// Import middlewares
import { authMiddleware, webhookAuthMiddleware } from './middleware/auth.js';
import { tenantMiddleware } from './middleware/tenant.js';
import { requirePermission } from './middleware/permission.js';
import { checkLimit } from './middleware/limit.js';
import { globalRateLimit, setupRouteRateLimits } from './middleware/rate-limit.js';
import { encrypt, decrypt } from './config/encryption.js';

// Import routes
import healthRoutes from './routes/health.js';
import authRoutes from './routes/auth.js';
import chatRoutes from './routes/chat.js';
import webhookRoutes from './routes/webhooks/index.js';
import empresasRoutes from './routes/empresas.js';
import usuariosRoutes from './routes/usuarios.js';
import agentesRoutes from './routes/agentes.js';
import toolsRoutes from './routes/tools.js';
import toolExecutionsRoutes from './routes/tool-executions.js';
import apiKeysRoutes from './routes/api-keys.js';
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
import filasRoutes from './routes/filas.js';
import labelsRoutes from './routes/labels.js';
import contatosRoutes from './routes/contatos.js';
import mediaRoutes from './routes/media.js';
import camposPersonalizadosRoutes from './routes/campos-personalizados.js';
import configFollowupRoutes from './routes/config-followup.js';
import chatbotFluxosRoutes from './routes/chatbot-fluxos.js';
import respostasProntasRoutes from './routes/respostas-prontas.js';
import creditosIaRoutes from './routes/creditos-ia.js';
import automacoesEntradaRoutes from './routes/automacoes-entrada.js';
import regrasRoteamentoRoutes from './routes/regras-roteamento.js';
import metaOficialRoutes from './routes/meta-oficial.js';

// Import WebSocket
import { initializeWebSocket } from './services/websocket.js';

// Import jobs
import timeoutChecker from './jobs/timeout-checker.js';
import dailyReset from './jobs/daily-reset.js';
import followupChecker from './jobs/followup-checker.js';
import cacheMonitor from './jobs/cache-monitor.js';

// Import Bull Board (queue dashboard)
import { createBullBoard } from '@bull-board/api';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter.js';
import { FastifyAdapter } from '@bull-board/fastify';
import { whatsappQueue, n8nQueue, metaQueue, bulkOperationsQueue, deadLetterQueue, waitForQueues } from './queues/queues.js';

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
  // Security headers (helmet)
  await fastify.register(helmet, {
    contentSecurityPolicy: false, // CSP managed separately if needed
    crossOriginResourcePolicy: { policy: 'cross-origin' }, // allow media loading
    hsts: {
      maxAge: 31536000, // 1 year
      includeSubDomains: true,
      preload: true,
    },
  });

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

  // Multipart (file uploads)
  await fastify.register(multipart, {
    limits: {
      fileSize: 25 * 1024 * 1024, // 25MB
      files: 1,
    },
  });

  // Error handling
  await fastify.register(sensible);

  // Register custom authentication decorator
  fastify.decorate('authenticate', authMiddleware);
  fastify.decorate('authenticateWebhook', webhookAuthMiddleware);
  fastify.decorate('requirePermission', requirePermission);
  fastify.decorate('checkLimit', checkLimit);
  fastify.decorate('addTenantFilter', tenantMiddleware);
  fastify.decorate('encrypt', encrypt);
  fastify.decorate('decrypt', decrypt);

  // Setup route-specific rate limits
  setupRouteRateLimits(fastify);

  // Add raw body parser for webhook signature validation (HMAC)
  // Stores raw string on req.rawBody before JSON parsing
  fastify.addContentTypeParser('application/json', { parseAs: 'string' }, function (req, body, done) {
    req.rawBody = body; // Store original raw body on Node.js IncomingMessage
    try {
      const json = JSON.parse(body);
      done(null, json);
    } catch (err) {
      err.statusCode = 400;
      done(err, undefined);
    }
  });
}

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

    // Auto-run pending migrations on startup
    try {
      const __filename_s = fileURLToPath(import.meta.url);
      const __dirname_s = dirname(__filename_s);
      const migrationsDir = join(__dirname_s, '../migrations');
      const client = await pool.connect();
      try {
        await client.query(`
          CREATE TABLE IF NOT EXISTS _migrations (
            id SERIAL PRIMARY KEY,
            name VARCHAR(255) NOT NULL UNIQUE,
            executed_at TIMESTAMPTZ DEFAULT NOW()
          )
        `);
        const files = (await readdir(migrationsDir)).filter(f => f.endsWith('.sql')).sort();
        const { rows: executedMigrations } = await client.query('SELECT name FROM _migrations');
        const executed = new Set(executedMigrations.map(m => m.name));
        let migrationsRun = 0;
        for (const file of files) {
          if (!executed.has(file)) {
            try {
              await client.query('BEGIN');
              logger.info(`Running migration: ${file}`);
              const sql = await readFile(join(migrationsDir, file), 'utf-8');
              await client.query(sql);
              await client.query('INSERT INTO _migrations (name) VALUES ($1)', [file]);
              await client.query('COMMIT');
              logger.info(`Migration ${file} completed`);
              migrationsRun++;
            } catch (migErr) {
              await client.query('ROLLBACK');
              logger.error({ err: migErr, file }, `Auto-migrate: migration ${file} failed — skipping`);
            }
          }
        }
        if (migrationsRun > 0) {
          logger.info(`Auto-migrate: ${migrationsRun} migration(s) applied`);
        }
      } catch (migErr) {
        logger.error({ err: migErr }, 'Auto-migrate failed — continuing startup');
      } finally {
        client.release();
      }
    } catch (migOuter) {
      logger.error({ err: migOuter }, 'Auto-migrate setup error — continuing startup');
    }

    // Test BullMQ queue connections
    const queuesReady = await waitForQueues();
    if (!queuesReady) {
      throw new Error('Failed to connect BullMQ queues to Redis');
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
    await fastify.register(toolExecutionsRoutes, { prefix: '/api/tool-executions' });
    await fastify.register(apiKeysRoutes, { prefix: '/api/api-keys' });
    await fastify.register(analyticsRoutes, { prefix: '/api/analytics' });
    await fastify.register(planosRoutes, { prefix: '/api/planos' });
    await fastify.register(itensCobraveisRoutes, { prefix: '/api/itens-cobraveis' });
    await fastify.register(assinaturasRoutes, { prefix: '/api/assinaturas' });
    await fastify.register(creditosIaRoutes, { prefix: '/api/creditos-ia' });
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
    await fastify.register(filasRoutes, { prefix: '/api/filas' });
    await fastify.register(labelsRoutes, { prefix: '/api/labels' });
    await fastify.register(contatosRoutes, { prefix: '/api/contatos' });
    await fastify.register(mediaRoutes, { prefix: '/api/media' });
    await fastify.register(camposPersonalizadosRoutes, { prefix: '/api/campos-personalizados' });
    await fastify.register(configFollowupRoutes, { prefix: '/api/config-followup' });
    await fastify.register(chatbotFluxosRoutes, { prefix: '/api/chatbot-fluxos' });
    await fastify.register(respostasProntasRoutes, { prefix: '/api/respostas-prontas' });
    await fastify.register(automacoesEntradaRoutes, { prefix: '/api/automacoes-entrada' });
    await fastify.register(regrasRoteamentoRoutes, { prefix: '/api/regras-roteamento' });
    await fastify.register(metaOficialRoutes, { prefix: '/api/meta' });

    // Bull Board dashboard (queue monitoring) — master only
    const serverAdapter = new FastifyAdapter();
    createBullBoard({
      queues: [
        new BullMQAdapter(whatsappQueue),
        new BullMQAdapter(n8nQueue),
        new BullMQAdapter(metaQueue),
        new BullMQAdapter(bulkOperationsQueue),
        new BullMQAdapter(deadLetterQueue),
      ],
      serverAdapter,
    });
    serverAdapter.setBasePath('/admin/queues');
    await fastify.register(async (instance) => {
      instance.addHook('onRequest', async (request, reply) => {
        try {
          // Accept token via: query param → cookie → Authorization header
          const queryToken = request.query.token;
          const cookieToken = request.headers.cookie?.split(';')
            .map(c => c.trim())
            .find(c => c.startsWith('bull_token='))
            ?.split('=')[1];
          const authHeader = request.headers.authorization;

          const token = queryToken || cookieToken || (authHeader?.startsWith('Bearer ') ? authHeader.substring(7) : null);

          if (!token) {
            return reply.code(401).send({ error: 'Acesso negado. Use ?token=SEU_JWT_TOKEN na URL' });
          }

          request.headers.authorization = `Bearer ${token}`;
          const decoded = await request.jwtVerify();
          const { rows } = await query(
            'SELECT role FROM usuarios WHERE id = $1 AND ativo = true',
            [decoded.id]
          );
          if (!rows.length || rows[0].role !== 'master') {
            return reply.code(403).send({ error: 'Acesso restrito a master' });
          }

          // Set session cookie so Bull Board AJAX calls work
          if (queryToken && !cookieToken) {
            reply.header('Set-Cookie', `bull_token=${token}; Path=/admin/queues; HttpOnly; SameSite=Strict; Max-Age=86400`);
          }
        } catch (err) {
          // Clear invalid cookie
          reply.header('Set-Cookie', 'bull_token=; Path=/admin/queues; Max-Age=0');
          return reply.code(401).send({ error: 'Token inválido ou expirado' });
        }
      });
      await instance.register(serverAdapter.registerPlugin());
    }, { prefix: '/admin/queues' });
    logger.info('Bull Board dashboard registered at /admin/queues (master only)');

    // Start listening
    await fastify.listen({
      port: config.PORT,
      host: '0.0.0.0',
    });

    // Initialize WebSocket after server is listening
    initializeWebSocket(fastify.server);

    logger.info(`Server listening on port ${config.PORT} in ${config.NODE_ENV} mode`);

    // Start background jobs
    timeoutChecker.start();
    dailyReset.start();
    followupChecker.start();
    cacheMonitor.start();
    logger.info('Background jobs started');
  } catch (error) {
    logger.fatal(error, 'Failed to start server');
    process.exit(1);
  }
}

// Start the server
start();