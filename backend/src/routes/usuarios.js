import { logger } from '../config/logger.js';
import { pool } from '../config/database.js';
import { hash, compare } from '../utils/encryption.js';
import { checkPermission } from '../middleware/permission.js';

/**
 * Usuarios Routes
 * User management with role-based access
 */

const createLogger = logger.child({ module: 'usuarios-routes' });

const usuariosRoutes = async (fastify) => {
  // User schema
  const userSchema = {
    type: 'object',
    properties: {
      nome: { type: 'string', minLength: 2, maxLength: 255 },
      email: { type: 'string', format: 'email' },
      senha: { type: 'string', minLength: 8 },
      telefone: { type: 'string', maxLength: 20 },
      role: { type: 'string', enum: ['master', 'admin', 'supervisor', 'operador', 'viewer'] },
      ativo: { type: 'boolean' },
      max_conversas_simultaneas: { type: 'integer', minimum: 1, maximum: 100 }
    }
  };

  /**
   * GET /api/usuarios
   * List all users in company
   */
  fastify.get('/', {
    preHandler: [fastify.authenticate],
    schema: {
      querystring: {
        type: 'object',
        properties: {
          page: { type: 'integer', minimum: 1, default: 1 },
          limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
          search: { type: 'string' },
          role: { type: 'string', enum: ['master', 'admin', 'supervisor', 'operador', 'viewer'] },
          ativo: { type: 'boolean' }
        }
      }
    }
  }, async (request, reply) => {
    const { empresa_id } = request.user;
    const { page, limit, search, role, ativo } = request.query;
    const offset = (page - 1) * limit;

    try {
      const params = [empresa_id];
      let paramIndex = 2;
      let whereExtra = '';

      // Supervisor can only see operador and viewer
      if (request.user.role === 'supervisor') {
        whereExtra += ` AND role IN ('operador', 'viewer')`;
      }

      // Add filters
      if (search) {
        whereExtra += ` AND (nome ILIKE $${paramIndex} OR email ILIKE $${paramIndex})`;
        params.push(`%${search}%`);
        paramIndex++;
      }

      if (role) {
        whereExtra += ` AND role = $${paramIndex}`;
        params.push(role);
        paramIndex++;
      }

      if (ativo !== undefined) {
        whereExtra += ` AND ativo = $${paramIndex}`;
        params.push(ativo);
        paramIndex++;
      }

      // Get total count
      const countQuery = `SELECT COUNT(*) as total FROM usuarios WHERE empresa_id = $1${whereExtra}`;
      const countResult = await pool.query(countQuery, params);
      const total = parseInt(countResult.rows[0].total) || 0;

      // Get paginated results
      const query = `SELECT id, nome, email, telefone, role, ativo, email_verified, ultimo_login, max_conversas_simultaneas, criado_em, atualizado_em FROM usuarios WHERE empresa_id = $1${whereExtra} ORDER BY criado_em DESC LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
      params.push(limit, offset);

      const result = await pool.query(query, params);

      return {
        success: true,
        data: {
          users: result.rows,
          pagination: {
            page,
            limit,
            total,
            pages: Math.ceil(total / limit)
          }
        }
      };

    } catch (error) {
      createLogger.error('Failed to list users', {
        empresa_id,
        error: error.message
      });
      throw error;
    }
  });

  /**
   * POST /api/usuarios
   * Create a new user
   */
  fastify.post('/', {
    preHandler: [fastify.authenticate, checkPermission(['master', 'admin', 'supervisor'])],
    schema: {
      body: {
        type: 'object',
        properties: userSchema.properties,
        required: ['nome', 'email', 'senha', 'role']
      }
    }
  }, async (request, reply) => {
    const { empresa_id, role: userRole } = request.user;
    const { nome, email, senha, telefone, role, ativo = true } = request.body;

    try {
      // Check role hierarchy
      if (userRole === 'admin' && role === 'master') {
        return reply.code(403).send({
          success: false,
          error: {
            code: 'FORBIDDEN',
            message: 'Admin users cannot create master users'
          }
        });
      }

      // Supervisor can only create operador and viewer
      if (userRole === 'supervisor' && !['operador', 'viewer'].includes(role)) {
        return reply.code(403).send({
          success: false,
          error: {
            code: 'FORBIDDEN',
            message: 'Supervisor só pode criar usuários operador ou viewer'
          }
        });
      }

      // Check user limit
      const limitQuery = `
        SELECT
          el.max_usuarios,
          (SELECT COUNT(*) FROM usuarios WHERE empresa_id = $1 AND ativo = true) as current_users
        FROM empresa_limits el
        WHERE el.empresa_id = $1
      `;

      const limitResult = await pool.query(limitQuery, [empresa_id]);

      if (limitResult.rows.length > 0) {
        const { max_usuarios, current_users } = limitResult.rows[0];
        if (current_users >= max_usuarios) {
          return reply.code(403).send({
            success: false,
            error: {
              code: 'LIMIT_EXCEEDED',
              message: `User limit reached (${max_usuarios} users)`
            }
          });
        }
      }

      // Check if email already exists
      const existingQuery = 'SELECT id FROM usuarios WHERE email = $1';
      const existing = await pool.query(existingQuery, [email]);

      if (existing.rows.length > 0) {
        return reply.code(409).send({
          success: false,
          error: {
            code: 'USER_EXISTS',
            message: 'User with this email already exists'
          }
        });
      }

      // Hash password
      const hashedPassword = await hash(senha);

      // Create user
      const createQuery = `
        INSERT INTO usuarios (
          empresa_id, nome, email, senha_hash,
          telefone, role, ativo
        ) VALUES ($1, $2, $3, $4, $5, $6, $7)
        RETURNING id, nome, email, telefone, role, ativo, criado_em
      `;

      const result = await pool.query(
        createQuery,
        [empresa_id, nome, email, hashedPassword, telefone, role, ativo]
      );

      const user = result.rows[0];

      createLogger.info('User created', {
        empresa_id,
        user_id: user.id,
        role: user.role,
        created_by: request.user.id
      });

      return {
        success: true,
        data: {
          user
        }
      };

    } catch (error) {
      createLogger.error('Failed to create user', {
        empresa_id,
        error: error.message
      });
      throw error;
    }
  });

  /**
   * GET /api/usuarios/:id
   * Get user details
   */
  fastify.get('/:id', {
    preHandler: fastify.authenticate,
    schema: {
      params: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' }
        }
      }
    }
  }, async (request, reply) => {
    const { empresa_id } = request.user;
    const { id } = request.params;

    try {
      const query = `
        SELECT
          id,
          nome,
          email,
          telefone,
          role,
          ativo,
          email_verified,
          ultimo_login,
          criado_em,
          atualizado_em,
          (
            SELECT json_build_object(
              'total_conversations', COUNT(DISTINCT conversation_id),
              'total_messages', COUNT(*),
              'last_activity', MAX(criado_em)
            )
            FROM conversacao_analytics
            WHERE empresa_id = $1
              AND criado_em >= CURRENT_DATE - INTERVAL '30 days'
          ) as activity_stats
        FROM usuarios
        WHERE empresa_id = $1 AND id = $2
      `;

      const result = await pool.query(query, [empresa_id, id]);

      if (result.rows.length === 0) {
        return reply.code(404).send({
          success: false,
          error: {
            code: 'USER_NOT_FOUND',
            message: 'User not found'
          }
        });
      }

      return {
        success: true,
        data: {
          user: result.rows[0]
        }
      };

    } catch (error) {
      createLogger.error('Failed to get user', {
        empresa_id,
        user_id: id,
        error: error.message
      });
      throw error;
    }
  });

  /**
   * PUT /api/usuarios/:id
   * Update user
   */
  fastify.put('/:id', {
    preHandler: [fastify.authenticate],
    schema: {
      params: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' }
        }
      },
      body: userSchema
    }
  }, async (request, reply) => {
    const { empresa_id, id: currentUserId, role: currentUserRole } = request.user;
    const { id } = request.params;
    const updates = request.body;

    try {
      // Check permissions
      if (id !== currentUserId) {
        // User can only update themselves unless they're admin/master/supervisor
        if (!['master', 'admin', 'supervisor'].includes(currentUserRole)) {
          return reply.code(403).send({
            success: false,
            error: {
              code: 'FORBIDDEN',
              message: 'You can only update your own profile'
            }
          });
        }

        // Admin cannot update master users
        if (currentUserRole === 'admin') {
          const targetUserQuery = 'SELECT role FROM usuarios WHERE empresa_id = $1 AND id = $2';
          const targetUser = await pool.query(targetUserQuery, [empresa_id, id]);

          if (targetUser.rows.length > 0 && targetUser.rows[0].role === 'master') {
            return reply.code(403).send({
              success: false,
              error: {
                code: 'FORBIDDEN',
                message: 'Admin users cannot update master users'
              }
            });
          }
        }

        // Supervisor can only update operador/viewer
        if (currentUserRole === 'supervisor') {
          const targetUserQuery = 'SELECT role FROM usuarios WHERE empresa_id = $1 AND id = $2';
          const targetUser = await pool.query(targetUserQuery, [empresa_id, id]);

          if (targetUser.rows.length > 0 && !['operador', 'viewer'].includes(targetUser.rows[0].role)) {
            return reply.code(403).send({
              success: false,
              error: {
                code: 'FORBIDDEN',
                message: 'Supervisor só pode editar usuários operador ou viewer'
              }
            });
          }

          // Supervisor cannot set role above operador
          if (updates.role && !['operador', 'viewer'].includes(updates.role)) {
            return reply.code(403).send({
              success: false,
              error: {
                code: 'FORBIDDEN',
                message: 'Supervisor só pode definir role operador ou viewer'
              }
            });
          }
        }
      } else if (currentUserRole === 'supervisor') {
        // Supervisor cannot change own password via PUT (must ask admin/master)
        if (updates.senha) {
          return reply.code(403).send({
            success: false,
            error: {
              code: 'FORBIDDEN',
              message: 'Supervisor não pode alterar a própria senha. Solicite a um admin ou master.'
            }
          });
        }
      }

      // Users cannot change their own role
      if (id === currentUserId && updates.role && updates.role !== currentUserRole) {
        delete updates.role;
      }

      const fields = [];
      const values = [];
      let index = 1;

      // Build update query
      Object.entries(updates).forEach(([key, value]) => {
        if (value !== undefined && key !== 'id' && key !== 'senha') {
          fields.push(`${key} = $${index}`);
          values.push(value);
          index++;
        }
      });

      // Handle password update separately
      if (updates.senha) {
        const hashedPassword = await hash(updates.senha);
        fields.push(`senha_hash = $${index}`);
        values.push(hashedPassword);
        index++;
      }

      if (fields.length === 0) {
        return {
          success: true,
          data: {
            message: 'No fields to update'
          }
        };
      }

      values.push(empresa_id, id);
      const query = `
        UPDATE usuarios
        SET ${fields.join(', ')}, atualizado_em = CURRENT_TIMESTAMP
        WHERE empresa_id = $${index} AND id = $${index + 1}
        RETURNING id, nome, email, telefone, role, ativo, atualizado_em
      `;

      const result = await pool.query(query, values);

      if (result.rows.length === 0) {
        return reply.code(404).send({
          success: false,
          error: {
            code: 'USER_NOT_FOUND',
            message: 'User not found'
          }
        });
      }

      createLogger.info('User updated', {
        empresa_id,
        user_id: id,
        updated_by: currentUserId,
        updated_fields: Object.keys(updates)
      });

      return {
        success: true,
        data: {
          user: result.rows[0]
        }
      };

    } catch (error) {
      createLogger.error('Failed to update user', {
        empresa_id,
        user_id: id,
        error: error.message
      });
      throw error;
    }
  });

  /**
   * DELETE /api/usuarios/:id
   * Deactivate user
   */
  fastify.delete('/:id', {
    preHandler: [fastify.authenticate, checkPermission(['master', 'admin'])],
    schema: {
      params: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' }
        }
      }
    }
  }, async (request, reply) => {
    const { empresa_id, id: currentUserId, role: currentUserRole } = request.user;
    const { id } = request.params;

    try {
      // Cannot delete yourself
      if (id === currentUserId) {
        return reply.code(400).send({
          success: false,
          error: {
            code: 'CANNOT_DELETE_SELF',
            message: 'You cannot delete your own account'
          }
        });
      }

      // Check role hierarchy
      if (currentUserRole === 'admin') {
        const targetUserQuery = 'SELECT role FROM usuarios WHERE empresa_id = $1 AND id = $2';
        const targetUser = await pool.query(targetUserQuery, [empresa_id, id]);

        if (targetUser.rows.length > 0 && targetUser.rows[0].role === 'master') {
          return reply.code(403).send({
            success: false,
            error: {
              code: 'FORBIDDEN',
              message: 'Admin users cannot delete master users'
            }
          });
        }
      }

      // Soft delete
      const query = `
        UPDATE usuarios
        SET ativo = false, atualizado_em = CURRENT_TIMESTAMP
        WHERE empresa_id = $1 AND id = $2
        RETURNING id, nome, email
      `;

      const result = await pool.query(query, [empresa_id, id]);

      if (result.rows.length === 0) {
        return reply.code(404).send({
          success: false,
          error: {
            code: 'USER_NOT_FOUND',
            message: 'User not found'
          }
        });
      }

      createLogger.info('User deactivated', {
        empresa_id,
        user_id: id,
        deleted_by: currentUserId
      });

      return {
        success: true,
        data: {
          message: 'User deactivated successfully',
          user: result.rows[0]
        }
      };

    } catch (error) {
      createLogger.error('Failed to delete user', {
        empresa_id,
        user_id: id,
        error: error.message
      });
      throw error;
    }
  });

  /**
   * POST /api/usuarios/change-password
   * Change own password
   */
  fastify.post('/change-password', {
    preHandler: fastify.authenticate,
    schema: {
      body: {
        type: 'object',
        properties: {
          current_password: { type: 'string' },
          new_password: { type: 'string', minLength: 8 }
        },
        required: ['current_password', 'new_password']
      }
    }
  }, async (request, reply) => {
    const { empresa_id, id: userId, role: userRole } = request.user;
    const { current_password, new_password } = request.body;

    try {
      // Supervisor cannot change own password
      if (userRole === 'supervisor') {
        return reply.code(403).send({
          success: false,
          error: {
            code: 'FORBIDDEN',
            message: 'Supervisor não pode alterar a própria senha. Solicite a um admin ou master.'
          }
        });
      }

      // Get current password hash
      const query = 'SELECT senha_hash FROM usuarios WHERE empresa_id = $1 AND id = $2';
      const result = await pool.query(query, [empresa_id, userId]);

      if (result.rows.length === 0) {
        return reply.code(404).send({
          success: false,
          error: {
            code: 'USER_NOT_FOUND',
            message: 'User not found'
          }
        });
      }

      // Verify current password
      const isValid = await compare(current_password, result.rows[0].senha_hash);
      if (!isValid) {
        return reply.code(401).send({
          success: false,
          error: {
            code: 'INVALID_PASSWORD',
            message: 'Current password is incorrect'
          }
        });
      }

      // Hash new password
      const newHash = await hash(new_password);

      // Update password
      const updateQuery = `
        UPDATE usuarios
        SET senha_hash = $3, atualizado_em = CURRENT_TIMESTAMP
        WHERE empresa_id = $1 AND id = $2
      `;

      await pool.query(updateQuery, [empresa_id, userId, newHash]);

      createLogger.info('Password changed', {
        empresa_id,
        user_id: userId
      });

      return {
        success: true,
        data: {
          message: 'Password changed successfully'
        }
      };

    } catch (error) {
      createLogger.error('Failed to change password', {
        empresa_id,
        user_id: userId,
        error: error.message
      });
      throw error;
    }
  });
};

export default usuariosRoutes;