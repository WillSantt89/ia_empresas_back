import { logger } from '../config/logger.js';
import { pool } from '../config/database.js';
import { hash } from '../utils/encryption.js';

/**
 * Empresas Routes
 * Master (WSCHAT) manages all companies
 */

const createLogger = logger.child({ module: 'empresas-routes' });

const empresasRoutes = async (fastify) => {

  // Helper: generate slug from name
  const generateSlug = (nome) => {
    return nome
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
  };

  /**
   * GET /api/empresas
   * List all companies (master only)
   */
  fastify.get('/', {
    preHandler: fastify.authenticate
  }, async (request, reply) => {
    const { role } = request.user;

    if (role !== 'master') {
      return reply.code(403).send({
        success: false,
        error: { code: 'FORBIDDEN', message: 'Acesso restrito ao master' }
      });
    }

    const { search, tipo, ativo, page = 1, per_page = 50 } = request.query;
    const conditions = [];
    const params = [];
    let idx = 1;

    if (search) {
      conditions.push(`(e.nome ILIKE $${idx} OR e.email ILIKE $${idx} OR e.documento ILIKE $${idx})`);
      params.push(`%${search}%`);
      idx++;
    }

    if (tipo) {
      conditions.push(`e.tipo = $${idx}`);
      params.push(tipo);
      idx++;
    }

    if (ativo !== undefined && ativo !== '') {
      conditions.push(`e.ativo = $${idx}`);
      params.push(ativo === 'true' || ativo === true);
      idx++;
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const offset = (parseInt(page) - 1) * parseInt(per_page);

    try {
      const countResult = await pool.query(
        `SELECT COUNT(*) as total FROM empresas e ${whereClause}`,
        params
      );

      const query = `
        SELECT
          e.id,
          e.nome,
          e.slug,
          e.email,
          e.telefone,
          e.documento,
          e.tipo,
          e.plano_id,
          e.ativo,
          e.criado_em,
          p.nome as plano_nome,
          el.max_agentes,
          el.max_usuarios,
          el.max_mensagens_mes,
          el.max_tokens_mes,
          (SELECT COUNT(*) FROM usuarios WHERE empresa_id = e.id AND ativo = true) as usuarios_ativos,
          (SELECT COUNT(*) FROM agentes WHERE empresa_id = e.id AND ativo = true) as agentes_ativos
        FROM empresas e
        LEFT JOIN planos p ON e.plano_id = p.id
        LEFT JOIN empresa_limits el ON e.id = el.empresa_id
        ${whereClause}
        ORDER BY e.criado_em DESC
        LIMIT $${idx} OFFSET $${idx + 1}
      `;

      params.push(parseInt(per_page), offset);
      const result = await pool.query(query, params);

      return {
        success: true,
        data: {
          empresas: result.rows,
          pagination: {
            total: parseInt(countResult.rows[0].total),
            page: parseInt(page),
            per_page: parseInt(per_page),
            pages: Math.ceil(parseInt(countResult.rows[0].total) / parseInt(per_page))
          }
        }
      };
    } catch (error) {
      createLogger.error('Failed to list empresas', { error: error.message });
      throw error;
    }
  });

  /**
   * GET /api/empresas/me
   * Get current company details (any authenticated user)
   */
  fastify.get('/me', {
    preHandler: fastify.authenticate
  }, async (request, reply) => {
    const { empresa_id } = request.user;

    try {
      const result = await pool.query(`
        SELECT
          e.id, e.nome, e.slug, e.email, e.telefone, e.documento,
          e.endereco, e.logo_url, e.tipo, e.plano_id, e.ativo,
          e.criado_em, e.atualizado_em,
          el.max_agentes, el.max_usuarios, el.max_mensagens_mes,
          el.max_tokens_mes, el.periodo_inicio, el.periodo_fim,
          p.nome as plano_nome
        FROM empresas e
        LEFT JOIN empresa_limits el ON e.id = el.empresa_id
        LEFT JOIN planos p ON e.plano_id = p.id
        WHERE e.id = $1
      `, [empresa_id]);

      if (result.rows.length === 0) {
        return reply.code(404).send({
          success: false,
          error: { code: 'COMPANY_NOT_FOUND', message: 'Empresa não encontrada' }
        });
      }

      const empresa = result.rows[0];

      const usageResult = await pool.query(`
        SELECT
          (SELECT COUNT(*) FROM usuarios WHERE empresa_id = $1 AND ativo = true) as usuarios_ativos,
          (SELECT COUNT(*) FROM agentes WHERE empresa_id = $1 AND ativo = true) as agentes_ativos,
          (SELECT COALESCE(SUM(tokens_input + tokens_output), 0) FROM conversacao_analytics WHERE empresa_id = $1) as tokens_usados,
          (SELECT COUNT(*) FROM conversacao_analytics WHERE empresa_id = $1) as mensagens_processadas
      `, [empresa_id]);

      const usage = usageResult.rows[0];

      return {
        success: true,
        data: {
          empresa: {
            id: empresa.id,
            nome: empresa.nome,
            slug: empresa.slug,
            email: empresa.email,
            telefone: empresa.telefone,
            documento: empresa.documento,
            endereco: empresa.endereco,
            logo_url: empresa.logo_url,
            tipo: empresa.tipo,
            plano_nome: empresa.plano_nome,
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
      createLogger.error('Failed to get company', { empresa_id, error: error.message });
      throw error;
    }
  });

  /**
   * GET /api/empresas/:id
   * Get company details by ID (master only)
   */
  fastify.get('/:id', {
    preHandler: fastify.authenticate
  }, async (request, reply) => {
    const { role } = request.user;
    const { id } = request.params;

    if (role !== 'master') {
      return reply.code(403).send({
        success: false,
        error: { code: 'FORBIDDEN', message: 'Acesso restrito ao master' }
      });
    }

    try {
      const result = await pool.query(`
        SELECT
          e.*,
          el.max_agentes, el.max_usuarios, el.max_mensagens_mes,
          el.max_tokens_mes, el.periodo_inicio, el.periodo_fim,
          p.nome as plano_nome, p.preco_base_mensal
        FROM empresas e
        LEFT JOIN empresa_limits el ON e.id = el.empresa_id
        LEFT JOIN planos p ON e.plano_id = p.id
        WHERE e.id = $1
      `, [id]);

      if (result.rows.length === 0) {
        return reply.code(404).send({
          success: false,
          error: { code: 'NOT_FOUND', message: 'Empresa não encontrada' }
        });
      }

      const empresa = result.rows[0];

      // Get users of this company
      const usersResult = await pool.query(`
        SELECT id, nome, email, role, ativo, criado_em, ultimo_login
        FROM usuarios WHERE empresa_id = $1
        ORDER BY criado_em ASC
      `, [id]);

      // Get usage stats
      const usageResult = await pool.query(`
        SELECT
          (SELECT COUNT(*) FROM usuarios WHERE empresa_id = $1 AND ativo = true) as usuarios_ativos,
          (SELECT COUNT(*) FROM agentes WHERE empresa_id = $1 AND ativo = true) as agentes_ativos,
          (SELECT COALESCE(SUM(tokens_input + tokens_output), 0) FROM conversacao_analytics WHERE empresa_id = $1) as tokens_usados,
          (SELECT COUNT(*) FROM conversacao_analytics WHERE empresa_id = $1) as mensagens_processadas
      `, [id]);

      const usage = usageResult.rows[0];

      return {
        success: true,
        data: {
          empresa,
          usuarios: usersResult.rows,
          limits: {
            max_agentes: empresa.max_agentes || 5,
            max_usuarios: empresa.max_usuarios || 10,
            max_mensagens_mes: empresa.max_mensagens_mes || 10000,
            max_tokens_mes: empresa.max_tokens_mes || 5000000
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
      createLogger.error('Failed to get empresa', { id, error: error.message });
      throw error;
    }
  });

  /**
   * POST /api/empresas
   * Create a new company (master only - WSCHAT creates companies)
   */
  fastify.post('/', {
    preHandler: fastify.authenticate
  }, async (request, reply) => {
    const { role } = request.user;

    if (role !== 'master') {
      return reply.code(403).send({
        success: false,
        error: { code: 'FORBIDDEN', message: 'Apenas master pode criar empresas' }
      });
    }

    const { nome, email, telefone, documento, endereco, tipo, user, limits } = request.body;

    if (!nome || !user?.nome || !user?.email || !user?.senha) {
      return reply.code(400).send({
        success: false,
        error: { code: 'VALIDATION_ERROR', message: 'Nome da empresa, nome/email/senha do usuário são obrigatórios' }
      });
    }

    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      // Check duplicates
      const existingEmpresa = await client.query('SELECT id FROM empresas WHERE email = $1', [email]);
      if (email && existingEmpresa.rows.length > 0) {
        await client.query('ROLLBACK');
        return reply.code(409).send({
          success: false,
          error: { code: 'COMPANY_EXISTS', message: 'Já existe uma empresa com este email' }
        });
      }

      const existingUser = await client.query('SELECT id FROM usuarios WHERE email = $1', [user.email]);
      if (existingUser.rows.length > 0) {
        await client.query('ROLLBACK');
        return reply.code(409).send({
          success: false,
          error: { code: 'USER_EXISTS', message: 'Já existe um usuário com este email' }
        });
      }

      // Generate unique slug
      let slug = generateSlug(nome);
      const slugCheck = await client.query('SELECT id FROM empresas WHERE slug = $1', [slug]);
      if (slugCheck.rows.length > 0) {
        slug = `${slug}-${Date.now().toString(36)}`;
      }

      // Determine user role: parceiro gets 'master', cliente gets 'admin'
      const empresaTipo = tipo || 'cliente';
      const userRole = empresaTipo === 'parceiro' ? 'master' : 'admin';

      // Create company
      const empresaResult = await client.query(`
        INSERT INTO empresas (nome, slug, email, telefone, documento, endereco, tipo, ativo)
        VALUES ($1, $2, $3, $4, $5, $6, $7, true)
        RETURNING id, nome, slug, email, tipo, criado_em
      `, [nome, slug, email, telefone, documento, endereco, empresaTipo]);

      const empresa = empresaResult.rows[0];

      // Hash password and create user
      const hashedPassword = await hash(user.senha);
      const userResult = await client.query(`
        INSERT INTO usuarios (empresa_id, nome, email, senha_hash, telefone, role, ativo, email_verified)
        VALUES ($1, $2, $3, $4, $5, $6, true, true)
        RETURNING id, nome, email, role
      `, [empresa.id, user.nome, user.email, hashedPassword, user.telefone, userRole]);

      const createdUser = userResult.rows[0];

      // Create limits
      const maxAgentes = limits?.max_agentes || 5;
      const maxUsuarios = limits?.max_usuarios || 10;
      const maxMensagens = limits?.max_mensagens_mes || 10000;
      const maxTokens = limits?.max_tokens_mes || 1000000;

      await client.query(`
        INSERT INTO empresa_limits (empresa_id, max_agentes, max_usuarios, max_mensagens_mes, max_tokens_mes)
        VALUES ($1, $2, $3, $4, $5)
      `, [empresa.id, maxAgentes, maxUsuarios, maxMensagens, maxTokens]);

      await client.query('COMMIT');

      createLogger.info('Company created by master', {
        empresa_id: empresa.id,
        user_id: createdUser.id,
        tipo: empresaTipo
      });

      return {
        success: true,
        data: {
          empresa: {
            id: empresa.id,
            nome: empresa.nome,
            slug: empresa.slug,
            email: empresa.email,
            tipo: empresa.tipo,
            criado_em: empresa.criado_em
          },
          user: {
            id: createdUser.id,
            nome: createdUser.nome,
            email: createdUser.email,
            role: createdUser.role
          },
          limits: { max_agentes: maxAgentes, max_usuarios: maxUsuarios, max_mensagens_mes: maxMensagens, max_tokens_mes: maxTokens },
          message: `Empresa criada com sucesso. Usuário ${createdUser.email} com acesso ${createdUser.role}.`
        }
      };

    } catch (error) {
      await client.query('ROLLBACK');
      createLogger.error('Failed to create company', { error: error.message });
      throw error;
    } finally {
      client.release();
    }
  });

  /**
   * PUT /api/empresas/:id
   * Update any company (master only)
   */
  fastify.put('/:id', {
    preHandler: fastify.authenticate
  }, async (request, reply) => {
    const { role } = request.user;
    const { id } = request.params;

    if (role !== 'master') {
      return reply.code(403).send({
        success: false,
        error: { code: 'FORBIDDEN', message: 'Acesso restrito ao master' }
      });
    }

    const { nome, email, telefone, documento, endereco, tipo, ativo, limits } = request.body;
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      // Build dynamic update for empresas
      const allowedFields = { nome, email, telefone, documento, endereco, tipo, ativo };
      const fields = [];
      const values = [];
      let idx = 1;

      Object.entries(allowedFields).forEach(([key, value]) => {
        if (value !== undefined) {
          fields.push(`${key} = $${idx}`);
          values.push(value);
          idx++;
        }
      });

      if (fields.length > 0) {
        values.push(id);
        await client.query(`
          UPDATE empresas SET ${fields.join(', ')}, atualizado_em = CURRENT_TIMESTAMP
          WHERE id = $${idx}
        `, values);
      }

      // Update limits if provided
      if (limits) {
        const limitsFields = [];
        const limitsValues = [];
        let lidx = 1;

        const allowedLimits = {
          max_agentes: limits.max_agentes,
          max_usuarios: limits.max_usuarios,
          max_mensagens_mes: limits.max_mensagens_mes,
          max_tokens_mes: limits.max_tokens_mes
        };

        Object.entries(allowedLimits).forEach(([key, value]) => {
          if (value !== undefined) {
            limitsFields.push(`${key} = $${lidx}`);
            limitsValues.push(value);
            lidx++;
          }
        });

        if (limitsFields.length > 0) {
          limitsValues.push(id);
          // Upsert limits
          const existingLimits = await client.query('SELECT id FROM empresa_limits WHERE empresa_id = $1', [id]);

          if (existingLimits.rows.length > 0) {
            await client.query(`
              UPDATE empresa_limits SET ${limitsFields.join(', ')}, atualizado_em = CURRENT_TIMESTAMP
              WHERE empresa_id = $${lidx}
            `, limitsValues);
          } else {
            await client.query(`
              INSERT INTO empresa_limits (empresa_id, max_agentes, max_usuarios, max_mensagens_mes, max_tokens_mes)
              VALUES ($1, $2, $3, $4, $5)
            `, [id, limits.max_agentes || 5, limits.max_usuarios || 10, limits.max_mensagens_mes || 10000, limits.max_tokens_mes || 1000000]);
          }
        }
      }

      await client.query('COMMIT');

      // Fetch updated data
      const result = await pool.query(`
        SELECT e.*, el.max_agentes, el.max_usuarios, el.max_mensagens_mes, el.max_tokens_mes
        FROM empresas e
        LEFT JOIN empresa_limits el ON e.id = el.empresa_id
        WHERE e.id = $1
      `, [id]);

      createLogger.info('Company updated by master', { empresa_id: id });

      return {
        success: true,
        data: { empresa: result.rows[0] }
      };

    } catch (error) {
      await client.query('ROLLBACK');
      createLogger.error('Failed to update empresa', { id, error: error.message });
      throw error;
    } finally {
      client.release();
    }
  });

  /**
   * PUT /api/empresas/me
   * Update own company (admin+)
   */
  fastify.put('/me', {
    preHandler: fastify.authenticate
  }, async (request, reply) => {
    const { empresa_id, role } = request.user;

    if (!['master', 'admin'].includes(role)) {
      return reply.code(403).send({
        success: false,
        error: { code: 'FORBIDDEN', message: 'Acesso restrito' }
      });
    }

    const allowedFields = ['nome', 'telefone', 'endereco'];
    const fields = [];
    const values = [];
    let idx = 1;

    allowedFields.forEach(key => {
      if (request.body[key] !== undefined) {
        fields.push(`${key} = $${idx}`);
        values.push(request.body[key]);
        idx++;
      }
    });

    if (fields.length === 0) {
      return { success: true, data: { message: 'Nada a atualizar' } };
    }

    try {
      values.push(empresa_id);
      const result = await pool.query(`
        UPDATE empresas SET ${fields.join(', ')}, atualizado_em = CURRENT_TIMESTAMP
        WHERE id = $${idx}
        RETURNING id, nome, telefone, atualizado_em
      `, values);

      return { success: true, data: { empresa: result.rows[0] } };
    } catch (error) {
      createLogger.error('Failed to update company', { empresa_id, error: error.message });
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
          (SELECT COUNT(*) FROM usuarios WHERE empresa_id = $1) as total_usuarios,
          (SELECT COUNT(*) FROM usuarios WHERE empresa_id = $1 AND ativo = true) as usuarios_ativos,
          (SELECT COUNT(*) FROM agentes WHERE empresa_id = $1) as total_agentes,
          (SELECT COUNT(*) FROM agentes WHERE empresa_id = $1 AND ativo = true) as agentes_ativos,
          (SELECT COUNT(*) FROM tools WHERE empresa_id = $1 OR is_global = true) as total_tools,
          (SELECT COUNT(*) FROM api_keys WHERE empresa_id = $1 AND status = 'ativo') as api_keys_ativas,
          (SELECT COUNT(DISTINCT conversation_id) FROM conversacao_analytics
           WHERE empresa_id = $1 AND criado_em >= (SELECT start_date FROM date_range)
             AND criado_em <= (SELECT end_date FROM date_range)) as conversas_periodo,
          (SELECT COUNT(*) FROM conversacao_analytics
           WHERE empresa_id = $1 AND criado_em >= (SELECT start_date FROM date_range)
             AND criado_em <= (SELECT end_date FROM date_range)) as mensagens_periodo,
          (SELECT COALESCE(SUM(tokens_input + tokens_output), 0) FROM conversacao_analytics
           WHERE empresa_id = $1 AND criado_em >= (SELECT start_date FROM date_range)
             AND criado_em <= (SELECT end_date FROM date_range)) as tokens_periodo,
          (SELECT start_date FROM date_range) as periodo_inicio,
          (SELECT end_date FROM date_range) as periodo_fim
      `;

      const result = await pool.query(statsQuery, [empresa_id]);
      const stats = result.rows[0];

      return {
        success: true,
        data: {
          usuarios: { total: parseInt(stats.total_usuarios) || 0, ativos: parseInt(stats.usuarios_ativos) || 0 },
          agentes: { total: parseInt(stats.total_agentes) || 0, ativos: parseInt(stats.agentes_ativos) || 0 },
          tools: { total: parseInt(stats.total_tools) || 0 },
          api_keys: { ativas: parseInt(stats.api_keys_ativas) || 0 },
          periodo_atual: {
            inicio: stats.periodo_inicio,
            fim: stats.periodo_fim,
            conversas: parseInt(stats.conversas_periodo) || 0,
            mensagens: parseInt(stats.mensagens_periodo) || 0,
            tokens: parseInt(stats.tokens_periodo) || 0
          }
        }
      };
    } catch (error) {
      createLogger.error('Failed to get company stats', { empresa_id, error: error.message });
      throw error;
    }
  });

  /**
   * PUT /api/empresas/:id/toggle
   * Activate/Deactivate a company (master only)
   */
  fastify.put('/:id/toggle', {
    preHandler: fastify.authenticate
  }, async (request, reply) => {
    const { role } = request.user;
    const { id } = request.params;

    if (role !== 'master') {
      return reply.code(403).send({
        success: false,
        error: { code: 'FORBIDDEN', message: 'Acesso restrito ao master' }
      });
    }

    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      // Get current state
      const current = await client.query('SELECT ativo FROM empresas WHERE id = $1', [id]);
      if (current.rows.length === 0) {
        await client.query('ROLLBACK');
        return reply.code(404).send({ success: false, error: { code: 'NOT_FOUND', message: 'Empresa não encontrada' } });
      }

      const newState = !current.rows[0].ativo;

      await client.query('UPDATE empresas SET ativo = $1, atualizado_em = CURRENT_TIMESTAMP WHERE id = $2', [newState, id]);

      if (!newState) {
        // Deactivating: disable users, agents, api keys
        await client.query('UPDATE usuarios SET ativo = false WHERE empresa_id = $1', [id]);
        await client.query('UPDATE agentes SET ativo = false WHERE empresa_id = $1', [id]);
        await client.query("UPDATE api_keys SET status = 'revogado', atualizado_em = CURRENT_TIMESTAMP WHERE empresa_id = $1", [id]);
      }

      await client.query('COMMIT');

      createLogger.info(`Company ${newState ? 'activated' : 'deactivated'}`, { empresa_id: id });

      return {
        success: true,
        data: {
          ativo: newState,
          message: newState ? 'Empresa ativada com sucesso' : 'Empresa desativada com sucesso'
        }
      };
    } catch (error) {
      await client.query('ROLLBACK');
      createLogger.error('Failed to toggle empresa', { id, error: error.message });
      throw error;
    } finally {
      client.release();
    }
  });

  /**
   * PUT /api/empresas/:empresaId/usuarios/:userId/reset-senha
   * Reset password of any user in a company (master only)
   */
  fastify.put('/:empresaId/usuarios/:userId/reset-senha', {
    preHandler: fastify.authenticate
  }, async (request, reply) => {
    const { role } = request.user;
    const { empresaId, userId } = request.params;
    const { nova_senha } = request.body || {};

    if (role !== 'master') {
      return reply.code(403).send({
        success: false,
        error: { code: 'FORBIDDEN', message: 'Apenas master pode resetar senhas' }
      });
    }

    if (!nova_senha || nova_senha.length < 8) {
      return reply.code(400).send({
        success: false,
        error: { code: 'VALIDATION_ERROR', message: 'Nova senha deve ter no minimo 8 caracteres' }
      });
    }

    try {
      // Verify user belongs to the empresa
      const userResult = await pool.query(
        'SELECT id, nome, email, empresa_id FROM usuarios WHERE id = $1 AND empresa_id = $2',
        [userId, empresaId]
      );

      if (userResult.rows.length === 0) {
        return reply.code(404).send({
          success: false,
          error: { code: 'NOT_FOUND', message: 'Usuario nao encontrado nesta empresa' }
        });
      }

      const usuario = userResult.rows[0];

      // Hash new password
      const hashedPassword = await hash(nova_senha);

      // Update password
      await pool.query(
        'UPDATE usuarios SET senha_hash = $1, atualizado_em = CURRENT_TIMESTAMP WHERE id = $2',
        [hashedPassword, userId]
      );

      createLogger.info('Password reset by master', {
        empresa_id: empresaId,
        user_id: userId,
        user_email: usuario.email
      });

      return {
        success: true,
        data: {
          message: `Senha do usuario ${usuario.email} resetada com sucesso`
        }
      };
    } catch (error) {
      createLogger.error('Failed to reset password', { empresaId, userId, error: error.message });
      throw error;
    }
  });

  /**
   * PUT /api/empresas/deactivate
   * Deactivate own company (kept for backwards compat)
   */
  fastify.put('/deactivate', {
    preHandler: fastify.authenticate
  }, async (request, reply) => {
    const { empresa_id, role } = request.user;

    if (role !== 'master') {
      return reply.code(403).send({
        success: false,
        error: { code: 'FORBIDDEN', message: 'Apenas master pode desativar empresa' }
      });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('UPDATE empresas SET ativo = false, atualizado_em = CURRENT_TIMESTAMP WHERE id = $1', [empresa_id]);
      await client.query('UPDATE usuarios SET ativo = false WHERE empresa_id = $1', [empresa_id]);
      await client.query('UPDATE agentes SET ativo = false WHERE empresa_id = $1', [empresa_id]);
      await client.query("UPDATE api_keys SET status = 'revogado', atualizado_em = CURRENT_TIMESTAMP WHERE empresa_id = $1", [empresa_id]);
      await client.query('COMMIT');

      return { success: true, data: { message: 'Empresa desativada com sucesso' } };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  });
};

export default empresasRoutes;
