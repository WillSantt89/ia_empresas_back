import { logger } from '../config/logger.js';
import { pool } from '../config/database.js';
import { checkPermission } from '../middleware/permission.js';

const createLogger = logger.child({ module: 'automacoes-entrada-routes' });

const automacoesEntradaRoutes = async (fastify) => {

  /**
   * GET /api/automacoes-entrada
   * Lista todas as automações da empresa
   */
  fastify.get('/', {
    preHandler: [fastify.authenticate, checkPermission(['master', 'admin'])],
  }, async (request) => {
    const empresa_id = request.headers['x-empresa-id'] || request.user.empresa_id;
    const isMaster = request.user.role === 'master';

    let result;
    if (isMaster && request.headers['x-empresa-id']) {
      result = await pool.query(`
        SELECT ae.*, a.nome as agente_destino_nome
        FROM automacoes_entrada ae
        LEFT JOIN agentes a ON a.id = ae.agente_destino_id
        WHERE ae.empresa_id = $1
        ORDER BY ae.ordem ASC, ae.criado_em ASC
      `, [empresa_id]);
    } else if (isMaster) {
      result = await pool.query(`
        SELECT ae.*, a.nome as agente_destino_nome, e.nome as empresa_nome
        FROM automacoes_entrada ae
        LEFT JOIN agentes a ON a.id = ae.agente_destino_id
        LEFT JOIN empresas e ON e.id = ae.empresa_id
        ORDER BY ae.empresa_id, ae.ordem ASC, ae.criado_em ASC
      `);
    } else {
      result = await pool.query(`
        SELECT ae.*, a.nome as agente_destino_nome
        FROM automacoes_entrada ae
        LEFT JOIN agentes a ON a.id = ae.agente_destino_id
        WHERE ae.empresa_id = $1
        ORDER BY ae.ordem ASC, ae.criado_em ASC
      `, [empresa_id]);
    }

    return { success: true, data: result.rows };
  });

  /**
   * POST /api/automacoes-entrada
   * Criar nova automação
   */
  fastify.post('/', {
    preHandler: [fastify.authenticate, checkPermission(['master', 'admin'])],
    schema: {
      body: {
        type: 'object',
        required: ['nome', 'url_api', 'agente_destino_id'],
        properties: {
          nome: { type: 'string', minLength: 2, maxLength: 100 },
          url_api: { type: 'string', minLength: 5 },
          metodo: { type: 'string', enum: ['GET', 'POST'] },
          headers_json: { type: 'object' },
          agente_destino_id: { type: 'string', format: 'uuid' },
          timeout_ms: { type: 'integer', minimum: 1000, maximum: 30000 },
          ativo: { type: 'boolean' },
          ordem: { type: 'integer', minimum: 0 },
        },
      },
    },
  }, async (request, reply) => {
    const empresa_id = request.headers['x-empresa-id'] || request.user.empresa_id;
    const { nome, url_api, metodo, headers_json, agente_destino_id, timeout_ms, ativo, ordem } = request.body;

    // Verificar se agente destino pertence à empresa
    const agenteCheck = await pool.query(
      'SELECT id FROM agentes WHERE id = $1 AND empresa_id = $2',
      [agente_destino_id, empresa_id]
    );
    if (agenteCheck.rows.length === 0) {
      return reply.code(400).send({ success: false, error: 'Agente destino não encontrado nesta empresa' });
    }

    const result = await pool.query(`
      INSERT INTO automacoes_entrada (empresa_id, nome, url_api, metodo, headers_json, agente_destino_id, timeout_ms, ativo, ordem)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING *
    `, [
      empresa_id, nome, url_api,
      metodo || 'POST',
      headers_json ? JSON.stringify(headers_json) : '{}',
      agente_destino_id,
      timeout_ms || 5000,
      ativo ?? false,
      ordem ?? 0,
    ]);

    createLogger.info({ empresa_id, automacao_id: result.rows[0].id, nome }, 'Automação de entrada criada');
    return reply.code(201).send({ success: true, data: result.rows[0] });
  });

  /**
   * PUT /api/automacoes-entrada/:id
   * Atualizar automação
   */
  fastify.put('/:id', {
    preHandler: [fastify.authenticate, checkPermission(['master', 'admin'])],
    schema: {
      body: {
        type: 'object',
        properties: {
          nome: { type: 'string', minLength: 2, maxLength: 100 },
          url_api: { type: 'string', minLength: 5 },
          metodo: { type: 'string', enum: ['GET', 'POST'] },
          headers_json: { type: 'object' },
          agente_destino_id: { type: 'string', format: 'uuid' },
          timeout_ms: { type: 'integer', minimum: 1000, maximum: 30000 },
          ativo: { type: 'boolean' },
          ordem: { type: 'integer', minimum: 0 },
        },
      },
    },
  }, async (request, reply) => {
    const empresa_id = request.headers['x-empresa-id'] || request.user.empresa_id;
    const { id } = request.params;
    const { nome, url_api, metodo, headers_json, agente_destino_id, timeout_ms, ativo, ordem } = request.body;

    // Verificar se automação pertence à empresa
    const existing = await pool.query(
      'SELECT id FROM automacoes_entrada WHERE id = $1 AND empresa_id = $2',
      [id, empresa_id]
    );
    if (existing.rows.length === 0) {
      return reply.code(404).send({ success: false, error: 'Automação não encontrada' });
    }

    // Verificar agente destino se informado
    if (agente_destino_id) {
      const agenteCheck = await pool.query(
        'SELECT id FROM agentes WHERE id = $1 AND empresa_id = $2',
        [agente_destino_id, empresa_id]
      );
      if (agenteCheck.rows.length === 0) {
        return reply.code(400).send({ success: false, error: 'Agente destino não encontrado nesta empresa' });
      }
    }

    const result = await pool.query(`
      UPDATE automacoes_entrada SET
        nome = COALESCE($2, nome),
        url_api = COALESCE($3, url_api),
        metodo = COALESCE($4, metodo),
        headers_json = COALESCE($5, headers_json),
        agente_destino_id = COALESCE($6, agente_destino_id),
        timeout_ms = COALESCE($7, timeout_ms),
        ativo = COALESCE($8, ativo),
        ordem = COALESCE($9, ordem),
        atualizado_em = NOW()
      WHERE id = $1 AND empresa_id = $10
      RETURNING *
    `, [id, nome, url_api, metodo, headers_json ? JSON.stringify(headers_json) : null, agente_destino_id, timeout_ms, ativo, ordem, empresa_id]);

    createLogger.info({ empresa_id, automacao_id: id }, 'Automação de entrada atualizada');
    return { success: true, data: result.rows[0] };
  });

  /**
   * PATCH /api/automacoes-entrada/:id/toggle
   * Ativar/desativar automação
   */
  fastify.patch('/:id/toggle', {
    preHandler: [fastify.authenticate, checkPermission(['master', 'admin'])],
  }, async (request, reply) => {
    const empresa_id = request.headers['x-empresa-id'] || request.user.empresa_id;
    const { id } = request.params;

    const result = await pool.query(`
      UPDATE automacoes_entrada SET ativo = NOT ativo, atualizado_em = NOW()
      WHERE id = $1 AND empresa_id = $2
      RETURNING id, ativo
    `, [id, empresa_id]);

    if (result.rows.length === 0) {
      return reply.code(404).send({ success: false, error: 'Automação não encontrada' });
    }

    return { success: true, data: result.rows[0] };
  });

  /**
   * DELETE /api/automacoes-entrada/:id
   * Excluir automação
   */
  fastify.delete('/:id', {
    preHandler: [fastify.authenticate, checkPermission(['master', 'admin'])],
  }, async (request, reply) => {
    const empresa_id = request.headers['x-empresa-id'] || request.user.empresa_id;
    const { id } = request.params;

    const result = await pool.query(
      'DELETE FROM automacoes_entrada WHERE id = $1 AND empresa_id = $2 RETURNING id',
      [id, empresa_id]
    );

    if (result.rows.length === 0) {
      return reply.code(404).send({ success: false, error: 'Automação não encontrada' });
    }

    createLogger.info({ empresa_id, automacao_id: id }, 'Automação de entrada excluída');
    return { success: true };
  });

  /**
   * POST /api/automacoes-entrada/:id/testar
   * Testar automação com um telefone
   */
  fastify.post('/:id/testar', {
    preHandler: [fastify.authenticate, checkPermission(['master', 'admin'])],
    schema: {
      body: {
        type: 'object',
        required: ['telefone'],
        properties: {
          telefone: { type: 'string', minLength: 10, maxLength: 20 },
        },
      },
    },
  }, async (request, reply) => {
    const empresa_id = request.headers['x-empresa-id'] || request.user.empresa_id;
    const { id } = request.params;
    const { telefone } = request.body;

    const automacao = await pool.query(
      'SELECT * FROM automacoes_entrada WHERE id = $1 AND empresa_id = $2',
      [id, empresa_id]
    );

    if (automacao.rows.length === 0) {
      return reply.code(404).send({ success: false, error: 'Automação não encontrada' });
    }

    const auto = automacao.rows[0];

    try {
      const headers = { 'Content-Type': 'application/json', ...(auto.headers_json || {}) };
      const bodyPayload = JSON.stringify({ telefone, empresa_id });

      const fetchOptions = {
        method: auto.metodo || 'POST',
        headers,
        signal: AbortSignal.timeout(auto.timeout_ms || 5000),
      };

      if (auto.metodo !== 'GET') {
        fetchOptions.body = bodyPayload;
      }

      const startTime = Date.now();
      const response = await fetch(auto.url_api, fetchOptions);
      const latency = Date.now() - startTime;
      const rawData = await response.json();
      // Tolera resposta como objeto OU array (n8n costuma embrulhar em array)
      const data = Array.isArray(rawData) ? (rawData[0] || {}) : rawData;

      return {
        success: true,
        data: {
          status_code: response.status,
          latencia_ms: latency,
          resposta: rawData,
          match: data.match === true,
        },
      };
    } catch (err) {
      createLogger.error({ err, automacao_id: id }, 'Erro ao testar automação');
      return reply.code(502).send({
        success: false,
        error: `Erro ao chamar API: ${err.message}`,
      });
    }
  });
};

export default automacoesEntradaRoutes;
