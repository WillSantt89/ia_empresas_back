import { pool } from '../config/database.js';
import { logger } from '../config/logger.js';

export default async function promptsRoutes(fastify, opts) {
  // Listar versões de prompt de um agente
  fastify.get('/:agenteId/prompts', {
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
          include_content: { type: 'boolean', default: false }
        }
      }
    }
  }, async (request, reply) => {
    try {
      const { agenteId } = request.params;
      const { include_content } = request.query;
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

      const agente = agenteExists.rows[0];

      // Buscar prompts
      const fields = include_content
        ? 'p.*, u.nome as criado_por_nome'
        : 'p.id, p.versao, p.ativo, p.criado_em, u.nome as criado_por_nome';

      const result = await pool.query(`
        SELECT ${fields}
        FROM prompts p
        LEFT JOIN usuarios u ON u.id = p.criado_por
        WHERE p.agente_id = $1
        ORDER BY p.versao DESC
      `, [agenteId]);

      return {
        success: true,
        data: {
          agente_id: agenteId,
          agente_nome: agente.nome,
          prompts: result.rows
        }
      };
    } catch (error) {
      logger.error('Error listing prompts:', error);
      throw error;
    }
  });

  // Criar nova versão de prompt
  fastify.post('/:agenteId/prompts', {
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
        required: ['conteudo'],
        properties: {
          conteudo: { type: 'string', minLength: 10, maxLength: 35000 },
          ativar_imediatamente: { type: 'boolean', default: false }
        }
      }
    }
  }, async (request, reply) => {
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      const { agenteId } = request.params;
      const { conteudo, ativar_imediatamente } = request.body;
      const { empresaId } = request;
      const userId = request.user.id;

      // Verificar se agente existe e pertence à empresa
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

      // Buscar última versão
      const lastVersionResult = await client.query(
        'SELECT MAX(versao) as max_versao FROM prompts WHERE agente_id = $1',
        [agenteId]
      );

      const nextVersion = (lastVersionResult.rows[0].max_versao || 0) + 1;

      // Criar nova versão
      const result = await client.query(`
        INSERT INTO prompts (
          id, agente_id, empresa_id, versao, conteudo,
          ativo, criado_por, criado_em
        )
        VALUES (
          gen_random_uuid(), $1, $2, $3, $4, $5, $6, NOW()
        )
        RETURNING *
      `, [agenteId, empresaId, nextVersion, conteudo, ativar_imediatamente, userId]);

      const newPrompt = result.rows[0];

      // Se deve ativar imediatamente
      if (ativar_imediatamente) {
        // Desativar versão anterior
        await client.query(
          'UPDATE prompts SET ativo = false WHERE agente_id = $1 AND id != $2',
          [agenteId, newPrompt.id]
        );

        // Atualizar prompt_ativo do agente
        await client.query(
          'UPDATE agentes SET prompt_ativo = $2, atualizado_em = NOW() WHERE id = $1',
          [agenteId, conteudo]
        );

        logger.info(`Prompt v${nextVersion} activated for agent ${agenteId}`);
      }

      await client.query('COMMIT');

      logger.info(`Prompt v${nextVersion} created for agent ${agenteId}`);

      reply.code(201).send({
        success: true,
        data: newPrompt
      });
    } catch (error) {
      await client.query('ROLLBACK');
      logger.error('Error creating prompt:', error);
      throw error;
    } finally {
      client.release();
    }
  });

  // Ativar versão específica do prompt
  fastify.put('/:agenteId/prompts/:promptId/ativar', {
    preHandler: [
      fastify.authenticate,
      fastify.addTenantFilter,
      fastify.requirePermission('agentes', 'write')
    ],
    schema: {
      params: {
        type: 'object',
        required: ['agenteId', 'promptId'],
        properties: {
          agenteId: { type: 'string', format: 'uuid' },
          promptId: { type: 'string', format: 'uuid' }
        }
      }
    }
  }, async (request, reply) => {
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      const { agenteId, promptId } = request.params;
      const { empresaId } = request;

      // Verificar se prompt existe e pertence ao agente/empresa
      const promptResult = await client.query(
        'SELECT * FROM prompts WHERE id = $1 AND agente_id = $2 AND empresa_id = $3',
        [promptId, agenteId, empresaId]
      );

      if (promptResult.rows.length === 0) {
        return reply.code(404).send({
          success: false,
          error: {
            code: 'PROMPT_NOT_FOUND',
            message: 'Prompt não encontrado'
          }
        });
      }

      const prompt = promptResult.rows[0];

      if (prompt.ativo) {
        return reply.code(400).send({
          success: false,
          error: {
            code: 'PROMPT_ALREADY_ACTIVE',
            message: 'Este prompt já está ativo'
          }
        });
      }

      // Desativar todos os outros prompts do agente
      await client.query(
        'UPDATE prompts SET ativo = false WHERE agente_id = $1',
        [agenteId]
      );

      // Ativar o prompt selecionado
      await client.query(
        'UPDATE prompts SET ativo = true WHERE id = $1',
        [promptId]
      );

      // Atualizar prompt_ativo do agente com o conteúdo do prompt ativado
      await client.query(
        'UPDATE agentes SET prompt_ativo = $2, atualizado_em = NOW() WHERE id = $1',
        [agenteId, prompt.conteudo]
      );

      await client.query('COMMIT');

      logger.info(`Prompt v${prompt.versao} activated for agent ${agenteId}`);

      return {
        success: true,
        data: {
          ...prompt,
          ativo: true
        }
      };
    } catch (error) {
      await client.query('ROLLBACK');
      logger.error('Error activating prompt:', error);
      throw error;
    } finally {
      client.release();
    }
  });

  // Obter prompt ativo de um agente
  fastify.get('/:agenteId/prompt-ativo', {
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
      }
    }
  }, async (request, reply) => {
    try {
      const { agenteId } = request.params;
      const { empresaId } = request;

      const result = await pool.query(`
        SELECT
          p.*,
          u.nome as criado_por_nome
        FROM prompts p
        LEFT JOIN usuarios u ON u.id = p.criado_por
        WHERE p.agente_id = $1 AND p.empresa_id = $2 AND p.ativo = true
        LIMIT 1
      `, [agenteId, empresaId]);

      if (result.rows.length === 0) {
        return reply.code(404).send({
          success: false,
          error: {
            code: 'NO_ACTIVE_PROMPT',
            message: 'Nenhum prompt ativo encontrado para este agente'
          }
        });
      }

      return {
        success: true,
        data: result.rows[0]
      };
    } catch (error) {
      logger.error('Error getting active prompt:', error);
      throw error;
    }
  });

  // Comparar duas versões
  fastify.get('/:agenteId/prompts/compare', {
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
        required: ['v1', 'v2'],
        properties: {
          v1: { type: 'integer', minimum: 1 },
          v2: { type: 'integer', minimum: 1 }
        }
      }
    }
  }, async (request, reply) => {
    try {
      const { agenteId } = request.params;
      const { v1, v2 } = request.query;
      const { empresaId } = request;

      const result = await pool.query(`
        SELECT
          p.versao,
          p.conteudo,
          p.ativo,
          p.criado_em,
          u.nome as criado_por_nome
        FROM prompts p
        LEFT JOIN usuarios u ON u.id = p.criado_por
        WHERE p.agente_id = $1
          AND p.empresa_id = $2
          AND p.versao IN ($3, $4)
        ORDER BY p.versao
      `, [agenteId, empresaId, v1, v2]);

      if (result.rows.length < 2) {
        return reply.code(404).send({
          success: false,
          error: {
            code: 'VERSIONS_NOT_FOUND',
            message: 'Uma ou ambas as versões não foram encontradas'
          }
        });
      }

      const version1 = result.rows.find(r => r.versao === v1);
      const version2 = result.rows.find(r => r.versao === v2);

      return {
        success: true,
        data: {
          version1,
          version2,
          differences: {
            length_change: version2.conteudo.length - version1.conteudo.length,
            created_days_apart: Math.floor(
              (new Date(version2.criado_em) - new Date(version1.criado_em)) / (1000 * 60 * 60 * 24)
            )
          }
        }
      };
    } catch (error) {
      logger.error('Error comparing prompts:', error);
      throw error;
    }
  });
}