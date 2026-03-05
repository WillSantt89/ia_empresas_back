import { pool } from '../config/database.js';
import { logger } from '../config/logger.js';

export default async function inboxesRoutes(fastify, opts) {
  // Listar inboxes
  fastify.get('/', {
    preHandler: [
      fastify.authenticate,
      fastify.addTenantFilter,
      fastify.requirePermission('inboxes', 'read')
    ],
    schema: {
      querystring: {
        type: 'object',
        properties: {
          ativo: { type: 'boolean' }
        }
      }
    }
  }, async (request, reply) => {
    try {
      const { empresaId } = request;
      const { ativo } = request.query;

      let query = `
        SELECT
          i.*,
          a.nome as agente_nome,
          a.tipo as agente_tipo,
          COUNT(DISTINCT wn.id) as total_numeros_vinculados,
          COUNT(DISTINCT c.id) as total_conversas_ativas
        FROM inboxes i
        LEFT JOIN agentes a ON a.id = i.agente_id
        LEFT JOIN whatsapp_numbers wn ON wn.inbox_id = i.id AND wn.ativo = true
        LEFT JOIN conversas c ON c.inbox_id = i.id AND c.status = 'ativo'
        WHERE i.empresa_id = $1
      `;

      const params = [empresaId];

      if (typeof ativo === 'boolean') {
        query += ' AND i.ativo = $2';
        params.push(ativo);
      }

      query += ' GROUP BY i.id, a.nome, a.tipo ORDER BY i.nome';

      const result = await pool.query(query, params);

      return {
        success: true,
        data: result.rows
      };
    } catch (error) {
      logger.error('Error listing inboxes:', error);
      throw error;
    }
  });

  // Criar inbox
  fastify.post('/', {
    preHandler: [
      fastify.authenticate,
      fastify.addTenantFilter,
      fastify.requirePermission('inboxes', 'write')
    ],
    schema: {
      body: {
        type: 'object',
        required: ['nome'],
        properties: {
          nome: { type: 'string', minLength: 1, maxLength: 100 },
          agente_id: { type: 'string', format: 'uuid' }
        }
      }
    }
  }, async (request, reply) => {
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      const { nome, agente_id } = request.body;
      const { empresaId } = request;

      // Validar agente se fornecido
      if (agente_id) {
        const agenteExists = await client.query(
          'SELECT id FROM agentes WHERE id = $1 AND empresa_id = $2 AND ativo = true',
          [agente_id, empresaId]
        );

        if (agenteExists.rows.length === 0) {
          return reply.code(400).send({
            success: false,
            error: {
              code: 'AGENTE_NOT_FOUND',
              message: 'Agente não encontrado ou inativo'
            }
          });
        }
      }

      // Criar inbox
      const result = await client.query(`
        INSERT INTO inboxes (
          id, empresa_id, nome,
          agente_id, ativo, criado_em
        )
        VALUES (
          gen_random_uuid(), $1, $2, $3, true, NOW()
        )
        RETURNING *
      `, [empresaId, nome, agente_id]);

      await client.query('COMMIT');

      logger.info(`Inbox created: ${result.rows[0].id} - ${nome}`);

      reply.code(201).send({
        success: true,
        data: result.rows[0]
      });
    } catch (error) {
      await client.query('ROLLBACK');
      logger.error('Error creating inbox:', error);
      throw error;
    } finally {
      client.release();
    }
  });

  // Obter detalhes de uma inbox
  fastify.get('/:id', {
    preHandler: [
      fastify.authenticate,
      fastify.addTenantFilter,
      fastify.requirePermission('inboxes', 'read')
    ],
    schema: {
      params: {
        type: 'object',
        required: ['id'],
        properties: {
          id: { type: 'string', format: 'uuid' }
        }
      }
    }
  }, async (request, reply) => {
    try {
      const { id } = request.params;
      const { empresaId } = request;

      const result = await pool.query(`
        SELECT
          i.*,
          a.nome as agente_nome,
          a.tipo as agente_tipo,
          a.modelo_llm as agente_modelo
        FROM inboxes i
        LEFT JOIN agentes a ON a.id = i.agente_id
        WHERE i.id = $1 AND i.empresa_id = $2
      `, [id, empresaId]);

      if (result.rows.length === 0) {
        return reply.code(404).send({
          success: false,
          error: {
            code: 'INBOX_NOT_FOUND',
            message: 'Inbox não encontrada'
          }
        });
      }

      const inbox = result.rows[0];

      // Buscar números vinculados
      const numerosResult = await pool.query(`
        SELECT
          id, nome_exibicao, phone_number_id,
          numero_formatado, ativo
        FROM whatsapp_numbers
        WHERE inbox_id = $1
        ORDER BY nome_exibicao
      `, [id]);

      inbox.numeros_whatsapp = numerosResult.rows;

      // Estatísticas
      const statsResult = await pool.query(`
        SELECT
          COUNT(DISTINCT c.id) FILTER (WHERE c.status = 'ativo') as conversas_ativas,
          COUNT(DISTINCT c.id) FILTER (WHERE c.criado_em >= CURRENT_DATE) as conversas_hoje,
          COUNT(DISTINCT at.id) FILTER (WHERE at.criado_em >= CURRENT_DATE) as atendimentos_hoje
        FROM conversas c
        LEFT JOIN atendimentos at ON at.conversa_id = c.id
        WHERE c.inbox_id = $1
      `, [id]);

      inbox.estatisticas = statsResult.rows[0];

      return {
        success: true,
        data: inbox
      };
    } catch (error) {
      logger.error('Error getting inbox details:', error);
      throw error;
    }
  });

  // Atualizar inbox
  fastify.put('/:id', {
    preHandler: [
      fastify.authenticate,
      fastify.addTenantFilter,
      fastify.requirePermission('inboxes', 'write')
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
          agente_id: { type: ['string', 'null'], format: 'uuid' },
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
      const { empresaId } = request;

      // Verificar se inbox existe
      const inboxResult = await client.query(
        'SELECT * FROM inboxes WHERE id = $1 AND empresa_id = $2',
        [id, empresaId]
      );

      if (inboxResult.rows.length === 0) {
        return reply.code(404).send({
          success: false,
          error: {
            code: 'INBOX_NOT_FOUND',
            message: 'Inbox não encontrada'
          }
        });
      }

      // Validar agente se fornecido
      if ('agente_id' in updates && updates.agente_id) {
        const agenteExists = await client.query(
          'SELECT id FROM agentes WHERE id = $1 AND empresa_id = $2 AND ativo = true',
          [updates.agente_id, empresaId]
        );

        if (agenteExists.rows.length === 0) {
          return reply.code(400).send({
            success: false,
            error: {
              code: 'AGENTE_NOT_FOUND',
              message: 'Agente não encontrado ou inativo'
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
        UPDATE inboxes
        SET ${fields.join(', ')}
        WHERE id = $${paramCount}
        RETURNING *
      `;

      const result = await client.query(updateQuery, values);

      // Se está desativando, verificar impactos
      if (updates.ativo === false) {
        // Verificar se há números ativos vinculados
        const numerosCount = await client.query(
          'SELECT COUNT(*) FROM whatsapp_numbers WHERE inbox_id = $1 AND ativo = true',
          [id]
        );

        if (parseInt(numerosCount.rows[0].count) > 0) {
          await client.query('ROLLBACK');
          return reply.code(400).send({
            success: false,
            error: {
              code: 'INBOX_HAS_ACTIVE_NUMBERS',
              message: `Não é possível desativar a inbox. ${numerosCount.rows[0].count} número(s) ativo(s) vinculado(s)`
            }
          });
        }
      }

      await client.query('COMMIT');

      logger.info(`Inbox updated: ${id}`);

      return {
        success: true,
        data: result.rows[0]
      };
    } catch (error) {
      await client.query('ROLLBACK');
      logger.error('Error updating inbox:', error);
      throw error;
    } finally {
      client.release();
    }
  });

  // Deletar inbox
  fastify.delete('/:id', {
    preHandler: [
      fastify.authenticate,
      fastify.addTenantFilter,
      fastify.requirePermission('inboxes', 'write')
    ],
    schema: {
      params: {
        type: 'object',
        required: ['id'],
        properties: {
          id: { type: 'string', format: 'uuid' }
        }
      }
    }
  }, async (request, reply) => {
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      const { id } = request.params;
      const { empresaId } = request;

      // Verificar se inbox existe
      const inboxResult = await client.query(
        'SELECT * FROM inboxes WHERE id = $1 AND empresa_id = $2',
        [id, empresaId]
      );

      if (inboxResult.rows.length === 0) {
        return reply.code(404).send({
          success: false,
          error: {
            code: 'INBOX_NOT_FOUND',
            message: 'Inbox não encontrada'
          }
        });
      }

      // Verificar dependências
      const dependencies = await client.query(`
        SELECT
          (SELECT COUNT(*) FROM whatsapp_numbers WHERE inbox_id = $1) as numeros,
          (SELECT COUNT(*) FROM conversas WHERE inbox_id = $1) as conversas
      `, [id]);

      const deps = dependencies.rows[0];

      if (parseInt(deps.numeros) > 0 || parseInt(deps.conversas) > 0) {
        return reply.code(400).send({
          success: false,
          error: {
            code: 'INBOX_HAS_DEPENDENCIES',
            message: `Não é possível deletar a inbox. Números: ${deps.numeros}, Conversas: ${deps.conversas}`
          }
        });
      }

      // Deletar inbox
      await client.query('DELETE FROM inboxes WHERE id = $1', [id]);

      await client.query('COMMIT');

      logger.info(`Inbox deleted: ${id}`);

      reply.code(204).send();
    } catch (error) {
      await client.query('ROLLBACK');
      logger.error('Error deleting inbox:', error);
      throw error;
    } finally {
      client.release();
    }
  });

}