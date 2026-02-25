import { pool } from '../config/database.js';
import { logger } from '../config/logger.js';

export default async function transferenciasRoutes(fastify, opts) {
  // Listar regras de transferência de um agente
  fastify.get('/:agenteId/transferencias', {
    preHandler: [
      fastify.authenticate,
      fastify.addTenantFilter,
      fastify.requirePermission('agentes', 'read')
    ],
    schema: {
      params: {
        type: 'object',
        required: ['agenteId'],
        properties: {
          agenteId: { type: 'string', format: 'uuid' }
        }
      },
      querystring: {
        type: 'object',
        properties: {
          ativo: { type: 'boolean' }
        }
      }
    }
  }, async (request, reply) => {
    try {
      const { agenteId } = request.params;
      const { ativo } = request.query;
      const { empresaId } = request;

      // Verificar se agente existe e pertence à empresa
      const agenteExists = await pool.query(
        'SELECT id, nome FROM agentes WHERE id = $1 AND empresa_id = $2',
        [agenteId, empresaId]
      );

      if (agenteExists.rows.length === 0) {
        return reply.code(404).send({
          success: false,
          error: {
            code: 'AGENTE_NOT_FOUND',
            message: 'Agente não encontrado'
          }
        });
      }

      // Buscar transferências
      let query = `
        SELECT
          t.*,
          ao.nome as agente_origem_nome,
          ad.nome as agente_destino_nome
        FROM agente_transferencias t
        JOIN agentes ao ON ao.id = t.agente_origem_id
        JOIN agentes ad ON ad.id = t.agente_destino_id
        WHERE t.agente_origem_id = $1 AND t.empresa_id = $2
      `;

      const params = [agenteId, empresaId];

      if (typeof ativo === 'boolean') {
        query += ' AND t.ativo = $3';
        params.push(ativo);
      }

      query += ' ORDER BY t.trigger_tipo, t.trigger_valor';

      const result = await pool.query(query, params);

      return {
        success: true,
        data: {
          agente_id: agenteId,
          agente_nome: agenteExists.rows[0].nome,
          transferencias: result.rows.map(row => ({
            ...row,
            trigger_valores: row.trigger_valor ? row.trigger_valor.split(',').map(v => v.trim()) : []
          }))
        }
      };
    } catch (error) {
      logger.error('Error listing transferencias:', error);
      throw error;
    }
  });

  // Criar regra de transferência
  fastify.post('/:agenteId/transferencias', {
    preHandler: [
      fastify.authenticate,
      fastify.addTenantFilter,
      fastify.requirePermission('agentes', 'write')
    ],
    schema: {
      body: {
        type: 'object',
        required: ['agente_destino_id', 'trigger_tipo', 'trigger_valores'],
        properties: {
          agente_destino_id: { type: 'string', format: 'uuid' },
          trigger_tipo: { type: 'string', enum: ['tool_result', 'keyword', 'menu_opcao'] },
          trigger_valores: {
            type: 'array',
            items: { type: 'string' },
            minItems: 1
          },
          transferir_historico: { type: 'boolean', default: true }
        }
      },
      params: {
        type: 'object',
        required: ['agenteId'],
        properties: {
          agenteId: { type: 'string', format: 'uuid' }
        }
      }
    }
  }, async (request, reply) => {
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      const { agenteId } = request.params;
      const { agente_destino_id, trigger_tipo, trigger_valores, transferir_historico } = request.body;
      const { empresaId } = request;

      // Verificar se agente origem existe
      const agenteOrigemExists = await client.query(
        'SELECT id FROM agentes WHERE id = $1 AND empresa_id = $2 AND ativo = true',
        [agenteId, empresaId]
      );

      if (agenteOrigemExists.rows.length === 0) {
        return reply.code(404).send({
          success: false,
          error: {
            code: 'AGENTE_ORIGEM_NOT_FOUND',
            message: 'Agente origem não encontrado'
          }
        });
      }

      // Verificar se agente destino existe
      const agenteDestinoExists = await client.query(
        'SELECT id FROM agentes WHERE id = $1 AND empresa_id = $2 AND ativo = true',
        [agente_destino_id, empresaId]
      );

      if (agenteDestinoExists.rows.length === 0) {
        return reply.code(404).send({
          success: false,
          error: {
            code: 'AGENTE_DESTINO_NOT_FOUND',
            message: 'Agente destino não encontrado'
          }
        });
      }

      // Verificar se não está criando loop
      if (agenteId === agente_destino_id) {
        return reply.code(400).send({
          success: false,
          error: {
            code: 'SELF_TRANSFER',
            message: 'Não é possível criar transferência para o mesmo agente'
          }
        });
      }

      // Verificar se já existe regra com mesmo trigger
      const triggerValor = trigger_valores.join(',').toLowerCase();

      const existingRule = await client.query(`
        SELECT id FROM agente_transferencias
        WHERE agente_origem_id = $1
          AND trigger_tipo = $2
          AND LOWER(trigger_valor) = $3
          AND ativo = true
      `, [agenteId, trigger_tipo, triggerValor]);

      if (existingRule.rows.length > 0) {
        return reply.code(409).send({
          success: false,
          error: {
            code: 'RULE_EXISTS',
            message: 'Já existe uma regra ativa com este trigger'
          }
        });
      }

      // Criar transferência
      const result = await client.query(`
        INSERT INTO agente_transferencias (
          id, empresa_id, agente_origem_id, agente_destino_id,
          trigger_tipo, trigger_valor, transferir_historico,
          ativo, criado_em
        )
        VALUES (
          gen_random_uuid(), $1, $2, $3, $4, $5, $6, true, NOW()
        )
        RETURNING *
      `, [
        empresaId,
        agenteId,
        agente_destino_id,
        trigger_tipo,
        triggerValor,
        transferir_historico
      ]);

      await client.query('COMMIT');

      logger.info(`Transfer rule created: ${agenteId} -> ${agente_destino_id}`);

      reply.code(201).send({
        success: true,
        data: {
          ...result.rows[0],
          trigger_valores: trigger_valores
        }
      });
    } catch (error) {
      await client.query('ROLLBACK');
      logger.error('Error creating transferencia:', error);
      throw error;
    } finally {
      client.release();
    }
  });

  // Atualizar regra de transferência
  fastify.put('/:id', {
    preHandler: [
      fastify.authenticate,
      fastify.addTenantFilter,
      fastify.requirePermission('agentes', 'write')
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
          agente_destino_id: { type: 'string', format: 'uuid' },
          trigger_tipo: { type: 'string', enum: ['tool_result', 'keyword', 'menu_opcao'] },
          trigger_valores: {
            type: 'array',
            items: { type: 'string' },
            minItems: 1
          },
          transferir_historico: { type: 'boolean' },
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

      // Verificar se transferência existe
      const transferenciaResult = await client.query(
        'SELECT * FROM agente_transferencias WHERE id = $1 AND empresa_id = $2',
        [id, empresaId]
      );

      if (transferenciaResult.rows.length === 0) {
        return reply.code(404).send({
          success: false,
          error: {
            code: 'TRANSFERENCIA_NOT_FOUND',
            message: 'Transferência não encontrada'
          }
        });
      }

      const transferencia = transferenciaResult.rows[0];

      // Validar agente destino se fornecido
      if (updates.agente_destino_id) {
        const agenteDestinoExists = await client.query(
          'SELECT id FROM agentes WHERE id = $1 AND empresa_id = $2 AND ativo = true',
          [updates.agente_destino_id, empresaId]
        );

        if (agenteDestinoExists.rows.length === 0) {
          return reply.code(404).send({
            success: false,
            error: {
              code: 'AGENTE_DESTINO_NOT_FOUND',
              message: 'Agente destino não encontrado'
            }
          });
        }

        // Verificar se não está criando loop
        if (updates.agente_destino_id === transferencia.agente_origem_id) {
          return reply.code(400).send({
            success: false,
            error: {
              code: 'SELF_TRANSFER',
              message: 'Não é possível criar transferência para o mesmo agente'
            }
          });
        }
      }

      // Montar query de update
      const fields = [];
      const values = [];
      let paramCount = 1;

      if ('agente_destino_id' in updates) {
        fields.push(`agente_destino_id = $${paramCount}`);
        values.push(updates.agente_destino_id);
        paramCount++;
      }

      if ('trigger_tipo' in updates) {
        fields.push(`trigger_tipo = $${paramCount}`);
        values.push(updates.trigger_tipo);
        paramCount++;
      }

      if ('trigger_valores' in updates) {
        fields.push(`trigger_valor = $${paramCount}`);
        values.push(updates.trigger_valores.join(',').toLowerCase());
        paramCount++;
      }

      if ('transferir_historico' in updates) {
        fields.push(`transferir_historico = $${paramCount}`);
        values.push(updates.transferir_historico);
        paramCount++;
      }

      if ('ativo' in updates) {
        fields.push(`ativo = $${paramCount}`);
        values.push(updates.ativo);
        paramCount++;
      }

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
        UPDATE agente_transferencias
        SET ${fields.join(', ')}
        WHERE id = $${paramCount}
        RETURNING *
      `;

      const result = await client.query(updateQuery, values);

      await client.query('COMMIT');

      logger.info(`Transfer rule updated: ${id}`);

      return {
        success: true,
        data: {
          ...result.rows[0],
          trigger_valores: result.rows[0].trigger_valor ?
            result.rows[0].trigger_valor.split(',').map(v => v.trim()) : []
        }
      };
    } catch (error) {
      await client.query('ROLLBACK');
      logger.error('Error updating transferencia:', error);
      throw error;
    } finally {
      client.release();
    }
  });

  // Deletar regra de transferência
  fastify.delete('/:id', {
    preHandler: [
      fastify.authenticate,
      fastify.addTenantFilter,
      fastify.requirePermission('agentes', 'write')
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

      const result = await pool.query(
        'DELETE FROM agente_transferencias WHERE id = $1 AND empresa_id = $2 RETURNING id',
        [id, empresaId]
      );

      if (result.rows.length === 0) {
        return reply.code(404).send({
          success: false,
          error: {
            code: 'TRANSFERENCIA_NOT_FOUND',
            message: 'Transferência não encontrada'
          }
        });
      }

      logger.info(`Transfer rule deleted: ${id}`);

      reply.code(204).send();
    } catch (error) {
      logger.error('Error deleting transferencia:', error);
      throw error;
    }
  });

  // Listar todas as transferências da empresa (visão geral)
  fastify.get('/', {
    preHandler: [
      fastify.authenticate,
      fastify.addTenantFilter,
      fastify.requirePermission('agentes', 'read')
    ]
  }, async (request, reply) => {
    try {
      const { empresaId } = request;

      const result = await pool.query(`
        SELECT
          t.*,
          ao.nome as agente_origem_nome,
          ao.tipo as agente_origem_tipo,
          ad.nome as agente_destino_nome,
          ad.tipo as agente_destino_tipo
        FROM agente_transferencias t
        JOIN agentes ao ON ao.id = t.agente_origem_id
        JOIN agentes ad ON ad.id = t.agente_destino_id
        WHERE t.empresa_id = $1
        ORDER BY ao.nome, t.trigger_tipo, t.trigger_valor
      `, [empresaId]);

      // Agrupar por agente origem
      const transfersByAgent = {};

      result.rows.forEach(row => {
        if (!transfersByAgent[row.agente_origem_id]) {
          transfersByAgent[row.agente_origem_id] = {
            agente_id: row.agente_origem_id,
            agente_nome: row.agente_origem_nome,
            agente_tipo: row.agente_origem_tipo,
            transferencias: []
          };
        }

        transfersByAgent[row.agente_origem_id].transferencias.push({
          id: row.id,
          agente_destino_id: row.agente_destino_id,
          agente_destino_nome: row.agente_destino_nome,
          trigger_tipo: row.trigger_tipo,
          trigger_valores: row.trigger_valor ? row.trigger_valor.split(',').map(v => v.trim()) : [],
          transferir_historico: row.transferir_historico,
          ativo: row.ativo,
          criado_em: row.criado_em
        });
      });

      return {
        success: true,
        data: Object.values(transfersByAgent)
      };
    } catch (error) {
      logger.error('Error listing all transferencias:', error);
      throw error;
    }
  });
}