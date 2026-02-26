import { logger } from '../config/logger.js';
import { pool, tenantQuery } from '../config/database.js';
import { hash } from '../utils/encryption.js';
import { v4 as uuidv4 } from 'uuid';

/**
 * Empresas Routes
 * Multi-tenant company management
 */

const createLogger = logger.child({ module: 'empresas-routes' });

const empresasRoutes = async (fastify) => {
  // Company schema
  const empresaSchema = {
    type: 'object',
    properties: {
      nome: { type: 'string', minLength: 2, maxLength: 255 },
      email: { type: 'string', format: 'email' },
      telefone: { type: 'string', maxLength: 20 },
      documento: { type: 'string', maxLength: 20 },
      endereco: { type: 'string', maxLength: 500 },
      config_json: { type: 'object' }
    }
  };

  // Create company schema (public endpoint for onboarding)
  const createEmpresaSchema = {
    ...empresaSchema,
    properties: {
      ...empresaSchema.properties,
      user: {
        type: 'object',
        properties: {
          nome: { type: 'string', minLength: 2, maxLength: 255 },
          email: { type: 'string', format: 'email' },
          senha: { type: 'string', minLength: 8 },
          telefone: { type: 'string' }
        },
        required: ['nome', 'email', 'senha']
      }
    },
    required: ['nome', 'email', 'user']
  };

  /**
   * POST /api/empresas
   * Create a new company (public endpoint for self-service)
   */
  fastify.post('/', {
    schema: {
      body: createEmpresaSchema
    },
    config: {
      rateLimit: {
        max: 5,
        timeWindow: '15 minutes'
      }
    }
  }, async (request, reply) => {
    const { nome, email, telefone, documento, endereco, config_json, user } = request.body;
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      // Check if company email already exists
      const existingQuery = 'SELECT id FROM empresas WHERE email = $1';
      const existing = await client.query(existingQuery, [email]);

      if (existing.rows.length > 0) {
        await client.query('ROLLBACK');
        return reply.code(409).send({
          success: false,
          error: {
            code: 'COMPANY_EXISTS',
            message: 'Company with this email already exists'
          }
        });
      }

      // Check if user email already exists
      const existingUserQuery = 'SELECT id FROM usuarios WHERE email = $1';
      const existingUser = await client.query(existingUserQuery, [user.email]);

      if (existingUser.rows.length > 0) {
        await client.query('ROLLBACK');
        return reply.code(409).send({
          success: false,
          error: {
            code: 'USER_EXISTS',
            message: 'User with this email already exists'
          }
        });
      }

      // Create company
      const empresaQuery = `
        INSERT INTO empresas (
          nome, email, telefone, documento,
          endereco, config_json, is_active
        ) VALUES ($1, $2, $3, $4, $5, $6, true)
        RETURNING id, nome, email, created_at
      `;

      const empresaResult = await client.query(empresaQuery, [
        nome, email, telefone, documento, endereco, config_json || {}
      ]);

      const empresa = empresaResult.rows[0];

      // Hash user password
      const hashedPassword = await hash(user.senha);

      // Create master user
      const userQuery = `
        INSERT INTO usuarios (
          empresa_id, nome, email, senha_hash,
          telefone, role, is_active, email_verified
        ) VALUES ($1, $2, $3, $4, $5, 'master', true, false)
        RETURNING id, nome, email, role
      `;

      const userResult = await client.query(userQuery, [
        empresa.id, user.nome, user.email, hashedPassword, user.telefone
      ]);

      const createdUser = userResult.rows[0];

      // Create default limits
      const limitsQuery = `
        INSERT INTO empresa_limits (
          empresa_id,
          max_agentes,
          max_usuarios,
          max_mensagens_mes,
          max_tokens_mes
        ) VALUES ($1, $2, $3, $4, $5)
      `;

      await client.query(limitsQuery, [
        empresa.id,
        5,      // 5 agents
        10,     // 10 users
        10000,  // 10k messages/month
        1000000 // 1M tokens/month
      ]);

      await client.query('COMMIT');

      createLogger.info('Company created', {
        empresa_id: empresa.id,
        user_id: createdUser.id
      });

      return {
        success: true,
        data: {
          empresa: {
            id: empresa.id,
            nome: empresa.nome,
            email: empresa.email,
            created_at: empresa.created_at
          },
          user: {
            id: createdUser.id,
            nome: createdUser.nome,
            email: createdUser.email,
            role: createdUser.role
          },
          message: 'Company created successfully. Please check your email to verify your account.'
        }
      };

    } catch (error) {
      await client.query('ROLLBACK');
      createLogger.error('Failed to create company', {
        error: error.message
      });
      throw error;
    } finally {
      client.release();
    }
  });

  /**
   * GET /api/empresas/me
   * Get current company details
   */
  fastify.get('/me', {
    preHandler: fastify.authenticate
  }, async (request, reply) => {
    const { empresa_id } = request.user;

    try {
      const result = await pool.query(`
        SELECT
          e.id,
          e.nome,
          e.slug,
          e.logo_url,
          e.ativo,
          e.criado_em,
          e.atualizado_em,
          el.max_agentes,
          el.max_usuarios,
          el.max_mensagens_mes,
          el.max_tokens_mes,
          el.periodo_inicio,
          el.periodo_fim
        FROM empresas e
        LEFT JOIN empresa_limits el ON e.id = el.empresa_id
        WHERE e.id = $1
      `, [empresa_id]);

      if (result.rows.length === 0) {
        return reply.code(404).send({
          success: false,
          error: {
            code: 'COMPANY_NOT_FOUND',
            message: 'Company not found'
          }
        });
      }

      const empresa = result.rows[0];

      // Get usage statistics
      const usageResult = await pool.query(`
        SELECT
          (SELECT COUNT(*) FROM usuarios WHERE empresa_id = $1 AND ativo = true) as usuarios_ativos,
          (SELECT COUNT(*) FROM agentes WHERE empresa_id = $1 AND ativo = true) as agentes_ativos,
          (
            SELECT COALESCE(SUM(tokens_input + tokens_output), 0)
            FROM conversacao_analytics
            WHERE empresa_id = $1
          ) as tokens_usados,
          (
            SELECT COUNT(*)
            FROM conversacao_analytics
            WHERE empresa_id = $1
          ) as mensagens_processadas
      `, [empresa_id]);

      const usage = usageResult.rows[0];

      return {
        success: true,
        data: {
          empresa: {
            id: empresa.id,
            nome: empresa.nome,
            slug: empresa.slug,
            logo_url: empresa.logo_url,
            is_active: empresa.ativo,
            created_at: empresa.criado_em,
            updated_at: empresa.atualizado_em
          },
          limits: {
            max_agentes: empresa.max_agentes || 5,
            max_usuarios: empresa.max_usuarios || 10,
            max_mensagens_mes: empresa.max_mensagens_mes || 10000,
            max_tokens_mes: empresa.max_tokens_mes || 5000000,
            periodo_inicio: empresa.periodo_inicio,
            periodo_fim: empresa.periodo_fim
          },
          usage: {
            usuarios_ativos: parseInt(usage.usuarios_ativos) || 0,
            agentes_ativos: parseInt(usage.agentes_ativos) || 0,
            tokens_usados: parseInt(usage.tokens_usados) || 0,
            mensagens_processadas: parseInt(usage.mensagens_processadas) || 0
          }
        }
      };

    } catch (error) {
      createLogger.error('Failed to get company', {
        empresa_id,
        error: error.message
      });
      throw error;
    }
  });

  /**
   * PUT /api/empresas/me
   * Update current company
   */
  fastify.put('/me', {
    preHandler: [fastify.authenticate],
    schema: {
      body: empresaSchema
    }
  }, async (request, reply) => {
    const { empresa_id, role } = request.user;
    const updates = request.body;

    // Only master users can update company
    if (role !== 'master') {
      return reply.code(403).send({
        success: false,
        error: {
          code: 'FORBIDDEN',
          message: 'Only master users can update company details'
        }
      });
    }

    try {
      const fields = [];
      const values = [];
      let index = 1;

      // Build dynamic update query
      Object.entries(updates).forEach(([key, value]) => {
        if (value !== undefined && key !== 'id') {
          fields.push(`${key} = $${index}`);
          values.push(value);
          index++;
        }
      });

      if (fields.length === 0) {
        return {
          success: true,
          data: {
            message: 'No fields to update'
          }
        };
      }

      values.push(empresa_id);
      const query = `
        UPDATE empresas
        SET ${fields.join(', ')}, updated_at = CURRENT_TIMESTAMP
        WHERE id = $${index}
        RETURNING id, nome, email, telefone, documento, endereco, config_json, updated_at
      `;

      const result = await tenantQuery(pool, empresa_id, query, values);

      createLogger.info('Company updated', {
        empresa_id,
        updated_fields: Object.keys(updates)
      });

      return {
        success: true,
        data: {
          empresa: result.rows[0]
        }
      };

    } catch (error) {
      createLogger.error('Failed to update company', {
        empresa_id,
        error: error.message
      });
      throw error;
    }
  });

  /**
   * GET /api/empresas/stats
   * Get company statistics
   */
  fastify.get('/stats', {
    preHandler: fastify.authenticate
  }, async (request, reply) => {
    const { empresa_id } = request.user;

    try {
      const statsQuery = `
        WITH date_range AS (
          SELECT
            COALESCE(
              (SELECT periodo_inicio FROM empresa_limits WHERE empresa_id = $1),
              date_trunc('month', CURRENT_DATE)
            ) as start_date,
            COALESCE(
              (SELECT periodo_fim FROM empresa_limits WHERE empresa_id = $1),
              date_trunc('month', CURRENT_DATE) + interval '1 month' - interval '1 day'
            ) as end_date
        )
        SELECT
          -- User stats
          (SELECT COUNT(*) FROM usuarios WHERE empresa_id = $1) as total_usuarios,
          (SELECT COUNT(*) FROM usuarios WHERE empresa_id = $1 AND is_active = true) as usuarios_ativos,

          -- Agent stats
          (SELECT COUNT(*) FROM agentes WHERE empresa_id = $1) as total_agentes,
          (SELECT COUNT(*) FROM agentes WHERE empresa_id = $1 AND is_active = true) as agentes_ativos,

          -- Tool stats
          (SELECT COUNT(DISTINCT t.id)
           FROM tools t
           INNER JOIN agent_tools at ON t.id = at.tool_id
           WHERE at.empresa_id = $1) as total_tools,

          -- API Key stats
          (SELECT COUNT(*) FROM api_keys WHERE empresa_id = $1 AND is_active = true) as api_keys_ativas,

          -- Conversation stats (current period)
          (SELECT COUNT(DISTINCT conversation_id)
           FROM conversacao_analytics
           WHERE empresa_id = $1
             AND created_at >= (SELECT start_date FROM date_range)
             AND created_at <= (SELECT end_date FROM date_range)) as conversas_periodo,

          (SELECT COUNT(*)
           FROM conversacao_analytics
           WHERE empresa_id = $1
             AND created_at >= (SELECT start_date FROM date_range)
             AND created_at <= (SELECT end_date FROM date_range)) as mensagens_periodo,

          (SELECT COALESCE(SUM(tokens_input + tokens_output), 0)
           FROM conversacao_analytics
           WHERE empresa_id = $1
             AND created_at >= (SELECT start_date FROM date_range)
             AND created_at <= (SELECT end_date FROM date_range)) as tokens_periodo,

          (SELECT COALESCE(AVG(tempo_processamento_ms), 0)
           FROM conversacao_analytics
           WHERE empresa_id = $1
             AND created_at >= (SELECT start_date FROM date_range)
             AND created_at <= (SELECT end_date FROM date_range)) as tempo_medio_ms,

          -- Success rate
          (SELECT
            CASE
              WHEN COUNT(*) = 0 THEN 0
              ELSE (COUNT(*) FILTER (WHERE sucesso = true))::float / COUNT(*) * 100
            END
           FROM conversacao_analytics
           WHERE empresa_id = $1
             AND created_at >= (SELECT start_date FROM date_range)
             AND created_at <= (SELECT end_date FROM date_range)) as taxa_sucesso,

          -- Period dates
          (SELECT start_date FROM date_range) as periodo_inicio,
          (SELECT end_date FROM date_range) as periodo_fim
      `;

      const result = await tenantQuery(pool, empresa_id, statsQuery, [empresa_id]);
      const stats = result.rows[0];

      return {
        success: true,
        data: {
          usuarios: {
            total: parseInt(stats.total_usuarios) || 0,
            ativos: parseInt(stats.usuarios_ativos) || 0
          },
          agentes: {
            total: parseInt(stats.total_agentes) || 0,
            ativos: parseInt(stats.agentes_ativos) || 0
          },
          tools: {
            total: parseInt(stats.total_tools) || 0
          },
          api_keys: {
            ativas: parseInt(stats.api_keys_ativas) || 0
          },
          periodo_atual: {
            inicio: stats.periodo_inicio,
            fim: stats.periodo_fim,
            conversas: parseInt(stats.conversas_periodo) || 0,
            mensagens: parseInt(stats.mensagens_periodo) || 0,
            tokens: parseInt(stats.tokens_periodo) || 0,
            tempo_medio_ms: Math.round(parseFloat(stats.tempo_medio_ms)) || 0,
            taxa_sucesso: Math.round(parseFloat(stats.taxa_sucesso) * 100) / 100
          }
        }
      };

    } catch (error) {
      createLogger.error('Failed to get company stats', {
        empresa_id,
        error: error.message
      });
      throw error;
    }
  });

  /**
   * PUT /api/empresas/deactivate
   * Deactivate company (soft delete)
   */
  fastify.put('/deactivate', {
    preHandler: fastify.authenticate
  }, async (request, reply) => {
    const { empresa_id, role } = request.user;

    if (role !== 'master') {
      return reply.code(403).send({
        success: false,
        error: {
          code: 'FORBIDDEN',
          message: 'Only master users can deactivate the company'
        }
      });
    }

    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      // Deactivate company
      await tenantQuery(
        client,
        empresa_id,
        'UPDATE empresas SET is_active = false, updated_at = CURRENT_TIMESTAMP WHERE id = $1',
        [empresa_id]
      );

      // Deactivate all users
      await tenantQuery(
        client,
        empresa_id,
        'UPDATE usuarios SET is_active = false WHERE empresa_id = $1',
        [empresa_id]
      );

      // Deactivate all agents
      await tenantQuery(
        client,
        empresa_id,
        'UPDATE agentes SET is_active = false WHERE empresa_id = $1',
        [empresa_id]
      );

      // Revoke all API keys
      await tenantQuery(
        client,
        empresa_id,
        'UPDATE api_keys SET is_active = false, revoked_at = CURRENT_TIMESTAMP WHERE empresa_id = $1',
        [empresa_id]
      );

      await client.query('COMMIT');

      createLogger.info('Company deactivated', {
        empresa_id
      });

      return {
        success: true,
        data: {
          message: 'Company deactivated successfully'
        }
      };

    } catch (error) {
      await client.query('ROLLBACK');
      createLogger.error('Failed to deactivate company', {
        empresa_id,
        error: error.message
      });
      throw error;
    } finally {
      client.release();
    }
  });
};

export default empresasRoutes;