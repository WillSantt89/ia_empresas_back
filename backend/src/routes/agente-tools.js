import { pool } from '../config/database.js';
import { logger } from '../config/logger.js';

export default async function agenteToolsRoutes(fastify, opts) {
  // Listar tools vinculadas a um agente
  fastify.get('/:agenteId/tools', {
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
          include_available: { type: 'boolean', default: false }
        }
      }
    }
  }, async (request, reply) => {
    try {
      const { agenteId } = request.params;
      const { include_available } = request.query;
      const { empresaId } = request;

      // Verificar se agente existe
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

      const agente = agenteExists.rows[0];

      // Buscar tools vinculadas
      const vinculadasResult = await pool.query(`
        SELECT
          t.*,
          at.ordem_prioridade,
          at.ativo as vinculo_ativo,
          at.id as vinculo_id,
          COUNT(DISTINCT at2.agente_id) as total_agentes_usando
        FROM tools t
        JOIN agente_tools at ON at.tool_id = t.id
        LEFT JOIN agente_tools at2 ON at2.tool_id = t.id AND at2.ativo = true
        WHERE at.agente_id = $1 AND t.empresa_id = $2
        GROUP BY t.id, at.ordem_prioridade, at.ativo, at.id
        ORDER BY at.ordem_prioridade, t.nome
      `, [agenteId, empresaId]);

      const response = {
        success: true,
        data: {
          agente_id: agenteId,
          agente_nome: agente.nome,
          tools_vinculadas: vinculadasResult.rows
        }
      };

      // Se solicitado, incluir tools disponíveis (não vinculadas)
      if (include_available) {
        const disponiveisResult = await pool.query(`
          SELECT
            t.*,
            COUNT(DISTINCT at.agente_id) as total_agentes_usando
          FROM tools t
          LEFT JOIN agente_tools at ON at.tool_id = t.id AND at.ativo = true
          WHERE t.empresa_id = $1
            AND t.ativo = true
            AND t.id NOT IN (
              SELECT tool_id FROM agente_tools WHERE agente_id = $2
            )
          GROUP BY t.id
          ORDER BY t.nome
        `, [empresaId, agenteId]);

        response.data.tools_disponiveis = disponiveisResult.rows;
      }

      return response;
    } catch (error) {
      logger.error('Error listing agent tools:', error);
      throw error;
    }
  });

  // Atualizar vínculos de tools do agente
  fastify.put('/:agenteId/tools', {
    preHandler: [
      fastify.authenticate,
      fastify.addTenantFilter,
      fastify.requirePermission('agentes', 'write')
    ],
    schema: {
      params: {
        type: 'object',
        required: ['agenteId'],
        properties: {
          agenteId: { type: 'string', format: 'uuid' }
        }
      },
      body: {
        type: 'object',
        required: ['tools'],
        properties: {
          tools: {
            type: 'array',
            items: {
              type: 'object',
              required: ['tool_id'],
              properties: {
                tool_id: { type: 'string', format: 'uuid' },
                ordem_prioridade: { type: 'integer', minimum: 0, default: 0 },
                ativo: { type: 'boolean', default: true }
              }
            }
          }
        }
      }
    }
  }, async (request, reply) => {
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      const { agenteId } = request.params;
      const { tools } = request.body;
      const { empresaId } = request;

      // Verificar se agente existe
      const agenteExists = await client.query(
        'SELECT id FROM agentes WHERE id = $1 AND empresa_id = $2',
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

      // Validar todas as tools
      const toolIds = tools.map(t => t.tool_id);
      const uniqueToolIds = [...new Set(toolIds)];

      if (uniqueToolIds.length !== toolIds.length) {
        return reply.code(400).send({
          success: false,
          error: {
            code: 'DUPLICATE_TOOLS',
            message: 'Lista contém tools duplicadas'
          }
        });
      }

      if (toolIds.length > 0) {
        const toolsExistResult = await client.query(
          'SELECT id FROM tools WHERE id = ANY($1) AND empresa_id = $2 AND ativo = true',
          [toolIds, empresaId]
        );

        if (toolsExistResult.rows.length !== toolIds.length) {
          return reply.code(400).send({
            success: false,
            error: {
              code: 'INVALID_TOOLS',
              message: 'Uma ou mais tools não existem ou estão inativas'
            }
          });
        }
      }

      // Buscar vínculos existentes
      const existingLinksResult = await client.query(
        'SELECT * FROM agente_tools WHERE agente_id = $1',
        [agenteId]
      );

      const existingLinks = existingLinksResult.rows;
      const existingToolIds = existingLinks.map(l => l.tool_id);

      // Determinar operações necessárias
      const toAdd = tools.filter(t => !existingToolIds.includes(t.tool_id));
      const toUpdate = tools.filter(t => existingToolIds.includes(t.tool_id));
      const toRemove = existingLinks.filter(l => !toolIds.includes(l.tool_id));

      // Adicionar novos vínculos
      for (const newLink of toAdd) {
        await client.query(`
          INSERT INTO agente_tools (
            id, agente_id, tool_id, ordem_prioridade, ativo, criado_em
          )
          VALUES (
            gen_random_uuid(), $1, $2, $3, $4, NOW()
          )
        `, [agenteId, newLink.tool_id, newLink.ordem_prioridade || 0, newLink.ativo !== false]);
      }

      // Atualizar vínculos existentes
      for (const updateLink of toUpdate) {
        const existingLink = existingLinks.find(l => l.tool_id === updateLink.tool_id);

        await client.query(`
          UPDATE agente_tools
          SET
            ordem_prioridade = $1,
            ativo = $2
          WHERE id = $3
        `, [
          updateLink.ordem_prioridade || 0,
          updateLink.ativo !== false,
          existingLink.id
        ]);
      }

      // Remover vínculos não mais desejados
      for (const removeLink of toRemove) {
        await client.query(
          'DELETE FROM agente_tools WHERE id = $1',
          [removeLink.id]
        );
      }

      // Atualizar timestamp do agente
      await client.query(
        'UPDATE agentes SET atualizado_em = NOW() WHERE id = $1',
        [agenteId]
      );

      await client.query('COMMIT');

      logger.info(`Agent tools updated: ${agenteId} - Added: ${toAdd.length}, Updated: ${toUpdate.length}, Removed: ${toRemove.length}`);

      // Retornar lista atualizada
      return fastify.inject({
        method: 'GET',
        url: `/api/agentes/${agenteId}/tools`,
        headers: request.headers
      }).then(response => response.json());

    } catch (error) {
      await client.query('ROLLBACK');
      logger.error('Error updating agent tools:', error);
      throw error;
    } finally {
      client.release();
    }
  });

  // Adicionar uma única tool ao agente
  fastify.post('/:agenteId/tools/:toolId', {
    preHandler: [
      fastify.authenticate,
      fastify.addTenantFilter,
      fastify.requirePermission('agentes', 'write')
    ],
    schema: {
      params: {
        type: 'object',
        required: ['agenteId', 'toolId'],
        properties: {
          agenteId: { type: 'string', format: 'uuid' },
          toolId: { type: 'string', format: 'uuid' }
        }
      },
      body: {
        type: 'object',
        properties: {
          ordem_prioridade: { type: 'integer', minimum: 0, default: 0 }
        }
      }
    }
  }, async (request, reply) => {
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      const { agenteId, toolId } = request.params;
      const { ordem_prioridade = 0 } = request.body;
      const { empresaId } = request;

      // Verificar se agente existe
      const agenteExists = await client.query(
        'SELECT id FROM agentes WHERE id = $1 AND empresa_id = $2',
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

      // Verificar se tool existe
      const toolExists = await client.query(
        'SELECT id FROM tools WHERE id = $1 AND empresa_id = $2 AND ativo = true',
        [toolId, empresaId]
      );

      if (toolExists.rows.length === 0) {
        return reply.code(404).send({
          success: false,
          error: {
            code: 'TOOL_NOT_FOUND',
            message: 'Tool não encontrada ou inativa'
          }
        });
      }

      // Verificar se já está vinculada
      const existingLink = await client.query(
        'SELECT id FROM agente_tools WHERE agente_id = $1 AND tool_id = $2',
        [agenteId, toolId]
      );

      if (existingLink.rows.length > 0) {
        return reply.code(409).send({
          success: false,
          error: {
            code: 'LINK_EXISTS',
            message: 'Tool já está vinculada a este agente'
          }
        });
      }

      // Criar vínculo
      const result = await client.query(`
        INSERT INTO agente_tools (
          id, agente_id, tool_id, ordem_prioridade, ativo, criado_em
        )
        VALUES (
          gen_random_uuid(), $1, $2, $3, true, NOW()
        )
        RETURNING *
      `, [agenteId, toolId, ordem_prioridade]);

      await client.query('COMMIT');

      logger.info(`Tool linked to agent: ${agenteId} <- ${toolId}`);

      reply.code(201).send({
        success: true,
        data: result.rows[0]
      });
    } catch (error) {
      await client.query('ROLLBACK');
      logger.error('Error linking tool to agent:', error);
      throw error;
    } finally {
      client.release();
    }
  });

  // Remover tool do agente
  fastify.delete('/:agenteId/tools/:toolId', {
    preHandler: [
      fastify.authenticate,
      fastify.addTenantFilter,
      fastify.requirePermission('agentes', 'write')
    ],
    schema: {
      params: {
        type: 'object',
        required: ['agenteId', 'toolId'],
        properties: {
          agenteId: { type: 'string', format: 'uuid' },
          toolId: { type: 'string', format: 'uuid' }
        }
      }
    }
  }, async (request, reply) => {
    try {
      const { agenteId, toolId } = request.params;
      const { empresaId } = request;

      // Verificar se agente pertence à empresa
      const agenteCheck = await pool.query(
        'SELECT id FROM agentes WHERE id = $1 AND empresa_id = $2',
        [agenteId, empresaId]
      );

      if (agenteCheck.rows.length === 0) {
        return reply.code(404).send({
          success: false,
          error: {
            code: 'AGENTE_NOT_FOUND',
            message: 'Agente não encontrado'
          }
        });
      }

      const result = await pool.query(
        'DELETE FROM agente_tools WHERE agente_id = $1 AND tool_id = $2 RETURNING id',
        [agenteId, toolId]
      );

      if (result.rows.length === 0) {
        return reply.code(404).send({
          success: false,
          error: {
            code: 'LINK_NOT_FOUND',
            message: 'Vínculo não encontrado'
          }
        });
      }

      logger.info(`Tool unlinked from agent: ${agenteId} -X- ${toolId}`);

      reply.code(204).send();
    } catch (error) {
      logger.error('Error unlinking tool from agent:', error);
      throw error;
    }
  });
}