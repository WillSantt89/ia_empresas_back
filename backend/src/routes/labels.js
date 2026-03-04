import { pool } from '../config/database.js';
import { logger } from '../config/logger.js';

export default async function labelsRoutes(fastify) {
  // ============================================
  // GET /api/labels — Listar labels da empresa
  // ============================================
  fastify.get('/', {
    preHandler: [
      fastify.authenticate,
      fastify.addTenantFilter,
      fastify.requirePermission('labels', 'read'),
    ],
  }, async (request, reply) => {
    const { empresaId } = request;

    const result = await pool.query(
      `SELECT l.*,
              (SELECT COUNT(*) FROM conversa_labels cl WHERE cl.label_id = l.id) as total_conversas
       FROM labels l
       WHERE l.empresa_id = $1 AND l.ativo = true
       ORDER BY l.nome`,
      [empresaId]
    );

    reply.send({ success: true, data: result.rows });
  });

  // ============================================
  // POST /api/labels — Criar label
  // ============================================
  fastify.post('/', {
    preHandler: [
      fastify.authenticate,
      fastify.addTenantFilter,
      fastify.requirePermission('labels', 'write'),
    ],
  }, async (request, reply) => {
    const { empresaId } = request;
    const { nome, cor, descricao } = request.body;

    if (!nome || nome.trim().length === 0) {
      return reply.status(400).send({ success: false, error: { message: 'Nome e obrigatorio' } });
    }

    // Verificar duplicado
    const existing = await pool.query(
      `SELECT id FROM labels WHERE empresa_id = $1 AND nome = $2 AND ativo = true`,
      [empresaId, nome.trim()]
    );
    if (existing.rows.length > 0) {
      return reply.status(409).send({ success: false, error: { message: 'Ja existe label com este nome' } });
    }

    const result = await pool.query(
      `INSERT INTO labels (empresa_id, nome, cor, descricao) VALUES ($1, $2, $3, $4) RETURNING *`,
      [empresaId, nome.trim(), cor || '#6B7280', descricao || null]
    );

    reply.status(201).send({ success: true, data: result.rows[0] });
  });

  // ============================================
  // PUT /api/labels/:id — Atualizar label
  // ============================================
  fastify.put('/:id', {
    preHandler: [
      fastify.authenticate,
      fastify.addTenantFilter,
      fastify.requirePermission('labels', 'write'),
    ],
  }, async (request, reply) => {
    const { id } = request.params;
    const { empresaId } = request;
    const { nome, cor, descricao } = request.body;

    const result = await pool.query(
      `UPDATE labels SET
         nome = COALESCE($1, nome),
         cor = COALESCE($2, cor),
         descricao = COALESCE($3, descricao)
       WHERE id = $4 AND empresa_id = $5
       RETURNING *`,
      [nome, cor, descricao, id, empresaId]
    );

    if (result.rows.length === 0) {
      return reply.status(404).send({ success: false, error: { message: 'Label nao encontrada' } });
    }

    reply.send({ success: true, data: result.rows[0] });
  });

  // ============================================
  // DELETE /api/labels/:id — Remover label
  // ============================================
  fastify.delete('/:id', {
    preHandler: [
      fastify.authenticate,
      fastify.addTenantFilter,
      fastify.requirePermission('labels', 'delete'),
    ],
  }, async (request, reply) => {
    const { id } = request.params;
    const { empresaId } = request;

    // Soft delete
    await pool.query(
      `UPDATE labels SET ativo = false WHERE id = $1 AND empresa_id = $2`,
      [id, empresaId]
    );

    // Remover associacoes
    await pool.query(
      `DELETE FROM conversa_labels WHERE label_id = $1`,
      [id]
    );

    reply.status(204).send();
  });
}
