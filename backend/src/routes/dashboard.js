import { pool } from '../config/database.js';
import { logger } from '../config/logger.js';

export default async function dashboardRoutes(fastify, opts) {
  // Dashboard da empresa
  fastify.get('/', {
    preHandler: [
      fastify.authenticate,
      fastify.addTenantFilter,
      fastify.requirePermission('dashboard', 'read')
    ],
    schema: {
      querystring: {
        type: 'object',
        properties: {
          periodo: { type: 'string', enum: ['hoje', 'semana', 'mes', 'ano'], default: 'hoje' }
        }
      }
    }
  }, async (request, reply) => {
    try {
      const { empresaId } = request;
      const { periodo } = request.query;

      // Determinar intervalo de datas
      let dateFilter = "DATE_TRUNC('day', CURRENT_DATE)";
      let dateFilterLabel = 'Hoje';

      switch (periodo) {
        case 'semana':
          dateFilter = "DATE_TRUNC('week', CURRENT_DATE)";
          dateFilterLabel = 'Esta semana';
          break;
        case 'mes':
          dateFilter = "DATE_TRUNC('month', CURRENT_DATE)";
          dateFilterLabel = 'Este mês';
          break;
        case 'ano':
          dateFilter = "DATE_TRUNC('year', CURRENT_DATE)";
          dateFilterLabel = 'Este ano';
          break;
      }

      // Métricas gerais
      const metricsResult = await pool.query(`
        WITH periodo_data AS (
          SELECT ${dateFilter} as data_inicio
        )
        SELECT
          -- Contadores de recursos
          (SELECT COUNT(*) FROM agentes WHERE empresa_id = $1 AND ativo = true) as agentes_ativos,
          (SELECT COUNT(*) FROM whatsapp_numbers WHERE empresa_id = $1 AND ativo = true) as numeros_ativos,
          (SELECT COUNT(*) FROM tools WHERE empresa_id = $1 AND ativo = true) as tools_ativas,
          (SELECT COUNT(*) FROM usuarios WHERE empresa_id = $1 AND ativo = true) as usuarios_ativos,

          -- Conversas
          (SELECT COUNT(*) FROM conversas WHERE empresa_id = $1 AND status = 'ativo') as conversas_ativas_agora,
          (SELECT COUNT(*) FROM conversas WHERE empresa_id = $1 AND criado_em >= (SELECT data_inicio FROM periodo_data)) as conversas_periodo,
          (SELECT COUNT(*) FROM conversas WHERE empresa_id = $1 AND status = 'ativo' AND controlado_por = 'ia') as conversas_ia,
          (SELECT COUNT(*) FROM conversas WHERE empresa_id = $1 AND status = 'ativo' AND controlado_por = 'humano') as conversas_humano,

          -- Atendimentos
          (SELECT COUNT(*) FROM atendimentos WHERE empresa_id = $1 AND iniciado_em >= (SELECT data_inicio FROM periodo_data)) as atendimentos_periodo,

          -- Mensagens
          (SELECT COUNT(*) FROM mensagens_log WHERE empresa_id = $1 AND criado_em >= (SELECT data_inicio FROM periodo_data)) as mensagens_periodo,
          (SELECT SUM(tokens_input + tokens_output) FROM mensagens_log WHERE empresa_id = $1 AND criado_em >= (SELECT data_inicio FROM periodo_data)) as tokens_periodo,

          -- Latência média (ms)
          (SELECT AVG(latencia_ms) FROM mensagens_log WHERE empresa_id = $1 AND criado_em >= (SELECT data_inicio FROM periodo_data) AND latencia_ms IS NOT NULL) as latencia_media_periodo
      `, [empresaId]);

      const metrics = metricsResult.rows[0];

      // Limites da assinatura
      const limitsResult = await pool.query(`
        SELECT
          p.max_usuarios,
          p.max_tools,
          p.max_mensagens_mes,
          p.permite_modelo_pro,
          a.status as assinatura_status,
          um.total_mensagens as mensagens_mes_atual
        FROM assinaturas a
        JOIN planos p ON p.id = a.plano_id
        LEFT JOIN uso_mensal um ON um.empresa_id = a.empresa_id
          AND um.ano_mes = TO_CHAR(CURRENT_DATE, 'YYYY-MM')
        WHERE a.empresa_id = $1
      `, [empresaId]);

      const limits = limitsResult.rows[0] || {};

      // Atendimentos por agente
      const agenteStatsResult = await pool.query(`
        SELECT
          a.id,
          a.nome,
          a.tipo,
          a.conta_atendimento,
          uda.total_atendimentos as atendimentos_hoje,
          uda.limite_diario,
          uda.limite_atingido,
          COUNT(DISTINCT at.id) as atendimentos_periodo
        FROM agentes a
        LEFT JOIN uso_diario_agente uda ON uda.agente_id = a.id
          AND uda.data = CURRENT_DATE
        LEFT JOIN atendimentos at ON at.agente_id = a.id
          AND at.iniciado_em >= ${dateFilter}
        WHERE a.empresa_id = $1 AND a.ativo = true
        GROUP BY a.id, a.nome, a.tipo, a.conta_atendimento,
          uda.total_atendimentos, uda.limite_diario, uda.limite_atingido
        ORDER BY a.tipo, a.nome
      `, [empresaId]);

      // Evolução temporal (últimos 7 dias)
      const evolutionResult = await pool.query(`
        WITH dias AS (
          SELECT generate_series(
            CURRENT_DATE - INTERVAL '6 days',
            CURRENT_DATE,
            '1 day'::interval
          )::date as data
        )
        SELECT
          d.data,
          COUNT(DISTINCT c.id) as conversas,
          COUNT(DISTINCT at.id) as atendimentos,
          COUNT(DISTINCT m.id) as mensagens,
          COALESCE(SUM(m.tokens_input + m.tokens_output), 0) as tokens
        FROM dias d
        LEFT JOIN conversas c ON DATE(c.criado_em) = d.data
          AND c.empresa_id = $1
        LEFT JOIN atendimentos at ON DATE(at.iniciado_em) = d.data
          AND at.empresa_id = $1
        LEFT JOIN mensagens_log m ON DATE(m.criado_em) = d.data
          AND m.empresa_id = $1
        GROUP BY d.data
        ORDER BY d.data
      `, [empresaId]);

      // Top tools utilizadas
      const toolsResult = await pool.query(`
        SELECT
          tool_name,
          COUNT(*) as total_chamadas,
          COUNT(DISTINCT conversa_id) as conversas_unicas
        FROM (
          SELECT
            conversa_id,
            jsonb_array_elements(tools_invocadas_json)->>'name' as tool_name
          FROM mensagens_log
          WHERE empresa_id = $1
            AND criado_em >= ${dateFilter}
            AND tools_invocadas_json IS NOT NULL
        ) t
        GROUP BY tool_name
        ORDER BY total_chamadas DESC
        LIMIT 10
      `, [empresaId]);

      // Taxa de transferência entre agentes
      const transferStatsResult = await pool.query(`
        SELECT
          COUNT(*) as total_transferencias
        FROM conversas
        WHERE empresa_id = $1
          AND criado_em >= ${dateFilter}
          AND jsonb_array_length(historico_agentes_json) > 1
      `, [empresaId]);

      // Alertas ativos
      const alertsResult = await pool.query(`
        SELECT
          n.tipo,
          n.titulo,
          n.mensagem,
          n.severidade,
          n.criado_em
        FROM notificacoes n
        WHERE n.empresa_id = $1
          AND n.lida = false
          AND n.criado_em >= CURRENT_DATE - INTERVAL '7 days'
        ORDER BY
          CASE n.severidade
            WHEN 'critical' THEN 1
            WHEN 'warning' THEN 2
            ELSE 3
          END,
          n.criado_em DESC
        LIMIT 10
      `, [empresaId]);

      return {
        success: true,
        data: {
          periodo: dateFilterLabel,
          metricas: {
            recursos: {
              agentes_ativos: parseInt(metrics.agentes_ativos),
              numeros_ativos: parseInt(metrics.numeros_ativos),
              tools_ativas: parseInt(metrics.tools_ativas),
              usuarios_ativos: parseInt(metrics.usuarios_ativos)
            },
            conversas: {
              ativas_agora: parseInt(metrics.conversas_ativas_agora),
              total_periodo: parseInt(metrics.conversas_periodo),
              controladas_ia: parseInt(metrics.conversas_ia),
              controladas_humano: parseInt(metrics.conversas_humano),
              taxa_transferencia: transferStatsResult.rows[0].total_transferencias
            },
            atendimentos: {
              total_periodo: parseInt(metrics.atendimentos_periodo)
            },
            mensagens: {
              total_periodo: parseInt(metrics.mensagens_periodo),
              tokens_periodo: parseInt(metrics.tokens_periodo || 0),
              latencia_media_ms: parseFloat(metrics.latencia_media_periodo || 0)
            }
          },
          limites: {
            usuarios: {
              usado: parseInt(metrics.usuarios_ativos),
              limite: limits.max_usuarios || 0,
              percentual: limits.max_usuarios ?
                Math.round((parseInt(metrics.usuarios_ativos) / limits.max_usuarios) * 100) : 0
            },
            tools: {
              usado: parseInt(metrics.tools_ativas),
              limite: limits.max_tools || 0,
              percentual: limits.max_tools ?
                Math.round((parseInt(metrics.tools_ativas) / limits.max_tools) * 100) : 0
            },
            mensagens_mes: {
              usado: parseInt(limits.mensagens_mes_atual || 0),
              limite: limits.max_mensagens_mes || 0,
              percentual: limits.max_mensagens_mes ?
                Math.round((parseInt(limits.mensagens_mes_atual || 0) / limits.max_mensagens_mes) * 100) : 0
            }
          },
          agentes: agenteStatsResult.rows.map(a => ({
            id: a.id,
            nome: a.nome,
            tipo: a.tipo,
            atendimentos_hoje: parseInt(a.atendimentos_hoje || 0),
            limite_diario: parseInt(a.limite_diario || 0),
            percentual_uso: a.limite_diario ?
              Math.round((parseInt(a.atendimentos_hoje || 0) / a.limite_diario) * 100) : 0,
            limite_atingido: a.limite_atingido || false,
            atendimentos_periodo: parseInt(a.atendimentos_periodo || 0)
          })),
          evolucao: evolutionResult.rows.map(e => ({
            data: e.data,
            conversas: parseInt(e.conversas),
            atendimentos: parseInt(e.atendimentos),
            mensagens: parseInt(e.mensagens),
            tokens: parseInt(e.tokens)
          })),
          top_tools: toolsResult.rows,
          alertas: alertsResult.rows
        }
      };
    } catch (error) {
      logger.error('Error getting dashboard data:', error);
      throw error;
    }
  });

  // Dashboard global (Master only)
  fastify.get('/global', {
    preHandler: [
      fastify.authenticate,
      fastify.requirePermission('dashboard_global', 'read')
    ],
    schema: {
      querystring: {
        type: 'object',
        properties: {
          periodo: { type: 'string', enum: ['hoje', 'semana', 'mes'], default: 'hoje' }
        }
      }
    }
  }, async (request, reply) => {
    try {
      const { periodo } = request.query;

      // Determinar intervalo
      let dateFilter = "CURRENT_DATE";
      if (periodo === 'semana') {
        dateFilter = "CURRENT_DATE - INTERVAL '7 days'";
      } else if (periodo === 'mes') {
        dateFilter = "CURRENT_DATE - INTERVAL '30 days'";
      }

      // Métricas globais
      const globalMetricsResult = await pool.query(`
        SELECT
          -- Totais gerais
          (SELECT COUNT(*) FROM empresas WHERE ativo = true) as empresas_ativas,
          (SELECT COUNT(*) FROM agentes WHERE ativo = true) as total_agentes,
          (SELECT COUNT(*) FROM whatsapp_numbers WHERE ativo = true) as total_numeros,
          (SELECT COUNT(DISTINCT empresa_id) FROM conversas WHERE criado_em >= ${dateFilter}) as empresas_ativas_periodo,

          -- Atendimentos
          (SELECT COUNT(*) FROM atendimentos WHERE iniciado_em >= ${dateFilter}) as total_atendimentos,
          (SELECT COUNT(*) FROM mensagens_log WHERE criado_em >= ${dateFilter}) as total_mensagens,
          (SELECT SUM(tokens_input + tokens_output) FROM mensagens_log WHERE criado_em >= ${dateFilter}) as total_tokens
      `);

      const globalMetrics = globalMetricsResult.rows[0];

      // Empresas por plano
      const planoStatsResult = await pool.query(`
        SELECT
          p.nome as plano,
          p.preco_base_mensal,
          COUNT(DISTINCT e.id) as total_empresas,
          COUNT(DISTINCT e.id) FILTER (WHERE a.status = 'ativa') as empresas_ativas,
          SUM(p.preco_base_mensal) FILTER (WHERE a.status = 'ativa') as receita_base
        FROM planos p
        LEFT JOIN assinaturas a ON a.plano_id = p.id
        LEFT JOIN empresas e ON e.id = a.empresa_id AND e.ativo = true
        GROUP BY p.id, p.nome, p.preco_base_mensal
        ORDER BY p.preco_base_mensal
      `);

      // Receita estimada mensal
      const receitaResult = await pool.query(`
        WITH receita_detalhada AS (
          SELECT
            e.id,
            e.nome,
            p.preco_base_mensal,
            COALESCE(SUM(ai.preco_total), 0) as receita_itens
          FROM empresas e
          JOIN assinaturas a ON a.empresa_id = e.id
          JOIN planos p ON p.id = a.plano_id
          LEFT JOIN assinatura_itens ai ON ai.assinatura_id = a.id AND ai.ativo = true
          WHERE e.ativo = true AND a.status = 'ativa'
          GROUP BY e.id, e.nome, p.preco_base_mensal
        )
        SELECT
          COUNT(*) as empresas_pagantes,
          SUM(preco_base_mensal) as receita_planos,
          SUM(receita_itens) as receita_itens,
          SUM(preco_base_mensal + receita_itens) as receita_total_estimada
        FROM receita_detalhada
      `);

      // Empresas próximas do limite
      const limitesResult = await pool.query(`
        WITH limites_uso AS (
          SELECT
            e.id,
            e.nome,
            p.nome as plano,
            p.max_mensagens_mes,
            COALESCE(um.total_mensagens, 0) as mensagens_usadas,
            CASE
              WHEN p.max_mensagens_mes > 0 THEN
                (COALESCE(um.total_mensagens, 0)::float / p.max_mensagens_mes * 100)
              ELSE 0
            END as percentual_uso
          FROM empresas e
          JOIN assinaturas a ON a.empresa_id = e.id
          JOIN planos p ON p.id = a.plano_id
          LEFT JOIN uso_mensal um ON um.empresa_id = e.id
            AND um.ano_mes = TO_CHAR(CURRENT_DATE, 'YYYY-MM')
          WHERE e.ativo = true AND a.status = 'ativa'
        )
        SELECT
          id,
          nome,
          plano,
          mensagens_usadas,
          max_mensagens_mes,
          percentual_uso
        FROM limites_uso
        WHERE percentual_uso >= 80
        ORDER BY percentual_uso DESC
        LIMIT 10
      `);

      // Top empresas por uso
      const topEmpresasResult = await pool.query(`
        SELECT
          e.id,
          e.nome,
          COUNT(DISTINCT at.id) as total_atendimentos,
          COUNT(DISTINCT c.id) as total_conversas,
          COUNT(DISTINCT m.id) as total_mensagens
        FROM empresas e
        LEFT JOIN atendimentos at ON at.empresa_id = e.id
          AND at.iniciado_em >= ${dateFilter}
        LEFT JOIN conversas c ON c.empresa_id = e.id
          AND c.criado_em >= ${dateFilter}
        LEFT JOIN mensagens_log m ON m.empresa_id = e.id
          AND m.criado_em >= ${dateFilter}
        WHERE e.ativo = true
        GROUP BY e.id, e.nome
        HAVING COUNT(DISTINCT at.id) > 0
        ORDER BY total_atendimentos DESC
        LIMIT 10
      `);

      // Alertas críticos
      const alertsCriticosResult = await pool.query(`
        SELECT
          e.nome as empresa_nome,
          n.tipo,
          n.titulo,
          n.mensagem,
          n.criado_em
        FROM notificacoes n
        JOIN empresas e ON e.id = n.empresa_id
        WHERE n.severidade = 'critical'
          AND n.lida = false
          AND n.criado_em >= CURRENT_DATE - INTERVAL '7 days'
        ORDER BY n.criado_em DESC
        LIMIT 20
      `);

      return {
        success: true,
        data: {
          periodo: periodo,
          metricas_globais: {
            empresas_ativas: parseInt(globalMetrics.empresas_ativas),
            total_agentes: parseInt(globalMetrics.total_agentes),
            total_numeros: parseInt(globalMetrics.total_numeros),
            empresas_ativas_periodo: parseInt(globalMetrics.empresas_ativas_periodo),
            total_atendimentos: parseInt(globalMetrics.total_atendimentos),
            total_mensagens: parseInt(globalMetrics.total_mensagens),
            total_tokens: parseInt(globalMetrics.total_tokens || 0)
          },
          distribuicao_planos: planoStatsResult.rows.map(p => ({
            plano: p.plano,
            preco_base: parseFloat(p.preco_base_mensal),
            empresas_total: parseInt(p.total_empresas),
            empresas_ativas: parseInt(p.empresas_ativas),
            receita_base: parseFloat(p.receita_base || 0)
          })),
          receita: {
            empresas_pagantes: parseInt(receitaResult.rows[0].empresas_pagantes),
            receita_planos: parseFloat(receitaResult.rows[0].receita_planos || 0),
            receita_itens: parseFloat(receitaResult.rows[0].receita_itens || 0),
            receita_total_estimada: parseFloat(receitaResult.rows[0].receita_total_estimada || 0)
          },
          empresas_limite: limitesResult.rows.map(e => ({
            id: e.id,
            nome: e.nome,
            plano: e.plano,
            mensagens_usadas: parseInt(e.mensagens_usadas),
            limite: parseInt(e.max_mensagens_mes),
            percentual_uso: Math.round(e.percentual_uso)
          })),
          top_empresas: topEmpresasResult.rows.map(e => ({
            id: e.id,
            nome: e.nome,
            atendimentos: parseInt(e.total_atendimentos),
            conversas: parseInt(e.total_conversas),
            mensagens: parseInt(e.total_mensagens)
          })),
          alertas_criticos: alertsCriticosResult.rows
        }
      };
    } catch (error) {
      logger.error('Error getting global dashboard:', error);
      throw error;
    }
  });

  // Métricas em tempo real
  fastify.get('/realtime', {
    preHandler: [
      fastify.authenticate,
      fastify.addTenantFilter,
      fastify.requirePermission('dashboard', 'read')
    ]
  }, async (request, reply) => {
    try {
      const { empresaId } = request;

      const result = await pool.query(`
        SELECT
          -- Conversas ativas agora
          (SELECT COUNT(*) FROM conversas WHERE empresa_id = $1 AND status = 'ativo') as conversas_ativas,
          (SELECT COUNT(*) FROM conversas WHERE empresa_id = $1 AND status = 'ativo' AND controlado_por = 'ia') as conversas_ia,
          (SELECT COUNT(*) FROM conversas WHERE empresa_id = $1 AND status = 'ativo' AND controlado_por = 'humano') as conversas_humano,

          -- Atividade última hora
          (SELECT COUNT(*) FROM mensagens_log WHERE empresa_id = $1 AND criado_em >= NOW() - INTERVAL '1 hour') as mensagens_ultima_hora,
          (SELECT COUNT(DISTINCT conversa_id) FROM mensagens_log WHERE empresa_id = $1 AND criado_em >= NOW() - INTERVAL '1 hour') as conversas_ativas_ultima_hora,

          -- Latência últimos 10 minutos
          (SELECT AVG(latencia_ms) FROM mensagens_log WHERE empresa_id = $1 AND criado_em >= NOW() - INTERVAL '10 minutes' AND latencia_ms IS NOT NULL) as latencia_media_10min,

          -- Taxa de erro
          (SELECT COUNT(*) FROM mensagens_log WHERE empresa_id = $1 AND criado_em >= NOW() - INTERVAL '1 hour' AND erro IS NOT NULL) as erros_ultima_hora
      `, [empresaId]);

      return {
        success: true,
        data: {
          timestamp: new Date().toISOString(),
          ...result.rows[0]
        }
      };
    } catch (error) {
      logger.error('Error getting realtime metrics:', error);
      throw error;
    }
  });
}