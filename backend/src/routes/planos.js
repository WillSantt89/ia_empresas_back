import { pool } from '../config/database.js';
import { logger } from '../config/logger.js';

export default async function planosRoutes(fastify, opts) {
  // Listar planos
  fastify.get('/', {
    preHandler: [
      fastify.authenticate,
      fastify.requirePermission('planos', 'read')
    ],
    schema: {
      querystring: {
        type: 'object',
        properties: {
          ativo: { type: 'boolean' }
        }
      },
    }
  }, async (request, reply) => {
    try {
      const { ativo } = request.query;

      let query = `
        SELECT
          p.*,
          COUNT(DISTINCT e.id) as total_empresas
        FROM planos p
        LEFT JOIN empresas e ON e.plano_id = p.id AND e.ativo = true
      `;

      const params = [];
      const conditions = [];

      if (typeof ativo === 'boolean') {
        conditions.push(`p.ativo = $${params.length + 1}`);
        params.push(ativo);
      }

      if (conditions.length > 0) {
        query += ` WHERE ${conditions.join(' AND ')}`;
      }

      query += ` GROUP BY p.id ORDER BY p.preco_base_mensal ASC`;

      const result = await pool.query(query, params);

      return {
        success: true,
        data: result.rows
      };
    } catch (error) {
      logger.error('Error listing planos:', error);
      throw error;
    }
  });

  // Criar plano
  fastify.post('/', {
    preHandler: [
      fastify.authenticate,
      fastify.requirePermission('planos', 'write')
    ],
    schema: {
      body: {
        type: 'object',
        required: ['nome', 'preco_base_mensal'],
        properties: {
          nome: { type: 'string', minLength: 1, maxLength: 100 },
          descricao: { type: 'string' },
          preco_base_mensal: { type: 'number', minimum: 0 },
          max_usuarios: { type: 'integer', minimum: 1, default: 3 },
          max_tools: { type: 'integer', minimum: 0, default: 10 },
          max_mensagens_mes: { type: 'integer', minimum: 0, default: 0 },
          permite_modelo_pro: { type: 'boolean', default: false },
          creditos_ia_mensal: { type: 'integer', minimum: 0, default: 0 },
          max_agentes: { type: 'integer', minimum: 0, default: 0 },
          max_conexoes_whatsapp: { type: 'integer', minimum: 0, default: 0 },
          chatbot_incluso: { type: 'boolean', default: false },
          tipo: { type: 'string', enum: ['chat', 'ia', 'trafego'], default: 'ia' }
        }
      }
    }
  }, async (request, reply) => {
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      const {
        nome,
        descricao,
        preco_base_mensal,
        max_usuarios,
        max_tools,
        max_mensagens_mes,
        permite_modelo_pro,
        creditos_ia_mensal,
        max_agentes,
        max_conexoes_whatsapp,
        chatbot_incluso,
        tipo,
      } = request.body;

      // Verificar se nome já existe
      const exists = await client.query(
        'SELECT id FROM planos WHERE LOWER(nome) = LOWER($1)',
        [nome]
      );

      if (exists.rows.length > 0) {
        return reply.code(409).send({
          success: false,
          error: {
            code: 'PLANO_EXISTS',
            message: 'Já existe um plano com este nome'
          }
        });
      }

      const result = await client.query(`
        INSERT INTO planos (
          id, nome, descricao, preco_base_mensal,
          max_usuarios, max_tools, max_mensagens_mes,
          permite_modelo_pro, creditos_ia_mensal, max_agentes,
          max_conexoes_whatsapp, chatbot_incluso, tipo,
          ativo, criado_em, atualizado_em
        )
        VALUES (
          gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, true, NOW(), NOW()
        )
        RETURNING *
      `, [
        nome,
        descricao,
        preco_base_mensal,
        max_usuarios,
        max_tools,
        max_mensagens_mes,
        permite_modelo_pro,
        creditos_ia_mensal || 0,
        max_agentes || 0,
        max_conexoes_whatsapp || 0,
        chatbot_incluso || false,
        tipo || 'ia',
      ]);

      await client.query('COMMIT');

      logger.info(`Plano created: ${result.rows[0].id} - ${nome}`);

      reply.code(201).send({
        success: true,
        data: result.rows[0]
      });
    } catch (error) {
      await client.query('ROLLBACK');
      logger.error('Error creating plano:', error);
      throw error;
    } finally {
      client.release();
    }
  });

  // Atualizar plano
  fastify.put('/:id', {
    preHandler: [
      fastify.authenticate,
      fastify.requirePermission('planos', 'write')
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
          preco_base_mensal: { type: 'number', minimum: 0 },
          max_usuarios: { type: 'integer', minimum: 1 },
          max_tools: { type: 'integer', minimum: 0 },
          max_mensagens_mes: { type: 'integer', minimum: 0 },
          permite_modelo_pro: { type: 'boolean' },
          creditos_ia_mensal: { type: 'integer', minimum: 0 },
          max_agentes: { type: 'integer', minimum: 0 },
          max_conexoes_whatsapp: { type: 'integer', minimum: 0 },
          chatbot_incluso: { type: 'boolean' },
          tipo: { type: 'string', enum: ['chat', 'ia', 'trafego'] },
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

      // Verificar se plano existe
      const plano = await client.query(
        'SELECT * FROM planos WHERE id = $1',
        [id]
      );

      if (plano.rows.length === 0) {
        return reply.code(404).send({
          success: false,
          error: {
            code: 'PLANO_NOT_FOUND',
            message: 'Plano não encontrado'
          }
        });
      }

      // Se está alterando o nome, verificar duplicação
      if (updates.nome && updates.nome !== plano.rows[0].nome) {
        const exists = await client.query(
          'SELECT id FROM planos WHERE LOWER(nome) = LOWER($1) AND id != $2',
          [updates.nome, id]
        );

        if (exists.rows.length > 0) {
          return reply.code(409).send({
            success: false,
            error: {
              code: 'PLANO_NAME_EXISTS',
              message: 'Já existe outro plano com este nome'
            }
          });
        }
      }

      // Montar query de update dinâmica
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

      fields.push('atualizado_em = NOW()');
      values.push(id);

      const updateQuery = `
        UPDATE planos
        SET ${fields.join(', ')}
        WHERE id = $${paramCount}
        RETURNING *
      `;

      const result = await client.query(updateQuery, values);

      // Se está desativando o plano, verificar se há empresas usando
      if (updates.ativo === false) {
        const empresasCount = await client.query(
          'SELECT COUNT(*) FROM empresas WHERE plano_id = $1 AND ativo = true',
          [id]
        );

        if (parseInt(empresasCount.rows[0].count) > 0) {
          await client.query('ROLLBACK');
          return reply.code(400).send({
            success: false,
            error: {
              code: 'PLANO_IN_USE',
              message: `Não é possível desativar o plano. ${empresasCount.rows[0].count} empresa(s) ativa(s) usando este plano`
            }
          });
        }
      }

      await client.query('COMMIT');

      logger.info(`Plano updated: ${id}`);

      return {
        success: true,
        data: result.rows[0]
      };
    } catch (error) {
      await client.query('ROLLBACK');
      logger.error('Error updating plano:', error);
      throw error;
    } finally {
      client.release();
    }
  });
}