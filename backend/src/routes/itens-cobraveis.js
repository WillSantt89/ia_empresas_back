import { pool } from '../config/database.js';
import { logger } from '../config/logger.js';

export default async function itensCobraveisRoutes(fastify, opts) {
  // Listar itens cobráveis
  fastify.get('/', {
    preHandler: [
      fastify.authenticate,
      fastify.requirePermission('itens_cobraveis', 'read')
    ],
    schema: {
      querystring: {
        type: 'object',
        properties: {
          ativo: { type: 'boolean' },
          include_faixas: { type: 'boolean', default: true }
        }
      }
    }
  }, async (request, reply) => {
    try {
      const { ativo, include_faixas } = request.query;

      let query = `
        SELECT
          ic.*,
          COUNT(DISTINCT ai.id) as total_assinaturas
        FROM itens_cobraveis ic
        LEFT JOIN assinatura_itens ai ON ai.item_cobravel_id = ic.id AND ai.ativo = true
      `;

      const params = [];
      const conditions = [];

      if (typeof ativo === 'boolean') {
        conditions.push(`ic.ativo = $${params.length + 1}`);
        params.push(ativo);
      }

      if (conditions.length > 0) {
        query += ` WHERE ${conditions.join(' AND ')}`;
      }

      query += ` GROUP BY ic.id ORDER BY ic.nome ASC`;

      const result = await pool.query(query, params);

      // Se solicitado, incluir faixas para itens por_faixa
      if (include_faixas) {
        for (const item of result.rows) {
          if (item.tipo_cobranca === 'por_faixa') {
            const faixas = await pool.query(
              'SELECT * FROM faixas_item WHERE item_cobravel_id = $1 ORDER BY ativo DESC, limite_diario ASC',
              [item.id]
            );
            item.faixas = faixas.rows;
          }
        }
      }

      return {
        success: true,
        data: result.rows
      };
    } catch (error) {
      logger.error('Error listing itens cobráveis:', error);
      throw error;
    }
  });

  // Criar item cobrável
  fastify.post('/', {
    preHandler: [
      fastify.authenticate,
      fastify.requirePermission('itens_cobraveis', 'write')
    ],
    schema: {
      body: {
        type: 'object',
        required: ['slug', 'nome', 'tipo_cobranca'],
        properties: {
          slug: { type: 'string', pattern: '^[a-z0-9_]+$' },
          nome: { type: 'string', minLength: 1, maxLength: 100 },
          descricao: { type: 'string' },
          tipo_cobranca: { type: 'string', enum: ['por_faixa', 'preco_fixo'] },
          preco_fixo: { type: 'number', minimum: 0 }
        }
      }
    }
  }, async (request, reply) => {
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      const {
        slug,
        nome,
        descricao,
        tipo_cobranca,
        preco_fixo
      } = request.body;

      // Validar preco_fixo
      if (tipo_cobranca === 'preco_fixo' && !preco_fixo) {
        return reply.code(400).send({
          success: false,
          error: {
            code: 'PRECO_REQUIRED',
            message: 'Preço fixo é obrigatório para tipo preco_fixo'
          }
        });
      }

      // Verificar se slug já existe
      const exists = await client.query(
        'SELECT id FROM itens_cobraveis WHERE slug = $1',
        [slug]
      );

      if (exists.rows.length > 0) {
        return reply.code(409).send({
          success: false,
          error: {
            code: 'SLUG_EXISTS',
            message: 'Já existe um item com este slug'
          }
        });
      }

      const result = await client.query(`
        INSERT INTO itens_cobraveis (
          id, slug, nome, descricao, tipo_cobranca,
          preco_fixo, ativo, criado_em
        )
        VALUES (
          gen_random_uuid(), $1, $2, $3, $4, $5, true, NOW()
        )
        RETURNING *
      `, [
        slug,
        nome,
        descricao,
        tipo_cobranca,
        tipo_cobranca === 'preco_fixo' ? preco_fixo : null
      ]);

      await client.query('COMMIT');

      logger.info(`Item cobrável created: ${result.rows[0].id} - ${slug}`);

      reply.code(201).send({
        success: true,
        data: result.rows[0]
      });
    } catch (error) {
      await client.query('ROLLBACK');
      logger.error('Error creating item cobrável:', error);
      throw error;
    } finally {
      client.release();
    }
  });

  // Atualizar item cobrável
  fastify.put('/:id', {
    preHandler: [
      fastify.authenticate,
      fastify.requirePermission('itens_cobraveis', 'write')
    ],
    schema: {
      params: {
        type: 'object',
        required: ['id'],
        properties: {
          id: { type: 'string', format: 'uuid' }
        }
      },
      body: {
        type: 'object',
        properties: {
          nome: { type: 'string', minLength: 1, maxLength: 100 },
          descricao: { type: 'string' },
          preco_fixo: { type: 'number', minimum: 0 },
          ativo: { type: 'boolean' }
        }
      }
    }
  }, async (request, reply) => {
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      const { id } = request.params;
      const updates = request.body;

      // Verificar se item existe
      const item = await client.query(
        'SELECT * FROM itens_cobraveis WHERE id = $1',
        [id]
      );

      if (item.rows.length === 0) {
        return reply.code(404).send({
          success: false,
          error: {
            code: 'ITEM_NOT_FOUND',
            message: 'Item cobrável não encontrado'
          }
        });
      }

      // Validar preco_fixo
      if ('preco_fixo' in updates && item.rows[0].tipo_cobranca !== 'preco_fixo') {
        return reply.code(400).send({
          success: false,
          error: {
            code: 'INVALID_UPDATE',
            message: 'Não é possível definir preço fixo para item do tipo por_faixa'
          }
        });
      }

      // Montar query de update
      const fields = [];
      const values = [];
      let paramCount = 1;

      // Não permitir alterar slug ou tipo_cobranca
      const allowedFields = ['nome', 'descricao', 'preco_fixo', 'ativo'];

      Object.entries(updates).forEach(([key, value]) => {
        if (allowedFields.includes(key)) {
          fields.push(`${key} = $${paramCount}`);
          values.push(value);
          paramCount++;
        }
      });

      if (fields.length === 0) {
        return reply.code(400).send({
          success: false,
          error: {
            code: 'NO_UPDATES',
            message: 'Nenhum campo para atualizar'
          }
        });
      }

      values.push(id);

      const updateQuery = `
        UPDATE itens_cobraveis
        SET ${fields.join(', ')}
        WHERE id = $${paramCount}
        RETURNING *
      `;

      const result = await client.query(updateQuery, values);

      // Se está desativando, verificar se há assinaturas ativas
      if (updates.ativo === false) {
        const assinaturasCount = await client.query(
          'SELECT COUNT(*) FROM assinatura_itens WHERE item_cobravel_id = $1 AND ativo = true',
          [id]
        );

        if (parseInt(assinaturasCount.rows[0].count) > 0) {
          await client.query('ROLLBACK');
          return reply.code(400).send({
            success: false,
            error: {
              code: 'ITEM_IN_USE',
              message: `Não é possível desativar o item. ${assinaturasCount.rows[0].count} assinatura(s) ativa(s) usando este item`
            }
          });
        }
      }

      await client.query('COMMIT');

      logger.info(`Item cobrável updated: ${id}`);

      return {
        success: true,
        data: result.rows[0]
      };
    } catch (error) {
      await client.query('ROLLBACK');
      logger.error('Error updating item cobrável:', error);
      throw error;
    } finally {
      client.release();
    }
  });

  // Listar faixas de um item
  fastify.get('/:itemId/faixas', {
    preHandler: [
      fastify.authenticate,
      fastify.requirePermission('itens_cobraveis', 'read')
    ],
    schema: {
      params: {
        type: 'object',
        required: ['itemId'],
        properties: {
          itemId: { type: 'string', format: 'uuid' }
        }
      }
    }
  }, async (request, reply) => {
    try {
      const { itemId } = request.params;

      // Verificar se item existe e é por_faixa
      const item = await pool.query(
        'SELECT * FROM itens_cobraveis WHERE id = $1',
        [itemId]
      );

      if (item.rows.length === 0) {
        return reply.code(404).send({
          success: false,
          error: {
            code: 'ITEM_NOT_FOUND',
            message: 'Item cobrável não encontrado'
          }
        });
      }

      if (item.rows[0].tipo_cobranca !== 'por_faixa') {
        return reply.code(400).send({
          success: false,
          error: {
            code: 'NOT_FAIXA_ITEM',
            message: 'Este item não é do tipo por_faixa'
          }
        });
      }

      const result = await pool.query(`
        SELECT
          f.*,
          COUNT(DISTINCT ai.id) as total_assinaturas
        FROM faixas_item f
        LEFT JOIN assinatura_itens ai ON ai.faixa_id = f.id AND ai.ativo = true
        WHERE f.item_cobravel_id = $1
        GROUP BY f.id
        ORDER BY f.limite_diario ASC
      `, [itemId]);

      return {
        success: true,
        data: result.rows
      };
    } catch (error) {
      logger.error('Error listing faixas:', error);
      throw error;
    }
  });

  // Criar faixa
  fastify.post('/:itemId/faixas', {
    preHandler: [
      fastify.authenticate,
      fastify.requirePermission('itens_cobraveis', 'write')
    ],
    schema: {
      params: {
        type: 'object',
        required: ['itemId'],
        properties: {
          itemId: { type: 'string', format: 'uuid' }
        }
      },
      body: {
        type: 'object',
        required: ['nome', 'limite_diario', 'preco_mensal'],
        properties: {
          nome: { type: 'string', minLength: 1, maxLength: 100 },
          limite_diario: { type: 'integer', minimum: 1 },
          preco_mensal: { type: 'number', minimum: 0 }
        }
      }
    }
  }, async (request, reply) => {
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      const { itemId } = request.params;
      const { nome, limite_diario, preco_mensal } = request.body;

      // Verificar se item existe e é por_faixa
      const item = await client.query(
        'SELECT * FROM itens_cobraveis WHERE id = $1',
        [itemId]
      );

      if (item.rows.length === 0) {
        return reply.code(404).send({
          success: false,
          error: {
            code: 'ITEM_NOT_FOUND',
            message: 'Item cobrável não encontrado'
          }
        });
      }

      if (item.rows[0].tipo_cobranca !== 'por_faixa') {
        return reply.code(400).send({
          success: false,
          error: {
            code: 'NOT_FAIXA_ITEM',
            message: 'Este item não é do tipo por_faixa'
          }
        });
      }

      // Verificar se já existe faixa com mesmo limite
      const exists = await client.query(
        'SELECT id FROM faixas_item WHERE item_cobravel_id = $1 AND limite_diario = $2',
        [itemId, limite_diario]
      );

      if (exists.rows.length > 0) {
        return reply.code(409).send({
          success: false,
          error: {
            code: 'LIMITE_EXISTS',
            message: 'Já existe uma faixa com este limite diário'
          }
        });
      }

      const result = await client.query(`
        INSERT INTO faixas_item (
          id, item_cobravel_id, nome, limite_diario,
          preco_mensal, ativo, criado_em
        )
        VALUES (
          gen_random_uuid(), $1, $2, $3, $4, true, NOW()
        )
        RETURNING *
      `, [itemId, nome, limite_diario, preco_mensal]);

      await client.query('COMMIT');

      logger.info(`Faixa created: ${result.rows[0].id} for item ${itemId}`);

      reply.code(201).send({
        success: true,
        data: result.rows[0]
      });
    } catch (error) {
      await client.query('ROLLBACK');
      logger.error('Error creating faixa:', error);
      throw error;
    } finally {
      client.release();
    }
  });

  // Atualizar faixa
  fastify.put('/faixas/:id', {
    preHandler: [
      fastify.authenticate,
      fastify.requirePermission('itens_cobraveis', 'write')
    ],
    schema: {
      params: {
        type: 'object',
        required: ['id'],
        properties: {
          id: { type: 'string', format: 'uuid' }
        }
      },
      body: {
        type: 'object',
        properties: {
          nome: { type: 'string', minLength: 1, maxLength: 100 },
          limite_diario: { type: 'integer', minimum: 1 },
          preco_mensal: { type: 'number', minimum: 0 },
          ativo: { type: 'boolean' }
        }
      }
    }
  }, async (request, reply) => {
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      const { id } = request.params;
      const updates = request.body;

      // Verificar se faixa existe
      const faixa = await client.query(
        'SELECT * FROM faixas_item WHERE id = $1',
        [id]
      );

      if (faixa.rows.length === 0) {
        return reply.code(404).send({
          success: false,
          error: {
            code: 'FAIXA_NOT_FOUND',
            message: 'Faixa não encontrada'
          }
        });
      }

      // Se está alterando limite_diario, verificar duplicação
      if ('limite_diario' in updates && updates.limite_diario !== faixa.rows[0].limite_diario) {
        const exists = await client.query(
          'SELECT id FROM faixas_item WHERE item_cobravel_id = $1 AND limite_diario = $2 AND id != $3',
          [faixa.rows[0].item_cobravel_id, updates.limite_diario, id]
        );

        if (exists.rows.length > 0) {
          return reply.code(409).send({
            success: false,
            error: {
              code: 'LIMITE_EXISTS',
              message: 'Já existe outra faixa com este limite diário'
            }
          });
        }
      }

      // Montar query de update
      const fields = [];
      const values = [];
      let paramCount = 1;

      Object.entries(updates).forEach(([key, value]) => {
        fields.push(`${key} = $${paramCount}`);
        values.push(value);
        paramCount++;
      });

      if (fields.length === 0) {
        return reply.code(400).send({
          success: false,
          error: {
            code: 'NO_UPDATES',
            message: 'Nenhum campo para atualizar'
          }
        });
      }

      values.push(id);

      const updateQuery = `
        UPDATE faixas_item
        SET ${fields.join(', ')}
        WHERE id = $${paramCount}
        RETURNING *
      `;

      const result = await client.query(updateQuery, values);

      // Se está desativando, verificar se há assinaturas usando
      if (updates.ativo === false) {
        const assinaturasCount = await client.query(
          'SELECT COUNT(*) FROM assinatura_itens WHERE faixa_id = $1 AND ativo = true',
          [id]
        );

        if (parseInt(assinaturasCount.rows[0].count) > 0) {
          await client.query('ROLLBACK');
          return reply.code(400).send({
            success: false,
            error: {
              code: 'FAIXA_IN_USE',
              message: `Não é possível desativar a faixa. ${assinaturasCount.rows[0].count} assinatura(s) ativa(s) usando esta faixa`
            }
          });
        }
      }

      await client.query('COMMIT');

      logger.info(`Faixa updated: ${id}`);

      return {
        success: true,
        data: result.rows[0]
      };
    } catch (error) {
      await client.query('ROLLBACK');
      logger.error('Error updating faixa:', error);
      throw error;
    } finally {
      client.release();
    }
  });
}