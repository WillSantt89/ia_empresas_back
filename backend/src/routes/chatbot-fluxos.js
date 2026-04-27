import { logger } from '../config/logger.js';
import { pool } from '../config/database.js';
import { checkPermission } from '../middleware/permission.js';

const createLogger = logger.child({ module: 'chatbot-fluxos-routes' });

const chatbotFluxosRoutes = async (fastify) => {

  /**
   * GET /api/chatbot-fluxos
   * Lista todos os fluxos da empresa
   */
  fastify.get('/', {
    preHandler: [fastify.authenticate, checkPermission(['master', 'admin_suporte', 'admin'])],
  }, async (request) => {
    const empresa_id = request.headers['x-empresa-id'] || request.user.empresa_id;
    const isMaster = request.user.role === 'master';

    let result;
    if (isMaster) {
      // Master vê fluxos de TODAS as empresas
      result = await pool.query(`
        SELECT cf.id, cf.nome, cf.descricao, cf.ativo, cf.criado_em, cf.atualizado_em,
          cf.empresa_id,
          e.nome as empresa_nome,
          (SELECT COUNT(*) FROM agentes a WHERE a.chatbot_fluxo_id = cf.id AND a.chatbot_ativo = true) as agentes_vinculados
        FROM chatbot_fluxos cf
        JOIN empresas e ON e.id = cf.empresa_id
        ORDER BY cf.criado_em DESC
      `);
    } else {
      result = await pool.query(`
        SELECT cf.id, cf.nome, cf.descricao, cf.ativo, cf.criado_em, cf.atualizado_em,
          (SELECT COUNT(*) FROM agentes a WHERE a.chatbot_fluxo_id = cf.id AND a.chatbot_ativo = true) as agentes_vinculados
        FROM chatbot_fluxos cf
        WHERE cf.empresa_id = $1
        ORDER BY cf.criado_em DESC
      `, [empresa_id]);
    }

    return { success: true, data: result.rows };
  });

  /**
   * GET /api/chatbot-fluxos/:id
   * Detalhes de um fluxo (incluindo JSON completo)
   */
  fastify.get('/:id', {
    preHandler: [fastify.authenticate, checkPermission(['master', 'admin_suporte', 'admin'])],
  }, async (request, reply) => {
    const empresa_id = request.headers['x-empresa-id'] || request.user.empresa_id;
    const isMaster = request.user.role === 'master';
    const { id } = request.params;

    const result = isMaster
      ? await pool.query('SELECT * FROM chatbot_fluxos WHERE id = $1', [id])
      : await pool.query('SELECT * FROM chatbot_fluxos WHERE id = $1 AND empresa_id = $2', [id, empresa_id]);

    if (result.rows.length === 0) {
      return reply.code(404).send({ success: false, error: 'Fluxo não encontrado' });
    }

    return { success: true, data: result.rows[0] };
  });

  /**
   * POST /api/chatbot-fluxos
   * Criar novo fluxo
   */
  fastify.post('/', {
    preHandler: [fastify.authenticate, checkPermission(['master', 'admin_suporte', 'admin'])],
    schema: {
      body: {
        type: 'object',
        required: ['nome'],
        properties: {
          nome: { type: 'string', minLength: 2, maxLength: 100 },
          descricao: { type: 'string', maxLength: 500 },
          fluxo_json: { type: 'object' },
          ativo: { type: 'boolean' },
        }
      }
    }
  }, async (request, reply) => {
    const empresa_id = request.headers['x-empresa-id'] || request.user.empresa_id;
    const { nome, descricao, fluxo_json, ativo } = request.body;

    if (!empresa_id) {
      return reply.code(400).send({ success: false, error: 'empresa_id não identificado' });
    }

    try {
      const jsonValue = typeof fluxo_json === 'string' ? fluxo_json : JSON.stringify(fluxo_json || {});
      const result = await pool.query(`
        INSERT INTO chatbot_fluxos (empresa_id, nome, descricao, fluxo_json, ativo)
        VALUES ($1, $2, $3, $4::jsonb, $5)
        RETURNING *
      `, [empresa_id, nome, descricao || null, jsonValue, ativo !== false]);

      createLogger.info({ empresa_id, fluxoId: result.rows[0].id }, 'Chatbot flow created');
      return reply.code(201).send({ success: true, data: result.rows[0] });
    } catch (error) {
      createLogger.error({ err: error, empresa_id }, 'Failed to create chatbot flow');
      throw error;
    }
  });

  /**
   * PUT /api/chatbot-fluxos/:id
   * Atualizar fluxo
   */
  fastify.put('/:id', {
    preHandler: [fastify.authenticate, checkPermission(['master', 'admin_suporte', 'admin'])],
    schema: {
      body: {
        type: 'object',
        properties: {
          nome: { type: 'string', minLength: 2, maxLength: 100 },
          descricao: { type: 'string', maxLength: 500 },
          fluxo_json: { type: 'object' },
          ativo: { type: 'boolean' },
        }
      }
    }
  }, async (request, reply) => {
    const empresa_id = request.headers['x-empresa-id'] || request.user.empresa_id;
    const isMaster = request.user.role === 'master';
    const { id } = request.params;
    const { nome, descricao, fluxo_json, ativo } = request.body;

    // Build dynamic UPDATE
    const updates = [];
    const params = [id];
    let paramIndex = 2;

    if (!isMaster) {
      params.push(empresa_id);
      paramIndex = 3;
    }

    if (nome !== undefined) { updates.push(`nome = $${paramIndex++}`); params.push(nome); }
    if (descricao !== undefined) { updates.push(`descricao = $${paramIndex++}`); params.push(descricao); }
    if (fluxo_json !== undefined) { updates.push(`fluxo_json = $${paramIndex++}`); params.push(typeof fluxo_json === 'string' ? fluxo_json : JSON.stringify(fluxo_json)); }
    if (ativo !== undefined) { updates.push(`ativo = $${paramIndex++}`); params.push(ativo); }

    if (updates.length === 0) {
      return reply.code(400).send({ success: false, error: 'Nenhum campo para atualizar' });
    }

    updates.push('atualizado_em = NOW()');

    const whereClause = isMaster ? 'WHERE id = $1' : 'WHERE id = $1 AND empresa_id = $2';
    const result = await pool.query(
      `UPDATE chatbot_fluxos SET ${updates.join(', ')} ${whereClause} RETURNING *`,
      params
    );

    if (result.rows.length === 0) {
      return reply.code(404).send({ success: false, error: 'Fluxo não encontrado' });
    }

    createLogger.info({ empresa_id, fluxoId: id }, 'Chatbot flow updated');
    return { success: true, data: result.rows[0] };
  });

  /**
   * DELETE /api/chatbot-fluxos/:id
   * Excluir fluxo
   */
  fastify.delete('/:id', {
    preHandler: [fastify.authenticate, checkPermission(['master', 'admin_suporte', 'admin'])],
  }, async (request, reply) => {
    const isMaster = request.user.role === 'master';
    const empresa_id = request.headers['x-empresa-id'] || request.user.empresa_id;
    const { id } = request.params;

    // Verificar se há agentes vinculados com chatbot ativo
    const agentesAtivos = await pool.query(
      'SELECT COUNT(*) as total FROM agentes WHERE chatbot_fluxo_id = $1 AND chatbot_ativo = true',
      [id]
    );

    if (parseInt(agentesAtivos.rows[0].total) > 0) {
      return reply.code(409).send({
        success: false,
        error: 'Não é possível excluir: há agentes com chatbot ativo usando este fluxo. Desative o chatbot nos agentes primeiro.'
      });
    }

    const result = isMaster
      ? await pool.query('DELETE FROM chatbot_fluxos WHERE id = $1 RETURNING id', [id])
      : await pool.query('DELETE FROM chatbot_fluxos WHERE id = $1 AND empresa_id = $2 RETURNING id', [id, empresa_id]);

    if (result.rows.length === 0) {
      return reply.code(404).send({ success: false, error: 'Fluxo não encontrado' });
    }

    createLogger.info({ empresa_id, fluxoId: id }, 'Chatbot flow deleted');
    return { success: true };
  });

  /**
   * POST /api/chatbot-fluxos/:id/duplicar
   * Duplicar um fluxo
   */
  fastify.post('/:id/duplicar', {
    preHandler: [fastify.authenticate, checkPermission(['master', 'admin_suporte', 'admin'])],
  }, async (request, reply) => {
    const empresa_id = request.headers['x-empresa-id'] || request.user.empresa_id;
    const { id } = request.params;

    const isMaster = request.user.role === 'master';
    const original = isMaster
      ? await pool.query('SELECT * FROM chatbot_fluxos WHERE id = $1', [id])
      : await pool.query('SELECT * FROM chatbot_fluxos WHERE id = $1 AND empresa_id = $2', [id, empresa_id]);

    if (original.rows.length === 0) {
      return reply.code(404).send({ success: false, error: 'Fluxo não encontrado' });
    }

    const { nome, descricao, fluxo_json } = original.rows[0];
    const result = await pool.query(`
      INSERT INTO chatbot_fluxos (empresa_id, nome, descricao, fluxo_json, ativo)
      VALUES ($1, $2, $3, $4, false)
      RETURNING *
    `, [empresa_id, `${nome} (cópia)`, descricao, fluxo_json]);

    return reply.code(201).send({ success: true, data: result.rows[0] });
  });
};

export default chatbotFluxosRoutes;
