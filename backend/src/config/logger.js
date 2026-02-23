import pino from 'pino';
import { config } from './env.js';

// Configure pino logger
const pinoConfig = {
  level: config.LOG_LEVEL || 'info',
  formatters: {
    level: (label) => {
      return { level: label.toUpperCase() };
    },
    bindings: (bindings) => {
      return {
        pid: bindings.pid,
        host: bindings.hostname,
        node_version: process.version,
      };
    },
  },
  timestamp: pino.stdTimeFunctions.isoTime,
  serializers: {
    req: (req) => ({
      id: req.id,
      method: req.method,
      url: req.url,
      query: req.query,
      params: req.params,
      headers: {
        'user-agent': req.headers['user-agent'],
        'x-forwarded-for': req.headers['x-forwarded-for'],
        'x-empresa-id': req.headers['x-empresa-id'],
      },
      remoteAddress: req.ip,
      empresa_id: req.empresaId,
      user_id: req.user?.id,
    }),
    res: (res) => ({
      statusCode: res.statusCode,
      responseTime: res.responseTime,
    }),
    err: pino.stdSerializers.err,
  },
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers["x-api-key"]',
      'req.headers["x-webhook-key"]',
      'req.body.password',
      'req.body.senha',
      'req.body.api_key',
      'req.body.token',
      '*.password',
      '*.senha',
      '*.api_key',
      '*.token',
      '*.jwt',
    ],
    censor: '[REDACTED]',
  },
};

// Development configuration
if (config.isDevelopment) {
  pinoConfig.transport = {
    target: 'pino-pretty',
    options: {
      colorize: true,
      translateTime: 'HH:MM:ss.l',
      ignore: 'pid,hostname',
      messageFormat: '{msg}',
    },
  };
}

// Create logger instance
export const logger = pino(pinoConfig);

// Create child loggers for different modules
export const createLogger = (module) => {
  return logger.child({ module });
};

// Utility logging functions
export const logDatabaseQuery = (query, params, duration) => {
  logger.debug({
    type: 'database_query',
    query,
    params,
    duration,
  }, 'Database query executed');
};

export const logApiCall = (service, endpoint, duration, success) => {
  logger.info({
    type: 'api_call',
    service,
    endpoint,
    duration,
    success,
  }, `External API call to ${service}`);
};

export const logError = (error, context = {}) => {
  logger.error({
    ...context,
    error: {
      message: error.message,
      stack: error.stack,
      code: error.code,
    },
  }, error.message);
};

// Performance logging
export const logPerformance = (operation, duration, metadata = {}) => {
  const level = duration > 1000 ? 'warn' : 'info';
  logger[level]({
    type: 'performance',
    operation,
    duration,
    ...metadata,
  }, `${operation} took ${duration}ms`);
};

// Audit logging
export const logAudit = (action, userId, empresaId, details = {}) => {
  logger.info({
    type: 'audit',
    action,
    user_id: userId,
    empresa_id: empresaId,
    timestamp: new Date().toISOString(),
    ...details,
  }, `Audit: ${action}`);
};

// Rate limit logging
export const logRateLimit = (identifier, endpoint, remaining) => {
  logger.warn({
    type: 'rate_limit',
    identifier,
    endpoint,
    remaining,
  }, `Rate limit approaching for ${identifier}`);
};

// Export logger instance
export default logger;