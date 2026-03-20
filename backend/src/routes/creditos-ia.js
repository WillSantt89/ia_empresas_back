import { pool } from '../config/database.js';
import { logger } from '../config/logger.js';
import { obterResumoCreditos, recarregarCreditos, inicializarCreditos } from '../services/creditos-ia.js';

export default async function creditosIaRoutes(fastify, opts) {
  // Obter resumo de créditos de uma empresa
  fastify.get('/:empresaId', {
    preHandler: [
      fastify.authenticate,
      fastify.requirePermission('assinaturas', 'read')
    ],
    schema: {
      params: {
        type: 'object',
        required: ['empresaId'],
        properties: {
          empresaId: { type: 'string', format: 'uuid' }
        }
      }
    }
  }, async (request, reply) => {
    try {
      const { empresaId } = request.params;
      const resumo = await obterResumoCreditos(empresaId);

      if (!resumo) {
        return reply.code(404).send({
          success: false,
          error: { code: 'CREDITOS_NOT_FOUND', message: 'Créditos não encontrados para esta empresa' }
        });
      }

      return { success: true, data: resumo };
    } catch (error) {
      logger.error('Error getting creditos:', error);
      throw error;
    }
  });

  // Obter créditos da empresa do próprio usuário (admin/operador)
  fastify.get('/meus', {
    preHandler: [fastify.authenticate]
  }, async (request, reply) => {
    try {
      const empresa_id = request.user.empresa_id;
      if (!empresa_id) {
        return reply.code(400).send({
          success: false,
          error: { code: 'NO_EMPRESA', message: 'Usuário não pertence a uma empresa' }
        });
      }

      const resumo = await obterResumoCreditos(empresa_id);
      if (!resumo) {
        return { success: true, data: null };
      }

      return { success: true, data: resumo };
    } catch (error) {
      logger.error('Error getting meus creditos:', error);
      throw error;
    }
  });

  // Efetuar recarga (master only)
  fastify.post('/:empresaId/recarga', {
    preHandler: [
      fastify.authenticate,
      fastify.requirePermission('assinaturas', 'write')
    ],
    schema: {
      params: {
        type: 'object',
        required: ['empresaId'],
        properties: {
          empresaId: { type: 'string', format: 'uuid' }
        }
      },
      body: {
        type: 'object',
        required: ['quantidade'],
        properties: {
          quantidade: { type: 'integer', minimum: 1 }
        }
      }
    }
  }, async (request, reply) => {
    try {
      const { empresaId } = request.params;
      const { quantidade } = request.body;

      const resultado = await recarregarCreditos(empresaId, quantidade, request.user.id);

      return {
        success: true,
        data: resultado,
        message: `${quantidade} créditos adicionados com sucesso`
      };
    } catch (error) {
      logger.error('Error recharging creditos:', error);
      if (error.message.includes('não encontrado')) {
        return reply.code(404).send({
          success: false,
          error: { code: 'CREDITOS_NOT_FOUND', message: error.message }
        });
      }
      throw error;
    }
  });

  // Inicializar créditos para empresa (master only)
  fastify.post('/:empresaId/inicializar', {
    preHandler: [
      fastify.authenticate,
      fastify.requirePermission('assinaturas', 'write')
    ],
    schema: {
      params: {
        type: 'object',
        required: ['empresaId'],
        properties: {
          empresaId: { type: 'string', format: 'uuid' }
        }
      },
      body: {
        type: 'object',
        required: ['creditos_plano'],
        properties: {
          creditos_plano: { type: 'integer', minimum: 0 }
        }
      }
    }
  }, async (request, reply) => {
    try {
      const { empresaId } = request.params;
      const { creditos_plano } = request.body;

      await inicializarCreditos(empresaId, creditos_plano);
      const resumo = await obterResumoCreditos(empresaId);

      return { success: true, data: resumo };
    } catch (error) {
      logger.error('Error initializing creditos:', error);
      throw error;
    }
  });

  // Histórico de movimentações
  fastify.get('/:empresaId/historico', {
    preHandler: [
      fastify.authenticate,
      fastify.requirePermission('assinaturas', 'read')
    ],
    schema: {
      params: {
        type: 'object',
        required: ['empresaId'],
        properties: {
          empresaId: { type: 'string', format: 'uuid' }
        }
      },
      querystring: {
        type: 'object',
        properties: {
          tipo: { type: 'string', enum: ['consumo', 'recarga', 'reset_mensal', 'agente_adicional', 'ajuste'] },
          page: { type: 'integer', minimum: 1, default: 1 },
          per_page: { type: 'integer', minimum: 1, maximum: 100, default: 50 }
        }
      }
    }
  }, async (request, reply) => {
    try {
      const { empresaId } = request.params;
      const { tipo, page, per_page } = request.query;
      const offset = (page - 1) * per_page;

      let query = `SELECT * FROM creditos_ia_historico WHERE empresa_id = $1`;
      const params = [empresaId];

      if (tipo) {
        params.push(tipo);
        query += ` AND tipo = $${params.length}`;
      }

      query += ` ORDER BY criado_em DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
      params.push(per_page, offset);

      const result = await pool.query(query, params);

      // Count
      let countQuery = `SELECT COUNT(*) FROM creditos_ia_historico WHERE empresa_id = $1`;
      const countParams = [empresaId];
      if (tipo) {
        countParams.push(tipo);
        countQuery += ` AND tipo = $2`;
      }
      const totalResult = await pool.query(countQuery, countParams);
      const total = parseInt(totalResult.rows[0].count);

      return {
        success: true,
        data: result.rows,
        total,
        page,
        per_page,
        total_pages: Math.ceil(total / per_page)
      };
    } catch (error) {
      logger.error('Error getting creditos historico:', error);
      throw error;
    }
  });

  // Visão geral billing (master) — todas empresas com créditos
  fastify.get('/', {
    preHandler: [
      fastify.authenticate,
      fastify.requirePermission('assinaturas', 'read')
    ]
  }, async (request, reply) => {
    try {
      const result = await pool.query(`
        SELECT
          c.*,
          e.nome as empresa_nome,
          e.slug as empresa_slug,
          p.nome as plano_nome,
          p.preco_base_mensal,
          a.status as assinatura_status,
          (c.creditos_plano + c.creditos_extras) as total_creditos,
          (c.creditos_plano_usados + c.creditos_extras_usados) as total_usados,
          (c.creditos_plano + c.creditos_extras - c.creditos_plano_usados - c.creditos_extras_usados) as saldo
        FROM creditos_ia c
        JOIN empresas e ON e.id = c.empresa_id
        JOIN assinaturas a ON a.empresa_id = c.empresa_id
        JOIN planos p ON p.id = a.plano_id
        ORDER BY c.bloqueado DESC, saldo ASC
      `);

      return { success: true, data: result.rows };
    } catch (error) {
      logger.error('Error getting billing overview:', error);
      throw error;
    }
  });
}
