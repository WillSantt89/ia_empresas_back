import { logger } from '../config/logger.js';
import { pool } from '../config/database.js';
import { checkPermission } from '../middleware/permission.js';
import { matchRegraRoteamento } from '../services/roteamento-inicial.js';

const createLogger = logger.child({ module: 'regras-roteamento-routes' });

const regrasRoteamentoRoutes = async (fastify) => {

  /**
   * GET /api/regras-roteamento
   * Lista regras da empresa (com nome da fila destino)
   */
  fastify.get('/', {
    preHandler: [fastify.authenticate, checkPermission(['master', 'admin_suporte', 'admin'])],
  }, async (request) => {
    const empresa_id = request.headers['x-empresa-id'] || request.user.empresa_id;
    const isMaster = request.user.role === 'master';

    let result;
    if (isMaster && !request.headers['x-empresa-id']) {
      result = await pool.query(`
        SELECT r.*, f.nome as fila_nome, e.nome as empresa_nome
        FROM regras_roteamento_inicial r
        LEFT JOIN filas_atendimento f ON f.id = r.fila_id
        LEFT JOIN empresas e ON e.id = r.empresa_id
        ORDER BY r.empresa_id, r.ordem ASC, r.criado_em ASC
      `);
    } else {
      result = await pool.query(`
        SELECT r.*, f.nome as fila_nome
        FROM regras_roteamento_inicial r
        LEFT JOIN filas_atendimento f ON f.id = r.fila_id
        WHERE r.empresa_id = $1
        ORDER BY r.ordem ASC, r.criado_em ASC
      `, [empresa_id]);
    }

    return { success: true, data: result.rows };
  });

  /**
   * POST /api/regras-roteamento
   * Cria nova regra
   */
  fastify.post('/', {
    preHandler: [fastify.authenticate, checkPermission(['master', 'admin_suporte', 'admin'])],
    schema: {
      body: {
        type: 'object',
        required: ['nome', 'fila_id', 'palavras_chave'],
        properties: {
          nome: { type: 'string', minLength: 2, maxLength: 100 },
          palavras_chave: {
            type: 'array',
            items: { type: 'string', minLength: 1, maxLength: 200 },
            minItems: 1,
            maxItems: 50,
          },
          modo_match: { type: 'string', enum: ['contains', 'exact'] },
          fila_id: { type: 'string', format: 'uuid' },
          resposta_automatica: { type: ['string', 'null'], maxLength: 1000 },
          ativo: { type: 'boolean' },
          ordem: { type: 'integer', minimum: 0 },
        },
      },
    },
  }, async (request, reply) => {
    const empresa_id = request.headers['x-empresa-id'] || request.user.empresa_id;
    const { nome, palavras_chave, modo_match, fila_id, resposta_automatica, ativo, ordem } = request.body;

    // Verificar se a fila pertence a empresa
    const filaCheck = await pool.query(
      'SELECT id FROM filas_atendimento WHERE id = $1 AND empresa_id = $2 AND ativo = true',
      [fila_id, empresa_id]
    );
    if (filaCheck.rows.length === 0) {
      return reply.code(400).send({ success: false, error: { message: 'Fila destino nao encontrada nesta empresa' } });
    }

    const result = await pool.query(`
      INSERT INTO regras_roteamento_inicial
        (empresa_id, nome, palavras_chave, modo_match, fila_id, resposta_automatica, ativo, ordem)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING *
    `, [
      empresa_id, nome, palavras_chave,
      modo_match || 'contains',
      fila_id,
      resposta_automatica || null,
      ativo ?? false,
      ordem ?? 0,
    ]);

    createLogger.info({ empresa_id, regra_id: result.rows[0].id, nome }, 'Regra de roteamento criada');
    return reply.code(201).send({ success: true, data: result.rows[0] });
  });

  /**
   * PUT /api/regras-roteamento/:id
   */
  fastify.put('/:id', {
    preHandler: [fastify.authenticate, checkPermission(['master', 'admin_suporte', 'admin'])],
    schema: {
      body: {
        type: 'object',
        properties: {
          nome: { type: 'string', minLength: 2, maxLength: 100 },
          palavras_chave: {
            type: 'array',
            items: { type: 'string', minLength: 1, maxLength: 200 },
            minItems: 1,
            maxItems: 50,
          },
          modo_match: { type: 'string', enum: ['contains', 'exact'] },
          fila_id: { type: 'string', format: 'uuid' },
          resposta_automatica: { type: ['string', 'null'], maxLength: 1000 },
          ativo: { type: 'boolean' },
          ordem: { type: 'integer', minimum: 0 },
        },
      },
    },
  }, async (request, reply) => {
    const empresa_id = request.headers['x-empresa-id'] || request.user.empresa_id;
    const { id } = request.params;
    const { nome, palavras_chave, modo_match, fila_id, resposta_automatica, ativo, ordem } = request.body;

    const existing = await pool.query(
      'SELECT id FROM regras_roteamento_inicial WHERE id = $1 AND empresa_id = $2',
      [id, empresa_id]
    );
    if (existing.rows.length === 0) {
      return reply.code(404).send({ success: false, error: { message: 'Regra nao encontrada' } });
    }

    if (fila_id) {
      const filaCheck = await pool.query(
        'SELECT id FROM filas_atendimento WHERE id = $1 AND empresa_id = $2 AND ativo = true',
        [fila_id, empresa_id]
      );
      if (filaCheck.rows.length === 0) {
        return reply.code(400).send({ success: false, error: { message: 'Fila destino nao encontrada nesta empresa' } });
      }
    }

    const result = await pool.query(`
      UPDATE regras_roteamento_inicial SET
        nome = COALESCE($2, nome),
        palavras_chave = COALESCE($3, palavras_chave),
        modo_match = COALESCE($4, modo_match),
        fila_id = COALESCE($5, fila_id),
        resposta_automatica = $6,
        ativo = COALESCE($7, ativo),
        ordem = COALESCE($8, ordem),
        atualizado_em = NOW()
      WHERE id = $1 AND empresa_id = $9
      RETURNING *
    `, [id, nome, palavras_chave, modo_match, fila_id,
        resposta_automatica === undefined ? null : resposta_automatica,
        ativo, ordem, empresa_id]);

    createLogger.info({ empresa_id, regra_id: id }, 'Regra de roteamento atualizada');
    return { success: true, data: result.rows[0] };
  });

  /**
   * PATCH /api/regras-roteamento/:id/toggle
   */
  fastify.patch('/:id/toggle', {
    preHandler: [fastify.authenticate, checkPermission(['master', 'admin_suporte', 'admin'])],
  }, async (request, reply) => {
    const empresa_id = request.headers['x-empresa-id'] || request.user.empresa_id;
    const { id } = request.params;

    const result = await pool.query(`
      UPDATE regras_roteamento_inicial SET ativo = NOT ativo, atualizado_em = NOW()
      WHERE id = $1 AND empresa_id = $2
      RETURNING id, ativo
    `, [id, empresa_id]);

    if (result.rows.length === 0) {
      return reply.code(404).send({ success: false, error: { message: 'Regra nao encontrada' } });
    }

    return { success: true, data: result.rows[0] };
  });

  /**
   * DELETE /api/regras-roteamento/:id
   */
  fastify.delete('/:id', {
    preHandler: [fastify.authenticate, checkPermission(['master', 'admin_suporte', 'admin'])],
  }, async (request, reply) => {
    const empresa_id = request.headers['x-empresa-id'] || request.user.empresa_id;
    const { id } = request.params;

    const result = await pool.query(
      'DELETE FROM regras_roteamento_inicial WHERE id = $1 AND empresa_id = $2 RETURNING id',
      [id, empresa_id]
    );

    if (result.rows.length === 0) {
      return reply.code(404).send({ success: false, error: { message: 'Regra nao encontrada' } });
    }

    createLogger.info({ empresa_id, regra_id: id }, 'Regra de roteamento excluida');
    return { success: true };
  });

  /**
   * POST /api/regras-roteamento/testar
   * Simula uma frase contra as regras ativas (sem persistir nada)
   */
  fastify.post('/testar', {
    preHandler: [fastify.authenticate, checkPermission(['master', 'admin_suporte', 'admin'])],
    schema: {
      body: {
        type: 'object',
        required: ['texto'],
        properties: {
          texto: { type: 'string', minLength: 1, maxLength: 2000 },
        },
      },
    },
  }, async (request) => {
    const empresa_id = request.headers['x-empresa-id'] || request.user.empresa_id;
    const { texto } = request.body;

    const match = await matchRegraRoteamento(empresa_id, texto);
    if (!match) {
      return { success: true, data: { match: false } };
    }

    // Buscar nome da fila pra UI
    const filaRes = await pool.query('SELECT nome FROM filas_atendimento WHERE id = $1', [match.fila_id]);
    return {
      success: true,
      data: {
        match: true,
        regra_id: match.regra_id,
        regra_nome: match.regra_nome,
        fila_id: match.fila_id,
        fila_nome: filaRes.rows[0]?.nome || null,
        resposta_automatica: match.resposta_automatica,
      },
    };
  });
};

export default regrasRoteamentoRoutes;
