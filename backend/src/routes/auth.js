import bcrypt from 'bcrypt';
import { query } from '../config/database.js';
import { generateSecureToken, hash } from '../config/encryption.js';
import { logger } from '../config/logger.js';
import { config } from '../config/env.js';
import { ERROR_CODES } from '../config/constants.js';

/**
 * Authentication routes
 */
export default async function authRoutes(fastify, opts) {
  // Login
  fastify.post('/login', {
    schema: {
      body: {
        type: 'object',
        required: ['email', 'senha'],
        properties: {
          email: { type: 'string', format: 'email' },
          senha: { type: 'string', minLength: 6 }
        }
      },
      response: {
        200: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            data: {
              type: 'object',
              properties: {
                token: { type: 'string' },
                refreshToken: { type: 'string' },
                usuario: {
                  type: 'object',
                  properties: {
                    id: { type: 'string' },
                    nome: { type: 'string' },
                    email: { type: 'string' },
                    role: { type: 'string' },
                    empresa_id: { type: ['string', 'null'] },
                    empresa_nome: { type: ['string', 'null'] }
                  }
                }
              }
            }
          }
        }
      }
    }
  }, async (request, reply) => {
    try {
      const { email, senha } = request.body;

      // Find user by email
      const { rows } = await query(
        `SELECT
          u.id,
          u.empresa_id,
          u.nome,
          u.email,
          u.senha_hash,
          u.role,
          u.ativo,
          e.nome as empresa_nome,
          e.slug as empresa_slug,
          e.ativo as empresa_ativa
        FROM usuarios u
        LEFT JOIN empresas e ON e.id = u.empresa_id
        WHERE LOWER(u.email) = LOWER($1)
        LIMIT 1`,
        [email]
      );

      if (rows.length === 0) {
        throw new Error('Credenciais inválidas');
      }

      const user = rows[0];

      // Check if user is active
      if (!user.ativo) {
        const error = new Error('Usuário inativo');
        error.code = ERROR_CODES.AUTH_USER_INACTIVE;
        throw error;
      }

      // Check if company is active (for non-master users)
      if (user.empresa_id && !user.empresa_ativa) {
        const error = new Error('Empresa inativa');
        error.code = ERROR_CODES.AUTH_USER_INACTIVE;
        throw error;
      }

      // Verify password
      const validPassword = await bcrypt.compare(senha, user.senha_hash);
      if (!validPassword) {
        throw new Error('Credenciais inválidas');
      }

      // Generate tokens
      const tokenPayload = {
        id: user.id,
        empresa_id: user.empresa_id,
        role: user.role
      };

      const token = fastify.jwt.sign(tokenPayload, {
        expiresIn: config.JWT_EXPIRES_IN
      });

      const refreshToken = fastify.jwt.sign(
        { ...tokenPayload, type: 'refresh' },
        { expiresIn: config.JWT_REFRESH_EXPIRES_IN }
      );

      // Update last login
      await query(
        'UPDATE usuarios SET ultimo_login = NOW() WHERE id = $1',
        [user.id]
      );

      logger.info('User logged in', {
        user_id: user.id,
        email: user.email,
        role: user.role
      });

      return {
        success: true,
        data: {
          token,
          refreshToken,
          usuario: {
            id: user.id,
            nome: user.nome,
            email: user.email,
            role: user.role,
            empresa_id: user.empresa_id,
            empresa_nome: user.empresa_nome
          }
        }
      };

    } catch (error) {
      logger.warn('Login failed', {
        email: request.body.email,
        error: error.message,
        ip: request.ip
      });

      reply.code(401).send({
        success: false,
        error: {
          code: error.code || ERROR_CODES.AUTH_INVALID_CREDENTIALS,
          message: 'Credenciais inválidas'
        }
      });
    }
  });

  // Refresh token
  fastify.post('/refresh', {
    schema: {
      body: {
        type: 'object',
        required: ['refreshToken'],
        properties: {
          refreshToken: { type: 'string' }
        }
      }
    }
  }, async (request, reply) => {
    try {
      const { refreshToken } = request.body;

      // Verify refresh token
      let payload;
      try {
        payload = fastify.jwt.verify(refreshToken);
      } catch (error) {
        throw new Error('Refresh token inválido');
      }

      // Check if it's a refresh token
      if (payload.type !== 'refresh') {
        throw new Error('Token inválido');
      }

      // Check if user still exists and is active
      const { rows } = await query(
        'SELECT id, ativo FROM usuarios WHERE id = $1',
        [payload.id]
      );

      if (rows.length === 0 || !rows[0].ativo) {
        throw new Error('Usuário não encontrado ou inativo');
      }

      // Generate new tokens
      const newTokenPayload = {
        id: payload.id,
        empresa_id: payload.empresa_id,
        role: payload.role
      };

      const newToken = fastify.jwt.sign(newTokenPayload, {
        expiresIn: config.JWT_EXPIRES_IN
      });

      const newRefreshToken = fastify.jwt.sign(
        { ...newTokenPayload, type: 'refresh' },
        { expiresIn: config.JWT_REFRESH_EXPIRES_IN }
      );

      return {
        success: true,
        data: {
          token: newToken,
          refreshToken: newRefreshToken
        }
      };

    } catch (error) {
      logger.warn('Token refresh failed', {
        error: error.message,
        ip: request.ip
      });

      reply.code(401).send({
        success: false,
        error: {
          code: ERROR_CODES.AUTH_TOKEN_INVALID,
          message: error.message
        }
      });
    }
  });

  // Get current user
  fastify.get('/me', {
    preHandler: [fastify.authenticate]
  }, async (request, reply) => {
    try {
      const userId = request.user.id;

      // Get full user data
      const { rows } = await query(
        `SELECT
          u.id,
          u.empresa_id,
          u.nome,
          u.email,
          u.role,
          u.ativo,
          u.criado_em,
          u.ultimo_login,
          e.id as empresa_id,
          e.nome as empresa_nome,
          e.slug as empresa_slug,
          e.logo_url as empresa_logo,
          p.nome as plano_nome
        FROM usuarios u
        LEFT JOIN empresas e ON e.id = u.empresa_id
        LEFT JOIN planos p ON p.id = e.plano_id
        WHERE u.id = $1`,
        [userId]
      );

      if (rows.length === 0) {
        throw new Error('Usuário não encontrado');
      }

      const user = rows[0];

      const response = {
        id: user.id,
        nome: user.nome,
        email: user.email,
        role: user.role,
        criado_em: user.criado_em,
        ultimo_login: user.ultimo_login,
        is_master: user.role === 'master'
      };

      // Add company info for non-master users
      if (user.empresa_id) {
        response.empresa = {
          id: user.empresa_id,
          nome: user.empresa_nome,
          slug: user.empresa_slug,
          logo_url: user.empresa_logo,
          plano: user.plano_nome
        };
      }

      return {
        success: true,
        data: response
      };

    } catch (error) {
      logger.error('Get user failed', {
        user_id: request.user.id,
        error: error.message
      });

      reply.code(500).send({
        success: false,
        error: {
          code: ERROR_CODES.INTERNAL_ERROR,
          message: 'Erro ao buscar dados do usuário'
        }
      });
    }
  });

  // Forgot password
  fastify.post('/forgot-password', {
    schema: {
      body: {
        type: 'object',
        required: ['email'],
        properties: {
          email: { type: 'string', format: 'email' }
        }
      }
    }
  }, async (request, reply) => {
    try {
      const { email } = request.body;

      // Find user
      const { rows } = await query(
        'SELECT id, nome FROM usuarios WHERE LOWER(email) = LOWER($1) AND ativo = true',
        [email]
      );

      // Always return success to prevent email enumeration
      if (rows.length === 0) {
        logger.warn('Password reset requested for non-existent email', { email });
        return {
          success: true,
          data: {
            message: 'Se o email existir em nossa base, você receberá instruções para redefinir sua senha.'
          }
        };
      }

      const user = rows[0];

      // Generate reset token
      const resetToken = generateSecureToken();
      const resetTokenHash = hash(resetToken);
      const expiresAt = new Date(Date.now() + 3600000); // 1 hour

      // Save token hash
      await query(
        'UPDATE usuarios SET reset_token_hash = $1, reset_token_expires = $2 WHERE id = $3',
        [resetTokenHash, expiresAt, user.id]
      );

      logger.info('Password reset token generated', {
        user_id: user.id,
        expires_at: expiresAt
      });

      // TODO: Send email with reset link
      // For now, log the token (remove in production)
      if (config.isDevelopment) {
        logger.info('Reset token (dev only)', { token: resetToken });
      }

      return {
        success: true,
        data: {
          message: 'Se o email existir em nossa base, você receberá instruções para redefinir sua senha.',
          ...(config.isDevelopment && { token: resetToken }) // Only in dev
        }
      };

    } catch (error) {
      logger.error('Forgot password failed', {
        email: request.body.email,
        error: error.message
      });

      reply.code(500).send({
        success: false,
        error: {
          code: ERROR_CODES.INTERNAL_ERROR,
          message: 'Erro ao processar solicitação'
        }
      });
    }
  });

  // Reset password
  fastify.post('/reset-password', {
    schema: {
      body: {
        type: 'object',
        required: ['token', 'novaSenha'],
        properties: {
          token: { type: 'string' },
          novaSenha: { type: 'string', minLength: 6 }
        }
      }
    }
  }, async (request, reply) => {
    try {
      const { token, novaSenha } = request.body;

      // Hash the provided token
      const tokenHash = hash(token);

      // Find user with valid token
      const { rows } = await query(
        `SELECT id, nome, email
        FROM usuarios
        WHERE reset_token_hash = $1
          AND reset_token_expires > NOW()
          AND ativo = true`,
        [tokenHash]
      );

      if (rows.length === 0) {
        throw new Error('Token inválido ou expirado');
      }

      const user = rows[0];

      // Hash new password
      const senhaHash = await bcrypt.hash(novaSenha, 12);

      // Update password and clear reset token
      await query(
        `UPDATE usuarios
        SET senha_hash = $1,
            reset_token_hash = NULL,
            reset_token_expires = NULL
        WHERE id = $2`,
        [senhaHash, user.id]
      );

      logger.info('Password reset successful', {
        user_id: user.id,
        email: user.email
      });

      return {
        success: true,
        data: {
          message: 'Senha alterada com sucesso'
        }
      };

    } catch (error) {
      logger.warn('Password reset failed', {
        error: error.message,
        ip: request.ip
      });

      reply.code(400).send({
        success: false,
        error: {
          code: ERROR_CODES.INVALID_REQUEST,
          message: error.message
        }
      });
    }
  });

  // Logout (optional - JWT is stateless)
  fastify.post('/logout', {
    preHandler: [fastify.authenticate]
  }, async (request, reply) => {
    // In a stateless JWT system, logout is handled client-side
    // This endpoint exists for consistency and future enhancements

    logger.info('User logged out', {
      user_id: request.user.id
    });

    return {
      success: true,
      data: {
        message: 'Logout realizado com sucesso'
      }
    };
  });
}