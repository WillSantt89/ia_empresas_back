import { logger } from '../config/logger.js';
import { pool } from '../config/database.js';
import { checkPermission } from '../middleware/permission.js';

const createLogger = logger.child({ module: 'respostas-prontas-routes' });

const respostasProntasRoutes = async (fastify) => {

  /**
   * GET /api/respostas-prontas
   * Lista todas as respostas prontas da empresa
   * Acessível por todos os roles autenticados (operadores precisam para usar no chat)
   */
  fastify.get('/', {
    preHandler: [fastify.authenticate],
  }, async (request) => {
    const { empresa_id } = request.user;

    const result = await pool.query(`
      SELECT rp.id, rp.shortcode, rp.conteudo, rp.criado_por,
        u.nome as criado_por_nome, rp.criado_em, rp.atualizado_em
      FROM respostas_prontas rp
      LEFT JOIN usuarios u ON u.id = rp.criado_por
      WHERE rp.empresa_id = $1
      ORDER BY rp.shortcode ASC
    `, [empresa_id]);

    return { success: true, data: result.rows };
  });

  /**
   * POST /api/respostas-prontas
   * Criar nova resposta pronta
   */
  fastify.post('/', {
    preHandler: [fastify.authenticate, checkPermission(['master', 'admin'])],
    schema: {
      body: {
        type: 'object',
        required: ['shortcode', 'conteudo'],
        properties: {
          shortcode: { type: 'string', minLength: 2, maxLength: 50, pattern: '^[a-zA-Z0-9_-]+$' },
          conteudo: { type: 'string', minLength: 1, maxLength: 5000 },
        }
      }
    }
  }, async (request, reply) => {
    const { empresa_id, id: usuario_id } = request.user;
    const { shortcode, conteudo } = request.body;

    try {
      const result = await pool.query(`
        INSERT INTO respostas_prontas (empresa_id, shortcode, conteudo, criado_por)
        VALUES ($1, $2, $3, $4)
        RETURNING *
      `, [empresa_id, shortcode.toLowerCase(), conteudo, usuario_id]);

      createLogger.info({ empresa_id, shortcode }, 'Canned response created');
      return reply.code(201).send({ success: true, data: result.rows[0] });
    } catch (error) {
      if (error.code === '23505') {
        return reply.code(409).send({ success: false, error: 'Já existe uma resposta com este atalho' });
      }
      throw error;
    }
  });

  /**
   * PUT /api/respostas-prontas/:id
   * Atualizar resposta pronta
   */
  fastify.put('/:id', {
    preHandler: [fastify.authenticate, checkPermission(['master', 'admin'])],
    schema: {
      body: {
        type: 'object',
        properties: {
          shortcode: { type: 'string', minLength: 2, maxLength: 50, pattern: '^[a-zA-Z0-9_-]+$' },
          conteudo: { type: 'string', minLength: 1, maxLength: 5000 },
        }
      }
    }
  }, async (request, reply) => {
    const { empresa_id } = request.user;
    const { id } = request.params;
    const { shortcode, conteudo } = request.body;

    const updates = [];
    const params = [id, empresa_id];
    let paramIndex = 3;

    if (shortcode !== undefined) { updates.push(`shortcode = $${paramIndex++}`); params.push(shortcode.toLowerCase()); }
    if (conteudo !== undefined) { updates.push(`conteudo = $${paramIndex++}`); params.push(conteudo); }

    if (updates.length === 0) {
      return reply.code(400).send({ success: false, error: 'Nenhum campo para atualizar' });
    }

    updates.push('atualizado_em = NOW()');

    try {
      const result = await pool.query(
        `UPDATE respostas_prontas SET ${updates.join(', ')} WHERE id = $1 AND empresa_id = $2 RETURNING *`,
        params
      );

      if (result.rows.length === 0) {
        return reply.code(404).send({ success: false, error: 'Resposta não encontrada' });
      }

      createLogger.info({ empresa_id, id }, 'Canned response updated');
      return { success: true, data: result.rows[0] };
    } catch (error) {
      if (error.code === '23505') {
        return reply.code(409).send({ success: false, error: 'Já existe uma resposta com este atalho' });
      }
      throw error;
    }
  });

  /**
   * DELETE /api/respostas-prontas/:id
   * Excluir resposta pronta
   */
  fastify.delete('/:id', {
    preHandler: [fastify.authenticate, checkPermission(['master', 'admin'])],
  }, async (request, reply) => {
    const { empresa_id } = request.user;
    const { id } = request.params;

    const result = await pool.query(
      'DELETE FROM respostas_prontas WHERE id = $1 AND empresa_id = $2 RETURNING id',
      [id, empresa_id]
    );

    if (result.rows.length === 0) {
      return reply.code(404).send({ success: false, error: 'Resposta não encontrada' });
    }

    createLogger.info({ empresa_id, id }, 'Canned response deleted');
    return { success: true };
  });
};

export default respostasProntasRoutes;
