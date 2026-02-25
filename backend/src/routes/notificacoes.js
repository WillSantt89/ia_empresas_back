import { pool } from '../config/database.js';
import { logger } from '../config/logger.js';

export default async function notificacoesRoutes(fastify, opts) {
  // Listar notificações
  fastify.get('/', {
    preHandler: [
      fastify.authenticate,
      fastify.addTenantFilter,
      fastify.requirePermission('notificacoes', 'read')
    ],
    schema: {
      querystring: {
        type: 'object',
        properties: {
          lida: { type: 'boolean' },
          severidade: { type: 'string', enum: ['info', 'warning', 'critical'] },
          tipo: { type: 'string' },
          data_inicio: { type: 'string', format: 'date' },
          data_fim: { type: 'string', format: 'date' },
          page: { type: 'integer', minimum: 1, default: 1 },
          per_page: { type: 'integer', minimum: 1, maximum: 100, default: 20 }
        }
      }
    }
  }, async (request, reply) => {
    try {
      const { empresaId, isMaster } = request;
      const {
        lida, severidade, tipo, data_inicio, data_fim,
        page, per_page
      } = request.query;
      const offset = (page - 1) * per_page;

      let query = `
        SELECT
          n.*,
          e.nome as empresa_nome,
          e.slug as empresa_slug
        FROM notificacoes n
        LEFT JOIN empresas e ON e.id = n.empresa_id
        WHERE 1=1
      `;

      const params = [];
      const conditions = [];

      // Se não for master, filtrar por empresa
      if (!isMaster) {
        params.push(empresaId);
        conditions.push(`(n.empresa_id = $${params.length} OR n.empresa_id IS NULL)`);
      }

      if (typeof lida === 'boolean') {
        params.push(lida);
        conditions.push(`n.lida = $${params.length}`);
      }

      if (severidade) {
        params.push(severidade);
        conditions.push(`n.severidade = $${params.length}`);
      }

      if (tipo) {
        params.push(tipo);
        conditions.push(`n.tipo = $${params.length}`);
      }

      if (data_inicio) {
        params.push(data_inicio);
        conditions.push(`n.criado_em >= $${params.length}`);
      }

      if (data_fim) {
        params.push(data_fim);
        conditions.push(`n.criado_em <= $${params.length} + INTERVAL '1 day'`);
      }

      if (conditions.length > 0) {
        query += ` AND ${conditions.join(' AND ')}`;
      }

      // Query para contagem total
      const countQuery = query.replace(
        /SELECT[\s\S]+?FROM/,
        'SELECT COUNT(*) FROM'
      ).replace(/LEFT JOIN empresas[\s\S]+?WHERE/, 'WHERE');

      const totalResult = await pool.query(countQuery, params);
      const total = parseInt(totalResult.rows[0].count);

      // Adicionar ordenação e paginação
      query += ` ORDER BY
        CASE n.severidade
          WHEN 'critical' THEN 1
          WHEN 'warning' THEN 2
          ELSE 3
        END,
        n.lida ASC,
        n.criado_em DESC
        LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;

      params.push(per_page, offset);

      const result = await pool.query(query, params);

      // Contar não lidas
      const unreadResult = await pool.query(`
        SELECT
          COUNT(*) as total,
          COUNT(*) FILTER (WHERE severidade = 'critical') as critical,
          COUNT(*) FILTER (WHERE severidade = 'warning') as warning,
          COUNT(*) FILTER (WHERE severidade = 'info') as info
        FROM notificacoes
        WHERE lida = false
          ${!isMaster ? `AND (empresa_id = $1 OR empresa_id IS NULL)` : ''}
      `, !isMaster ? [empresaId] : []);

      return {
        success: true,
        data: result.rows,
        meta: {
          total,
          page,
          per_page,
          total_pages: Math.ceil(total / per_page),
          nao_lidas: {
            total: parseInt(unreadResult.rows[0].total),
            critical: parseInt(unreadResult.rows[0].critical),
            warning: parseInt(unreadResult.rows[0].warning),
            info: parseInt(unreadResult.rows[0].info)
          }
        }
      };
    } catch (error) {
      logger.error('Error listing notificacoes:', error);
      throw error;
    }
  });

  // Marcar notificação como lida
  fastify.put('/:id/ler', {
    preHandler: [
      fastify.authenticate,
      fastify.addTenantFilter,
      fastify.requirePermission('notificacoes', 'write')
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
      const { empresaId, isMaster } = request;

      let query = 'UPDATE notificacoes SET lida = true WHERE id = $1';
      const params = [id];

      if (!isMaster) {
        query += ' AND (empresa_id = $2 OR empresa_id IS NULL)';
        params.push(empresaId);
      }

      query += ' RETURNING id';

      const result = await pool.query(query, params);

      if (result.rows.length === 0) {
        return reply.code(404).send({
          success: false,
          error: {
            code: 'NOTIFICACAO_NOT_FOUND',
            message: 'Notificação não encontrada'
          }
        });
      }

      return {
        success: true,
        data: {
          id: result.rows[0].id,
          lida: true
        }
      };
    } catch (error) {
      logger.error('Error marking notificacao as read:', error);
      throw error;
    }
  });

  // Marcar múltiplas notificações como lidas
  fastify.put('/ler-multiplas', {
    preHandler: [
      fastify.authenticate,
      fastify.addTenantFilter,
      fastify.requirePermission('notificacoes', 'write')
    ],
    schema: {
      body: {
        type: 'object',
        required: ['ids'],
        properties: {
          ids: {
            type: 'array',
            items: { type: 'string', format: 'uuid' },
            minItems: 1,
            maxItems: 100
          }
        }
      }
    }
  }, async (request, reply) => {
    try {
      const { ids } = request.body;
      const { empresaId, isMaster } = request;

      let query = 'UPDATE notificacoes SET lida = true WHERE id = ANY($1)';
      const params = [ids];

      if (!isMaster) {
        query += ' AND (empresa_id = $2 OR empresa_id IS NULL)';
        params.push(empresaId);
      }

      query += ' RETURNING id';

      const result = await pool.query(query, params);

      return {
        success: true,
        data: {
          total_marcadas: result.rowCount,
          ids_marcadas: result.rows.map(r => r.id)
        }
      };
    } catch (error) {
      logger.error('Error marking multiple notificacoes as read:', error);
      throw error;
    }
  });

  // Marcar todas como lidas
  fastify.put('/ler-todas', {
    preHandler: [
      fastify.authenticate,
      fastify.addTenantFilter,
      fastify.requirePermission('notificacoes', 'write')
    ]
  }, async (request, reply) => {
    try {
      const { empresaId, isMaster } = request;

      let query = 'UPDATE notificacoes SET lida = true WHERE lida = false';
      const params = [];

      if (!isMaster) {
        query += ' AND (empresa_id = $1 OR empresa_id IS NULL)';
        params.push(empresaId);
      }

      const result = await pool.query(query, params);

      return {
        success: true,
        data: {
          total_marcadas: result.rowCount
        }
      };
    } catch (error) {
      logger.error('Error marking all notificacoes as read:', error);
      throw error;
    }
  });

  // Criar notificação (apenas para testes/admin)
  fastify.post('/', {
    preHandler: [
      fastify.authenticate,
      fastify.requirePermission('notificacoes', 'write')
    ],
    schema: {
      body: {
        type: 'object',
        required: ['tipo', 'titulo', 'mensagem'],
        properties: {
          empresa_id: { type: ['string', 'null'], format: 'uuid' },
          tipo: { type: 'string' },
          titulo: { type: 'string', maxLength: 255 },
          mensagem: { type: 'string' },
          severidade: { type: 'string', enum: ['info', 'warning', 'critical'], default: 'info' }
        }
      }
    }
  }, async (request, reply) => {
    try {
      const { empresa_id, tipo, titulo, mensagem, severidade } = request.body;
      const { isMaster } = request;

      // Apenas master pode criar notificações globais
      if (!isMaster && !empresa_id) {
        return reply.code(403).send({
          success: false,
          error: {
            code: 'FORBIDDEN',
            message: 'Apenas usuários master podem criar notificações globais'
          }
        });
      }

      const result = await pool.query(`
        INSERT INTO notificacoes (
          id, empresa_id, tipo, titulo, mensagem,
          severidade, lida, criado_em
        ) VALUES (
          gen_random_uuid(), $1, $2, $3, $4, $5, false, NOW()
        ) RETURNING *
      `, [empresa_id, tipo, titulo, mensagem, severidade]);

      logger.info(`Notificacao created: ${tipo} - ${severidade}`);

      reply.code(201).send({
        success: true,
        data: result.rows[0]
      });
    } catch (error) {
      logger.error('Error creating notificacao:', error);
      throw error;
    }
  });

  // Deletar notificações antigas
  fastify.delete('/limpar', {
    preHandler: [
      fastify.authenticate,
      fastify.addTenantFilter,
      fastify.requirePermission('notificacoes', 'write')
    ],
    schema: {
      querystring: {
        type: 'object',
        properties: {
          dias: { type: 'integer', minimum: 1, default: 30 },
          apenas_lidas: { type: 'boolean', default: true }
        }
      }
    }
  }, async (request, reply) => {
    try {
      const { dias, apenas_lidas } = request.query;
      const { empresaId, isMaster } = request;

      let query = `
        DELETE FROM notificacoes
        WHERE criado_em < CURRENT_DATE - INTERVAL '${dias} days'
      `;

      const params = [];

      if (apenas_lidas) {
        query += ' AND lida = true';
      }

      if (!isMaster) {
        params.push(empresaId);
        query += ` AND (empresa_id = $${params.length} OR empresa_id IS NULL)`;
      }

      const result = await pool.query(query, params);

      logger.info(`Cleared ${result.rowCount} old notificacoes`);

      return {
        success: true,
        data: {
          total_deletadas: result.rowCount
        }
      };
    } catch (error) {
      logger.error('Error clearing notificacoes:', error);
      throw error;
    }
  });

  // Resumo de notificações (para badge/indicador)
  fastify.get('/resumo', {
    preHandler: [
      fastify.authenticate,
      fastify.addTenantFilter,
      fastify.requirePermission('notificacoes', 'read')
    ]
  }, async (request, reply) => {
    try {
      const { empresaId, isMaster } = request;

      const query = `
        SELECT
          COUNT(*) FILTER (WHERE lida = false) as nao_lidas,
          COUNT(*) FILTER (WHERE lida = false AND severidade = 'critical') as critical_nao_lidas,
          COUNT(*) FILTER (WHERE lida = false AND severidade = 'warning') as warning_nao_lidas,
          COUNT(*) FILTER (WHERE lida = false AND severidade = 'info') as info_nao_lidas,
          COUNT(*) FILTER (WHERE criado_em >= NOW() - INTERVAL '24 hours') as ultimas_24h,
          COUNT(*) FILTER (WHERE criado_em >= NOW() - INTERVAL '7 days') as ultimos_7_dias,
          MAX(criado_em) FILTER (WHERE lida = false) as ultima_nao_lida
        FROM notificacoes
        WHERE 1=1
          ${!isMaster ? `AND (empresa_id = $1 OR empresa_id IS NULL)` : ''}
      `;

      const result = await pool.query(query, !isMaster ? [empresaId] : []);

      const resumo = result.rows[0];

      // Buscar últimas 5 não lidas críticas
      const criticasResult = await pool.query(`
        SELECT
          id, tipo, titulo, mensagem, criado_em
        FROM notificacoes
        WHERE lida = false AND severidade = 'critical'
          ${!isMaster ? `AND (empresa_id = $1 OR empresa_id IS NULL)` : ''}
        ORDER BY criado_em DESC
        LIMIT 5
      `, !isMaster ? [empresaId] : []);

      return {
        success: true,
        data: {
          totais: {
            nao_lidas: parseInt(resumo.nao_lidas),
            critical: parseInt(resumo.critical_nao_lidas),
            warning: parseInt(resumo.warning_nao_lidas),
            info: parseInt(resumo.info_nao_lidas)
          },
          recentes: {
            ultimas_24h: parseInt(resumo.ultimas_24h),
            ultimos_7_dias: parseInt(resumo.ultimos_7_dias),
            ultima_nao_lida: resumo.ultima_nao_lida
          },
          criticas_recentes: criticasResult.rows,
          tem_criticas: parseInt(resumo.critical_nao_lidas) > 0
        }
      };
    } catch (error) {
      logger.error('Error getting notificacoes resumo:', error);
      throw error;
    }
  });
}