import { logger } from '../config/logger.js';
import { pool, tenantQuery } from '../config/database.js';

/**
 * Analytics Routes
 * Reporting and insights endpoints
 */

const createLogger = logger.child({ module: 'analytics-routes' });

const analyticsRoutes = async (fastify) => {
  /**
   * GET /api/analytics/overview
   * Get overview statistics
   */
  fastify.get('/overview', {
    preHandler: fastify.authenticate,
    schema: {
      querystring: {
        type: 'object',
        properties: {
          start_date: { type: 'string', format: 'date' },
          end_date: { type: 'string', format: 'date' },
          agente_id: { type: 'string', format: 'uuid' }
        }
      }
    }
  }, async (request, reply) => {
    const { empresa_id } = request.user;
    const {
      start_date = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
      end_date = new Date().toISOString().split('T')[0],
      agente_id
    } = request.query;

    try {
      const params = [empresa_id, start_date, end_date];
      let agentFilter = '';

      if (agente_id) {
        agentFilter = ' AND ca.agente_id = $4';
        params.push(agente_id);
      }

      // Get period data
      const periodResult = await pool.query(`
        SELECT
          COUNT(DISTINCT ca.conversation_id) as total_conversations,
          COUNT(*) as total_messages,
          COUNT(*) FILTER (WHERE ca.sucesso = true) as successful_messages,
          COUNT(*) FILTER (WHERE ca.sucesso = false) as failed_messages,
          COALESCE(SUM(ca.tokens_input), 0) as total_tokens_input,
          COALESCE(SUM(ca.tokens_output), 0) as total_tokens_output,
          COALESCE(SUM(ca.tools_chamadas), 0) as total_tool_calls,
          COALESCE(AVG(ca.tempo_processamento_ms), 0) as avg_response_time
        FROM conversacao_analytics ca
        WHERE ca.empresa_id = $1
          AND ca.criado_em::date >= $2
          AND ca.criado_em::date <= $3
          ${agentFilter}
      `, params);

      // Get agent breakdown
      const agentsResult = await pool.query(`
        SELECT
          a.id,
          a.nome,
          COUNT(DISTINCT ca.conversation_id) as conversations,
          COUNT(ca.id) as messages,
          COALESCE(SUM(ca.tokens_input + ca.tokens_output), 0) as tokens,
          CASE
            WHEN COUNT(ca.id) = 0 THEN 0
            ELSE (COUNT(*) FILTER (WHERE ca.sucesso = true))::float / NULLIF(COUNT(ca.id), 0) * 100
          END as success_rate
        FROM agentes a
        LEFT JOIN conversacao_analytics ca ON a.id = ca.agente_id
          AND ca.criado_em::date >= $2
          AND ca.criado_em::date <= $3
        WHERE a.empresa_id = $1 AND a.ativo = true
        GROUP BY a.id, a.nome
        ORDER BY messages DESC
        LIMIT 10
      `, [empresa_id, start_date, end_date]);

      // Get limits
      const limitsResult = await pool.query(`
        SELECT max_mensagens_mes, max_tokens_mes
        FROM empresa_limits
        WHERE empresa_id = $1
        LIMIT 1
      `, [empresa_id]);

      const pd = periodResult.rows[0] || {};
      const limits = limitsResult.rows[0] || {};

      const overview = {
        total_conversations: parseInt(pd.total_conversations) || 0,
        total_messages: parseInt(pd.total_messages) || 0,
        successful_messages: parseInt(pd.successful_messages) || 0,
        failed_messages: parseInt(pd.failed_messages) || 0,
        total_tokens: (parseInt(pd.total_tokens_input) || 0) + (parseInt(pd.total_tokens_output) || 0),
        total_tool_calls: parseInt(pd.total_tool_calls) || 0,
        avg_response_time: Math.round(parseFloat(pd.avg_response_time)) || 0,
        success_rate: pd.total_messages > 0
          ? Math.round((pd.successful_messages / pd.total_messages) * 100)
          : 0,
        message_limit: parseInt(limits.max_mensagens_mes) || 10000,
        token_limit: parseInt(limits.max_tokens_mes) || 5000000,
        agents: agentsResult.rows || []
      };

      return {
        success: true,
        data: {
          overview,
          period: {
            start_date,
            end_date
          }
        }
      };

    } catch (error) {
      createLogger.error('Failed to get analytics overview', {
        empresa_id,
        error: error.message
      });
      throw error;
    }
  });

  /**
   * GET /api/analytics/timeline
   * Get timeline data
   */
  fastify.get('/timeline', {
    preHandler: fastify.authenticate,
    schema: {
      querystring: {
        type: 'object',
        properties: {
          start_date: { type: 'string', format: 'date' },
          end_date: { type: 'string', format: 'date' },
          agente_id: { type: 'string', format: 'uuid' },
          interval: { type: 'string', enum: ['hour', 'day', 'week', 'month'], default: 'day' }
        }
      }
    }
  }, async (request, reply) => {
    const { empresa_id } = request.user;
    const {
      start_date = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
      end_date = new Date().toISOString().split('T')[0],
      agente_id,
      interval = 'day'
    } = request.query;

    try {
      const params = [empresa_id, start_date, end_date];
      let agentFilter = '';

      if (agente_id) {
        agentFilter = ' AND ca.agente_id = $4';
        params.push(agente_id);
      }

      // Define date truncation based on interval
      const dateTrunc = {
        hour: "date_trunc('hour', ca.criado_em)",
        day: "date_trunc('day', ca.criado_em)",
        week: "date_trunc('week', ca.criado_em)",
        month: "date_trunc('month', ca.criado_em)"
      }[interval];

      const query = `
        SELECT
          ${dateTrunc} as period,
          COUNT(DISTINCT ca.conversation_id) as conversations,
          COUNT(*) as messages,
          COALESCE(SUM(ca.tokens_input + ca.tokens_output), 0) as tokens,
          COALESCE(AVG(ca.tempo_processamento_ms), 0) as avg_response_time,
          COUNT(*) FILTER (WHERE ca.sucesso = true) as successful,
          COUNT(*) FILTER (WHERE ca.sucesso = false) as failed
        FROM conversacao_analytics ca
        WHERE ca.empresa_id = $1
          AND ca.criado_em::date >= $2
          AND ca.criado_em::date <= $3
          ${agentFilter}
        GROUP BY period
        ORDER BY period ASC
      `;

      const result = await pool.query(query, params);

      const timeline = result.rows.map(row => ({
        period: row.period,
        conversations: parseInt(row.conversations) || 0,
        messages: parseInt(row.messages) || 0,
        tokens: parseInt(row.tokens) || 0,
        avg_response_time: Math.round(parseFloat(row.avg_response_time)) || 0,
        successful: parseInt(row.successful) || 0,
        failed: parseInt(row.failed) || 0,
        success_rate: row.messages > 0
          ? Math.round((row.successful / row.messages) * 100)
          : 0
      }));

      return {
        success: true,
        data: {
          timeline,
          interval,
          period: {
            start_date,
            end_date
          }
        }
      };

    } catch (error) {
      createLogger.error('Failed to get timeline data', {
        empresa_id,
        error: error.message
      });
      throw error;
    }
  });

  /**
   * GET /api/analytics/conversations
   * Get conversation analytics
   */
  fastify.get('/conversations', {
    preHandler: fastify.authenticate,
    schema: {
      querystring: {
        type: 'object',
        properties: {
          page: { type: 'integer', minimum: 1, default: 1 },
          limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
          start_date: { type: 'string', format: 'date' },
          end_date: { type: 'string', format: 'date' },
          agente_id: { type: 'string', format: 'uuid' },
          status: { type: 'string', enum: ['all', 'success', 'failed'], default: 'all' }
        }
      }
    }
  }, async (request, reply) => {
    const { empresa_id } = request.user;
    const {
      page,
      limit,
      start_date = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
      end_date = new Date().toISOString().split('T')[0],
      agente_id,
      status
    } = request.query;
    const offset = (page - 1) * limit;

    try {
      let query = `
        WITH conversation_summary AS (
          SELECT
            ca.conversation_id,
            MIN(ca.criado_em) as first_message,
            MAX(ca.criado_em) as last_message,
            COUNT(*) as message_count,
            SUM(ca.tokens_input + ca.tokens_output) as total_tokens,
            AVG(ca.tempo_processamento_ms) as avg_response_time,
            SUM(ca.tools_chamadas) as tool_calls,
            COUNT(*) FILTER (WHERE ca.sucesso = true) as successful_messages,
            COUNT(*) FILTER (WHERE ca.sucesso = false) as failed_messages,
            array_agg(DISTINCT ca.agente_id) as agent_ids
          FROM conversacao_analytics ca
          WHERE ca.empresa_id = $1
            AND ca.criado_em::date >= $2
            AND ca.criado_em::date <= $3
      `;

      const params = [empresa_id, start_date, end_date];
      let paramIndex = 4;

      if (agente_id) {
        query += ` AND ca.agente_id = $${paramIndex}`;
        params.push(agente_id);
        paramIndex++;
      }

      if (status === 'success') {
        query += ' AND ca.sucesso = true';
      } else if (status === 'failed') {
        query += ' AND ca.sucesso = false';
      }

      query += `
          GROUP BY ca.conversation_id
        )
        SELECT
          cs.*,
          (
            SELECT json_agg(DISTINCT a.nome)
            FROM agentes a
            WHERE a.id = ANY(cs.agent_ids)
          ) as agent_names
        FROM conversation_summary cs
      `;

      // Get total count
      const countQuery = `
        SELECT COUNT(*) as total
        FROM (${query}) t
      `;

      const countResult = await pool.query(countQuery, params);
      const total = parseInt(countResult.rows[0].total) || 0;

      // Add pagination
      query += ` ORDER BY cs.last_message DESC LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
      params.push(limit, offset);

      const result = await pool.query(query, params);

      const conversations = result.rows.map(row => ({
        conversation_id: row.conversation_id,
        first_message: row.first_message,
        last_message: row.last_message,
        duration_minutes: Math.round(
          (new Date(row.last_message) - new Date(row.first_message)) / 60000
        ),
        message_count: parseInt(row.message_count) || 0,
        total_tokens: parseInt(row.total_tokens) || 0,
        avg_response_time: Math.round(parseFloat(row.avg_response_time)) || 0,
        tool_calls: parseInt(row.tool_calls) || 0,
        successful_messages: parseInt(row.successful_messages) || 0,
        failed_messages: parseInt(row.failed_messages) || 0,
        success_rate: row.message_count > 0
          ? Math.round((row.successful_messages / row.message_count) * 100)
          : 0,
        agents: row.agent_names || []
      }));

      return {
        success: true,
        data: {
          conversations,
          pagination: {
            page,
            limit,
            total,
            pages: Math.ceil(total / limit)
          },
          period: {
            start_date,
            end_date
          }
        }
      };

    } catch (error) {
      createLogger.error('Failed to get conversation analytics', {
        empresa_id,
        error: error.message
      });
      throw error;
    }
  });

  /**
   * GET /api/analytics/tools
   * Get tool usage analytics
   */
  fastify.get('/tools', {
    preHandler: fastify.authenticate,
    schema: {
      querystring: {
        type: 'object',
        properties: {
          start_date: { type: 'string', format: 'date' },
          end_date: { type: 'string', format: 'date' },
          agente_id: { type: 'string', format: 'uuid' }
        }
      }
    }
  }, async (request, reply) => {
    const { empresa_id } = request.user;
    const {
      start_date = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
      end_date = new Date().toISOString().split('T')[0],
      agente_id
    } = request.query;

    try {
      const params = [empresa_id, start_date, end_date];
      let agentFilter = '';

      if (agente_id) {
        agentFilter = ' AND te.agente_id = $4';
        params.push(agente_id);
      }

      const query = `
        SELECT
          t.id,
          t.nome,
          t.descricao,
          COUNT(*) as total_calls,
          COUNT(*) FILTER (WHERE te.sucesso = true) as successful_calls,
          COUNT(*) FILTER (WHERE te.sucesso = false) as failed_calls,
          COALESCE(AVG(te.tempo_processamento_ms), 0) as avg_duration,
          COALESCE(MAX(te.tempo_processamento_ms), 0) as max_duration,
          COALESCE(MIN(te.tempo_processamento_ms), 0) as min_duration,
          array_agg(DISTINCT a.nome) as used_by_agents
        FROM tools t
        INNER JOIN tool_executions te ON t.id = te.tool_id
        INNER JOIN agentes a ON te.agente_id = a.id
        WHERE te.empresa_id = $1
          AND te.created_at::date >= $2
          AND te.created_at::date <= $3
          ${agentFilter}
        GROUP BY t.id, t.nome, t.descricao
        ORDER BY total_calls DESC
      `;

      const result = await pool.query(query, params);

      const tools = result.rows.map(row => ({
        id: row.id,
        nome: row.nome,
        descricao: row.descricao,
        total_calls: parseInt(row.total_calls) || 0,
        successful_calls: parseInt(row.successful_calls) || 0,
        failed_calls: parseInt(row.failed_calls) || 0,
        success_rate: row.total_calls > 0
          ? Math.round((row.successful_calls / row.total_calls) * 100)
          : 0,
        avg_duration: Math.round(parseFloat(row.avg_duration)) || 0,
        max_duration: parseInt(row.max_duration) || 0,
        min_duration: parseInt(row.min_duration) || 0,
        used_by_agents: row.used_by_agents || []
      }));

      return {
        success: true,
        data: {
          tools,
          period: {
            start_date,
            end_date
          }
        }
      };

    } catch (error) {
      createLogger.error('Failed to get tool analytics', {
        empresa_id,
        error: error.message
      });
      throw error;
    }
  });

  /**
   * GET /api/analytics/usage
   * Get usage vs limits
   */
  fastify.get('/usage', {
    preHandler: fastify.authenticate
  }, async (request, reply) => {
    const { empresa_id } = request.user;

    try {
      const result = await pool.query(`
        SELECT
          COALESCE(el.max_usuarios, 10) as max_usuarios,
          COALESCE(el.max_agentes, 5) as max_agentes,
          COALESCE(el.max_mensagens_mes, 10000) as max_mensagens_mes,
          COALESCE(el.max_tokens_mes, 5000000) as max_tokens_mes,
          (SELECT COUNT(*) FROM usuarios WHERE empresa_id = $1 AND ativo = true) as usuarios_ativos,
          (SELECT COUNT(*) FROM agentes WHERE empresa_id = $1 AND ativo = true) as agentes_ativos,
          (SELECT COUNT(*) FROM conversacao_analytics WHERE empresa_id = $1) as messages_used,
          (SELECT COALESCE(SUM(tokens_input + tokens_output), 0) FROM conversacao_analytics WHERE empresa_id = $1) as tokens_used
        FROM empresa_limits el
        WHERE el.empresa_id = $1
      `, [empresa_id]);

      if (result.rows.length === 0) {
        return {
          success: true,
          data: {
            usage: {
              usuarios: { used: 0, limit: 10, percentage: 0 },
              agentes: { used: 0, limit: 5, percentage: 0 },
              mensagens: { used: 0, limit: 10000, percentage: 0 },
              tokens: { used: 0, limit: 5000000, percentage: 0 }
            }
          }
        };
      }

      const data = result.rows[0];

      const usage = {
        usuarios: {
          used: parseInt(data.usuarios_ativos) || 0,
          limit: parseInt(data.max_usuarios) || 10,
          percentage: data.max_usuarios > 0
            ? Math.round((data.usuarios_ativos / data.max_usuarios) * 100)
            : 0
        },
        agentes: {
          used: parseInt(data.agentes_ativos) || 0,
          limit: parseInt(data.max_agentes) || 5,
          percentage: data.max_agentes > 0
            ? Math.round((data.agentes_ativos / data.max_agentes) * 100)
            : 0
        },
        mensagens: {
          used: parseInt(data.messages_used) || 0,
          limit: parseInt(data.max_mensagens_mes) || 10000,
          percentage: data.max_mensagens_mes > 0
            ? Math.round((data.messages_used / data.max_mensagens_mes) * 100)
            : 0
        },
        tokens: {
          used: parseInt(data.tokens_used) || 0,
          limit: parseInt(data.max_tokens_mes) || 5000000,
          percentage: data.max_tokens_mes > 0
            ? Math.round((data.tokens_used / data.max_tokens_mes) * 100)
            : 0
        }
      };

      return {
        success: true,
        data: {
          usage
        }
      };

    } catch (error) {
      createLogger.error('Failed to get usage data', {
        empresa_id,
        error: error.message
      });
      throw error;
    }
  });

  /**
   * POST /api/analytics/export
   * Export analytics data
   */
  fastify.post('/export', {
    preHandler: fastify.authenticate,
    schema: {
      body: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: ['overview', 'conversations', 'tools'] },
          start_date: { type: 'string', format: 'date' },
          end_date: { type: 'string', format: 'date' },
          format: { type: 'string', enum: ['json', 'csv'], default: 'json' }
        },
        required: ['type', 'start_date', 'end_date']
      }
    }
  }, async (request, reply) => {
    const { empresa_id } = request.user;
    const { type, start_date, end_date, format = 'json' } = request.body;

    try {
      // For now, return a simple JSON structure
      // In production, this would generate CSV or more complex exports

      let data = {};

      switch (type) {
        case 'overview':
          const overviewResponse = await fastify.inject({
            method: 'GET',
            url: `/api/analytics/overview?start_date=${start_date}&end_date=${end_date}`,
            headers: request.headers
          });
          data = JSON.parse(overviewResponse.body).data;
          break;

        case 'conversations':
          const convResponse = await fastify.inject({
            method: 'GET',
            url: `/api/analytics/conversations?start_date=${start_date}&end_date=${end_date}&limit=1000`,
            headers: request.headers
          });
          data = JSON.parse(convResponse.body).data;
          break;

        case 'tools':
          const toolsResponse = await fastify.inject({
            method: 'GET',
            url: `/api/analytics/tools?start_date=${start_date}&end_date=${end_date}`,
            headers: request.headers
          });
          data = JSON.parse(toolsResponse.body).data;
          break;
      }

      createLogger.info('Analytics exported', {
        empresa_id,
        type,
        format,
        start_date,
        end_date
      });

      if (format === 'csv') {
        // Simple CSV generation for demonstration
        // In production, use a proper CSV library
        return reply
          .type('text/csv')
          .header('Content-Disposition', `attachment; filename="analytics_${type}_${start_date}_${end_date}.csv"`)
          .send('data,not,implemented\n1,2,3');
      }

      return reply
        .type('application/json')
        .header('Content-Disposition', `attachment; filename="analytics_${type}_${start_date}_${end_date}.json"`)
        .send(data);

    } catch (error) {
      createLogger.error('Failed to export analytics', {
        empresa_id,
        type,
        error: error.message
      });
      throw error;
    }
  });
  /**
   * GET /api/analytics/operacional
   * Dashboard operacional: conversas, funil, operadores, por fila
   */
  fastify.get('/operacional', {
    preHandler: fastify.authenticate,
    schema: {
      querystring: {
        type: 'object',
        properties: {
          data: { type: 'string', format: 'date' },
        }
      }
    }
  }, async (request, reply) => {
    const empresa_id = request.user.empresa_id;
    const data = request.query.data || new Date().toISOString().split('T')[0];

    try {
      // 1. Resumo do dia
      const resumoResult = await pool.query(`
        SELECT
          COUNT(*) as conversas_novas,
          COUNT(DISTINCT c.contato_whatsapp) as telefones_unicos,
          COUNT(CASE WHEN primeira.primeira_vez::date = $2::date THEN 1 END) as clientes_novos
        FROM conversas c
        LEFT JOIN (
          SELECT contato_whatsapp, MIN(criado_em) as primeira_vez
          FROM conversas WHERE empresa_id = $1
          GROUP BY contato_whatsapp
        ) primeira ON primeira.contato_whatsapp = c.contato_whatsapp
        WHERE c.empresa_id = $1 AND c.criado_em::date = $2::date
      `, [empresa_id, data]);

      const resumo = resumoResult.rows[0];
      resumo.clientes_retorno = resumo.conversas_novas - resumo.clientes_novos;

      // 2. Engajamento (responderam vs abandonaram)
      const engajamentoResult = await pool.query(`
        SELECT
          COUNT(*) as total,
          COUNT(CASE WHEN msgs_cliente > 1 THEN 1 END) as responderam,
          COUNT(CASE WHEN msgs_cliente <= 1 THEN 1 END) as abandonaram,
          AVG(CASE WHEN finalizado_em IS NOT NULL THEN EXTRACT(EPOCH FROM (finalizado_em - c.criado_em)) END) as tempo_medio_seg
        FROM conversas c
        LEFT JOIN (
          SELECT conversa_id, COUNT(*) as msgs_cliente
          FROM mensagens_log WHERE direcao = 'entrada' AND empresa_id = $1
          GROUP BY conversa_id
        ) ml ON ml.conversa_id = c.id
        WHERE c.empresa_id = $1 AND c.criado_em::date = $2::date
      `, [empresa_id, data]);

      const engajamento = engajamentoResult.rows[0];

      // 3. Por fila
      const filasResult = await pool.query(`
        SELECT
          COALESCE(f.nome, 'Sem fila') as fila_nome,
          c.fila_id,
          COUNT(*) as total,
          COUNT(CASE WHEN ml.msgs_cliente > 1 THEN 1 END) as responderam,
          COUNT(CASE WHEN ml.msgs_cliente <= 1 THEN 1 END) as abandonaram,
          AVG(CASE WHEN c.finalizado_em IS NOT NULL THEN EXTRACT(EPOCH FROM (c.finalizado_em - c.criado_em)) END) as tempo_medio_seg
        FROM conversas c
        LEFT JOIN filas_atendimento f ON f.id = c.fila_id
        LEFT JOIN (
          SELECT conversa_id, COUNT(*) as msgs_cliente
          FROM mensagens_log WHERE direcao = 'entrada' AND empresa_id = $1
          GROUP BY conversa_id
        ) ml ON ml.conversa_id = c.id
        WHERE c.empresa_id = $1 AND c.criado_em::date = $2::date
        GROUP BY f.nome, c.fila_id
        ORDER BY total DESC
      `, [empresa_id, data]);

      // 4. Por hora
      const porHoraResult = await pool.query(`
        SELECT
          EXTRACT(HOUR FROM criado_em) as hora,
          COUNT(*) as total
        FROM conversas
        WHERE empresa_id = $1 AND criado_em::date = $2::date
        GROUP BY EXTRACT(HOUR FROM criado_em)
        ORDER BY hora
      `, [empresa_id, data]);

      // 5. Performance operadores
      const operadoresResult = await pool.query(`
        SELECT
          u.id as operador_id,
          u.nome as operador_nome,
          COUNT(DISTINCT ml.conversa_id) as atendimentos,
          COUNT(ml.id) as msgs_enviadas,
          MIN(ml.criado_em) as primeira_msg,
          MAX(ml.criado_em) as ultima_msg,
          EXTRACT(EPOCH FROM (MAX(ml.criado_em) - MIN(ml.criado_em))) as tempo_ativo_seg
        FROM mensagens_log ml
        JOIN usuarios u ON u.id = ml.remetente_id
        WHERE ml.empresa_id = $1
          AND ml.criado_em::date = $2::date
          AND ml.direcao = 'saida'
          AND ml.remetente_tipo = 'operador'
        GROUP BY u.id, u.nome
        ORDER BY atendimentos DESC
      `, [empresa_id, data]);

      // 6. Funil chatbot
      const funilResult = await pool.query(`
        SELECT
          COUNT(*) as total_conversas,
          COUNT(CASE WHEN ml_total.msgs > 0 THEN 1 END) as receberam_resposta,
          COUNT(CASE WHEN ml_bot.msgs_bot > 0 THEN 1 END) as passaram_chatbot,
          COUNT(CASE WHEN ml_ia.msgs_ia > 0 THEN 1 END) as chegaram_ia
        FROM conversas c
        LEFT JOIN (
          SELECT conversa_id, COUNT(*) as msgs FROM mensagens_log WHERE direcao = 'saida' AND empresa_id = $1 GROUP BY conversa_id
        ) ml_total ON ml_total.conversa_id = c.id
        LEFT JOIN (
          SELECT conversa_id, COUNT(*) as msgs_bot FROM mensagens_log WHERE remetente_tipo = 'chatbot' AND empresa_id = $1 GROUP BY conversa_id
        ) ml_bot ON ml_bot.conversa_id = c.id
        LEFT JOIN (
          SELECT conversa_id, COUNT(*) as msgs_ia FROM mensagens_log WHERE remetente_tipo = 'ia' AND empresa_id = $1 GROUP BY conversa_id
        ) ml_ia ON ml_ia.conversa_id = c.id
        WHERE c.empresa_id = $1 AND c.criado_em::date = $2::date
      `, [empresa_id, data]);

      // 7. Tabela de conversas (últimas 100)
      const conversasResult = await pool.query(`
        SELECT
          c.id, c.numero_ticket, c.contato_whatsapp, c.contato_nome,
          c.status, c.controlado_por, c.criado_em, c.finalizado_em,
          f.nome as fila_nome,
          COALESCE(ml_in.msgs, 0) as msgs_cliente,
          COALESCE(ml_out.msgs, 0) as msgs_saida,
          CASE WHEN c.finalizado_em IS NOT NULL
            THEN EXTRACT(EPOCH FROM (c.finalizado_em - c.criado_em))
            ELSE EXTRACT(EPOCH FROM (NOW() - c.criado_em))
          END as duracao_seg
        FROM conversas c
        LEFT JOIN filas_atendimento f ON f.id = c.fila_id
        LEFT JOIN (SELECT conversa_id, COUNT(*) as msgs FROM mensagens_log WHERE direcao = 'entrada' GROUP BY conversa_id) ml_in ON ml_in.conversa_id = c.id
        LEFT JOIN (SELECT conversa_id, COUNT(*) as msgs FROM mensagens_log WHERE direcao = 'saida' GROUP BY conversa_id) ml_out ON ml_out.conversa_id = c.id
        WHERE c.empresa_id = $1 AND c.criado_em::date = $2::date
        ORDER BY c.criado_em DESC
        LIMIT 100
      `, [empresa_id, data]);

      return {
        success: true,
        data: {
          data_filtro: data,
          resumo: {
            conversas_novas: parseInt(resumo.conversas_novas),
            clientes_novos: parseInt(resumo.clientes_novos),
            clientes_retorno: parseInt(resumo.clientes_retorno),
            telefones_unicos: parseInt(resumo.telefones_unicos),
            responderam: parseInt(engajamento.responderam || 0),
            abandonaram: parseInt(engajamento.abandonaram || 0),
            taxa_resposta: engajamento.total > 0 ? Math.round((engajamento.responderam / engajamento.total) * 100) : 0,
            tempo_medio_min: engajamento.tempo_medio_seg ? Math.round(engajamento.tempo_medio_seg / 60) : 0,
          },
          funil: funilResult.rows[0],
          por_fila: filasResult.rows.map(f => ({
            ...f,
            total: parseInt(f.total),
            responderam: parseInt(f.responderam),
            abandonaram: parseInt(f.abandonaram),
            tempo_medio_min: f.tempo_medio_seg ? Math.round(f.tempo_medio_seg / 60) : 0,
          })),
          por_hora: porHoraResult.rows.map(h => ({ hora: parseInt(h.hora), total: parseInt(h.total) })),
          operadores: operadoresResult.rows.map(op => ({
            ...op,
            atendimentos: parseInt(op.atendimentos),
            msgs_enviadas: parseInt(op.msgs_enviadas),
            tempo_ativo_min: op.tempo_ativo_seg ? Math.round(op.tempo_ativo_seg / 60) : 0,
          })),
          conversas: conversasResult.rows,
        }
      };
    } catch (error) {
      createLogger.error({ err: error, empresa_id }, 'Error in operacional analytics');
      throw error;
    }
  });
};

export default analyticsRoutes;