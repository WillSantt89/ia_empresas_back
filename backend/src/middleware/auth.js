import { query } from '../config/database.js';
import { logger } from '../config/logger.js';
import { ERROR_CODES } from '../config/constants.js';

/**
 * JWT Authentication Middleware
 * Validates JWT token and loads user data
 */
export async function authMiddleware(request, reply) {
  try {
    // Skip auth for public routes
    const publicRoutes = [
      '/health',
      '/api/auth/login',
      '/api/auth/forgot-password',
      '/api/auth/reset-password',
      '/api/chat', // Chat uses webhook API key instead
      '/api/webhook/chatwoot'
    ];

    if (publicRoutes.some(route => request.url.startsWith(route))) {
      return;
    }

    // Extract token from header
    const authHeader = request.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new Error('Token não fornecido');
    }

    const token = authHeader.substring(7);

    // Verify JWT token
    let payload;
    try {
      payload = await request.jwtVerify(token);
    } catch (jwtError) {
      if (jwtError.code === 'FST_JWT_EXPIRED') {
        const error = new Error('Token expirado');
        error.code = ERROR_CODES.AUTH_TOKEN_EXPIRED;
        error.statusCode = 401;
        throw error;
      }
      const error = new Error('Token inválido');
      error.code = ERROR_CODES.AUTH_TOKEN_INVALID;
      error.statusCode = 401;
      throw error;
    }

    // Load user from database
    const { rows } = await query(
      `SELECT
        u.id,
        u.empresa_id,
        u.nome,
        u.email,
        u.role,
        u.ativo,
        e.nome as empresa_nome,
        e.slug as empresa_slug,
        e.ativo as empresa_ativa
      FROM usuarios u
      LEFT JOIN empresas e ON e.id = u.empresa_id
      WHERE u.id = $1`,
      [payload.id]
    );

    if (rows.length === 0) {
      const error = new Error('Usuário não encontrado');
      error.code = ERROR_CODES.AUTH_USER_NOT_FOUND;
      error.statusCode = 401;
      throw error;
    }

    const user = rows[0];

    // Check if user is active
    if (!user.ativo) {
      const error = new Error('Usuário inativo');
      error.code = ERROR_CODES.AUTH_USER_INACTIVE;
      error.statusCode = 401;
      throw error;
    }

    // Check if company is active (for non-master users)
    if (user.empresa_id && !user.empresa_ativa) {
      const error = new Error('Empresa inativa');
      error.code = ERROR_CODES.AUTH_USER_INACTIVE;
      error.statusCode = 401;
      throw error;
    }

    // Attach user to request
    request.user = {
      id: user.id,
      empresa_id: user.empresa_id,
      nome: user.nome,
      email: user.email,
      role: user.role,
      empresa_nome: user.empresa_nome,
      empresa_slug: user.empresa_slug
    };

    logger.debug('User authenticated', {
      user_id: user.id,
      role: user.role,
      empresa_id: user.empresa_id
    });

  } catch (error) {
    logger.warn('Authentication failed', {
      error: error.message,
      code: error.code,
      ip: request.ip,
      url: request.url
    });

    reply.code(error.statusCode || 401).send({
      success: false,
      error: {
        code: error.code || ERROR_CODES.AUTH_INVALID_CREDENTIALS,
        message: error.message || 'Falha na autenticação'
      }
    });
  }
}

/**
 * Webhook authentication middleware
 * Used for /api/chat and /api/webhook/chatwoot endpoints
 */
export async function webhookAuthMiddleware(request, reply) {
  try {
    const apiKey = request.headers['x-webhook-key'];

    if (!apiKey) {
      throw new Error('Webhook API key não fornecida');
    }

    if (apiKey !== process.env.WEBHOOK_API_KEY) {
      throw new Error('Webhook API key inválida');
    }

    logger.debug('Webhook authenticated', {
      url: request.url,
      ip: request.ip
    });

  } catch (error) {
    logger.warn('Webhook authentication failed', {
      error: error.message,
      ip: request.ip,
      url: request.url
    });

    reply.code(401).send({
      success: false,
      error: {
        code: 'WEBHOOK_AUTH_FAILED',
        message: error.message
      }
    });
  }
}

/**
 * Optional auth middleware
 * Sets user if token is valid but doesn't require it
 */
export async function optionalAuthMiddleware(request, reply) {
  try {
    const authHeader = request.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return; // No token, continue without user
    }

    const token = authHeader.substring(7);

    try {
      const payload = await request.jwtVerify(token);

      // Load user from database
      const { rows } = await query(
        `SELECT
          u.id,
          u.empresa_id,
          u.nome,
          u.email,
          u.role,
          u.ativo
        FROM usuarios u
        WHERE u.id = $1 AND u.ativo = true`,
        [payload.id]
      );

      if (rows.length > 0) {
        request.user = rows[0];
      }
    } catch (jwtError) {
      // Invalid token, continue without user
      logger.debug('Optional auth: invalid token', { error: jwtError.message });
    }
  } catch (error) {
    // Any error in optional auth should not block the request
    logger.error('Optional auth error', { error: error.message });
  }
}