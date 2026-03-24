import { pool } from '../config/database.js';
import { logger } from '../config/logger.js';

export default async function logsRoutes(fastify, opts) {
  // Listar logs de mensagens
  fastify.get('/', {
    preHandler: [
      fastify.authenticate,
      fastify.addTenantFilter,
      fastify.requirePermission('logs', 'read')
    ],
    schema: {
      querystring: {
        type: 'object',
        properties: {
          conversa_id: { type: 'string', format: 'uuid' },
          agente_id: { type: 'string', format: 'uuid' },
          direcao: { type: 'string', enum: ['entrada', 'saida'] },
          com_erro: { type: 'boolean' },
          data_inicio: { type: 'string', format: 'date-time' },
          data_fim: { type: 'string', format: 'date-time' },
          modelo_usado: { type: 'string' },
          page: { type: 'integer', minimum: 1, default: 1 },
          per_page: { type: 'integer', minimum: 1, maximum: 100, default: 50 }
        }
      }
    }
  }, async (request, reply) => {
    try {
      const { empresaId } = request;
      const {
        conversa_id, agente_id, direcao, com_erro,
        data_inicio, data_fim, modelo_usado,
        page, per_page
      } = request.query;
      const offset = (page - 1) * per_page;

      let query = `
        SELECT
          ml.id,
          ml.conversa_id,
          ml.direcao,
          ml.conteudo,
          ml.tokens_input,
          ml.tokens_output,
          ml.tools_invocadas_json,
          ml.modelo_usado,
          ml.latencia_ms,
          ml.erro,
          ml.criado_em,
          ml.remetente_tipo,
          c.contato_whatsapp,
          c.contato_nome,
          c.numero_ticket,
          a.nome as agente_nome,
          ak.nome_exibicao as api_key_nome
        FROM mensagens_log ml
        JOIN conversas c ON c.id = ml.conversa_id
        LEFT JOIN agentes a ON a.id = c.agente_id
        LEFT JOIN api_keys ak ON ak.id = ml.api_key_usada_id
        WHERE ml.empresa_id = $1
      `;

      const params = [empresaId];
      const conditions = [];

      if (conversa_id) {
        params.push(conversa_id);
        conditions.push(`ml.conversa_id = $${params.length}`);
      }

      if (agente_id) {
        params.push(agente_id);
        conditions.push(`c.agente_id = $${params.length}`);
      }

      if (direcao) {
        params.push(direcao);
        conditions.push(`ml.direcao = $${params.length}`);
      }

      if (com_erro === true) {
        conditions.push('ml.erro IS NOT NULL');
      } else if (com_erro === false) {
        conditions.push('ml.erro IS NULL');
      }

      if (data_inicio) {
        params.push(data_inicio);
        conditions.push(`ml.criado_em >= $${params.length}`);
      }

      if (data_fim) {
        params.push(data_fim);
        conditions.push(`ml.criado_em <= $${params.length}`);
      }

      if (modelo_usado) {
        params.push(modelo_usado);
        conditions.push(`ml.modelo_usado = $${params.length}`);
      }

      if (conditions.length > 0) {
        query += ` AND ${conditions.join(' AND ')}`;
      }

      // Query para contagem total
      let countQuery = `
        SELECT COUNT(*) FROM mensagens_log ml
        JOIN conversas c ON c.id = ml.conversa_id
        LEFT JOIN agentes a ON a.id = c.agente_id
        WHERE ml.empresa_id = $1
      `;
      if (conditions.length > 0) {
        countQuery += ` AND ${conditions.join(' AND ')}`;
      }

      const totalResult = await pool.query(countQuery, params);
      const total = parseInt(totalResult.rows[0].count);

      // Adicionar ordenação e paginação
      query += ' ORDER BY ml.criado_em DESC LIMIT $' + (params.length + 1) + ' OFFSET $' + (params.length + 2);
      params.push(per_page, offset);

      const result = await pool.query(query, params);

      // Processar logs para formato mais legível
      const logs = result.rows.map(log => ({
        ...log,
        conteudo_truncado: log.conteudo ?
          log.conteudo.substring(0, 200) + (log.conteudo.length > 200 ? '...' : '') : null,
        tools_invocadas: log.tools_invocadas_json || [],
        total_tokens: (log.tokens_input || 0) + (log.tokens_output || 0),
        tem_erro: !!log.erro
      }));

      // Estatísticas da página
      const statsResult = await pool.query(`
        SELECT
          SUM(tokens_input + tokens_output) as total_tokens,
          AVG(latencia_ms) as latencia_media,
          COUNT(*) FILTER (WHERE erro IS NOT NULL) as total_erros,
          COUNT(DISTINCT conversa_id) as conversas_unicas,
          COUNT(DISTINCT modelo_usado) as modelos_unicos
        FROM mensagens_log
        WHERE empresa_id = $1
          ${conditions.length > 0 ? 'AND ' + conditions.join(' AND ') : ''}
      `, params.slice(0, -2));

      return {
        success: true,
        data: logs,
        meta: {
          total,
          page,
          per_page,
          total_pages: Math.ceil(total / per_page),
          estatisticas: {
            total_tokens: parseInt(statsResult.rows[0].total_tokens || 0),
            latencia_media_ms: parseFloat(statsResult.rows[0].latencia_media || 0),
            total_erros: parseInt(statsResult.rows[0].total_erros || 0),
            conversas_unicas: parseInt(statsResult.rows[0].conversas_unicas || 0),
            modelos_usados: parseInt(statsResult.rows[0].modelos_unicos || 0)
          }
        }
      };
    } catch (error) {
      logger.error('Error listing logs:', error);
      throw error;
    }
  });

  // Obter detalhes de um log
  fastify.get('/:id', {
    preHandler: [
      fastify.authenticate,
      fastify.addTenantFilter,
      fastify.requirePermission('logs', 'read')
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
          ml.*,
                    c.contato_whatsapp,
          c.controlado_por,
          a.nome as agente_nome,
          a.tipo as agente_tipo,
          a.modelo_llm as agente_modelo_configurado,
          ak.nome_exibicao as api_key_nome,
          ak.provedor as api_key_provedor,
          u.nome as humano_nome
        FROM mensagens_log ml
        JOIN conversas c ON c.id = ml.conversa_id
        LEFT JOIN agentes a ON a.id = c.agente_id
        LEFT JOIN api_keys ak ON ak.id = ml.api_key_usada_id
        LEFT JOIN usuarios u ON u.id = c.humano_id
        WHERE ml.id = $1 AND ml.empresa_id = $2
      `, [id, empresaId]);

      if (result.rows.length === 0) {
        return reply.code(404).send({
          success: false,
          error: {
            code: 'LOG_NOT_FOUND',
            message: 'Log não encontrado'
          }
        });
      }

      const log = result.rows[0];

      // Buscar mensagens vizinhas (contexto)
      const contextResult = await pool.query(`
        SELECT
          id,
          direcao,
          conteudo,
          criado_em,
          erro IS NOT NULL as tem_erro
        FROM mensagens_log
        WHERE conversa_id = $1
          AND criado_em BETWEEN $2 - INTERVAL '5 minutes' AND $2 + INTERVAL '5 minutes'
          AND id != $3
        ORDER BY criado_em
        LIMIT 10
      `, [log.conversa_id, log.criado_em, id]);

      // Análise das tools invocadas
      let toolsAnalysis = null;
      if (log.tools_invocadas_json && log.tools_invocadas_json.length > 0) {
        const toolNames = log.tools_invocadas_json.map(t => t.name);
        const toolsResult = await pool.query(
          'SELECT id, nome, descricao_para_llm FROM tools WHERE nome = ANY($1) AND empresa_id = $2',
          [toolNames, empresaId]
        );

        toolsAnalysis = log.tools_invocadas_json.map(invocation => {
          const toolInfo = toolsResult.rows.find(t => t.nome === invocation.name);
          return {
            ...invocation,
            tool_id: toolInfo?.id,
            descricao: toolInfo?.descricao_para_llm,
            encontrada: !!toolInfo
          };
        });
      }

      return {
        success: true,
        data: {
          ...log,
          tools_analise: toolsAnalysis,
          contexto: contextResult.rows,
          metricas: {
            total_tokens: (log.tokens_input || 0) + (log.tokens_output || 0),
            custo_estimado: calculateCost(log.modelo_usado, log.tokens_input, log.tokens_output),
            velocidade_tokens_seg: log.latencia_ms > 0 ?
              Math.round(((log.tokens_output || 0) / log.latencia_ms) * 1000) : 0
          }
        }
      };
    } catch (error) {
      logger.error('Error getting log details:', error);
      throw error;
    }
  });

  // Exportar logs
  fastify.get('/export', {
    preHandler: [
      fastify.authenticate,
      fastify.addTenantFilter,
      fastify.requirePermission('logs', 'read')
    ],
    schema: {
      querystring: {
        type: 'object',
        properties: {
          formato: { type: 'string', enum: ['csv', 'json'], default: 'csv' },
          conversa_id: { type: 'string', format: 'uuid' },
          data_inicio: { type: 'string', format: 'date' },
          data_fim: { type: 'string', format: 'date' },
          incluir_conteudo: { type: 'boolean', default: false }
        }
      }
    }
  }, async (request, reply) => {
    try {
      const { empresaId } = request;
      const {
        formato, conversa_id, data_inicio, data_fim, incluir_conteudo
      } = request.query;

      let query = `
        SELECT
          ml.id,
          ml.criado_em,
          ml.direcao,
          ${incluir_conteudo ? 'ml.conteudo,' : ''}
          ml.tokens_input,
          ml.tokens_output,
          ml.modelo_usado,
          ml.latencia_ms,
          ml.erro IS NOT NULL as tem_erro,
                    c.contato_whatsapp,
          a.nome as agente_nome
        FROM mensagens_log ml
        JOIN conversas c ON c.id = ml.conversa_id
        LEFT JOIN agentes a ON a.id = c.agente_id
        WHERE ml.empresa_id = $1
      `;

      const params = [empresaId];
      const conditions = [];

      if (conversa_id) {
        params.push(conversa_id);
        conditions.push(`ml.conversa_id = $${params.length}`);
      }

      if (data_inicio) {
        params.push(data_inicio);
        conditions.push(`ml.criado_em >= $${params.length}`);
      }

      if (data_fim) {
        params.push(data_fim);
        conditions.push(`ml.criado_em <= $${params.length} + INTERVAL '1 day'`);
      }

      if (conditions.length > 0) {
        query += ` AND ${conditions.join(' AND ')}`;
      }

      query += ' ORDER BY ml.criado_em DESC LIMIT 10000'; // Limite de segurança

      const result = await pool.query(query, params);

      if (formato === 'csv') {
        const csvHeader = [
          'ID',
          'Data/Hora',
          'Direção',
          incluir_conteudo ? 'Conteúdo' : null,
          'Tokens Input',
          'Tokens Output',
          'Modelo',
          'Latência (ms)',
          'Erro',
          'Contato',
          'Agente'
        ].filter(h => h !== null).join(',');

        const csvRows = result.rows.map(row => {
          const values = [
            row.id,
            row.criado_em,
            row.direcao,
            incluir_conteudo ? `"${(row.conteudo || '').replace(/"/g, '""')}"` : null,
            row.tokens_input || 0,
            row.tokens_output || 0,
            row.modelo_usado || '',
            row.latencia_ms || 0,
            row.tem_erro ? 'Sim' : 'Não',
            row.contato_whatsapp || '',
            row.agente_nome || ''
          ].filter(v => v !== null);

          return values.join(',');
        });

        const csv = [csvHeader, ...csvRows].join('\n');

        reply
          .header('Content-Type', 'text/csv')
          .header('Content-Disposition', 'attachment; filename="logs_export.csv"')
          .send(csv);
      } else {
        reply
          .header('Content-Type', 'application/json')
          .header('Content-Disposition', 'attachment; filename="logs_export.json"')
          .send({
            exportado_em: new Date().toISOString(),
            total_registros: result.rows.length,
            logs: result.rows
          });
      }
    } catch (error) {
      logger.error('Error exporting logs:', error);
      throw error;
    }
  });

  // Análise agregada de logs
  fastify.get('/analytics', {
    preHandler: [
      fastify.authenticate,
      fastify.addTenantFilter,
      fastify.requirePermission('logs', 'read')
    ],
    schema: {
      querystring: {
        type: 'object',
        properties: {
          periodo: { type: 'string', enum: ['hora', 'dia', 'semana', 'mes'], default: 'dia' },
          agente_id: { type: 'string', format: 'uuid' }
        }
      }
    }
  }, async (request, reply) => {
    try {
      const { empresaId } = request;
      const { periodo, agente_id } = request.query;

      let dateFilter;
      switch (periodo) {
        case 'hora':
          dateFilter = "NOW() - INTERVAL '1 hour'";
          break;
        case 'semana':
          dateFilter = "NOW() - INTERVAL '7 days'";
          break;
        case 'mes':
          dateFilter = "NOW() - INTERVAL '30 days'";
          break;
        default:
          dateFilter = "NOW() - INTERVAL '24 hours'";
      }

      const baseWhere = `ml.empresa_id = $1 AND ml.criado_em >= ${dateFilter}`;
      const params = [empresaId];

      let agenteFilter = '';
      if (agente_id) {
        params.push(agente_id);
        agenteFilter = ` AND c.agente_id = $${params.length}`;
      }

      // Métricas gerais
      const metricsResult = await pool.query(`
        SELECT
          COUNT(*) as total_mensagens,
          COUNT(*) FILTER (WHERE ml.direcao = 'entrada') as mensagens_entrada,
          COUNT(*) FILTER (WHERE ml.direcao = 'saida') as mensagens_saida,
          SUM(ml.tokens_input) as total_tokens_input,
          SUM(ml.tokens_output) as total_tokens_output,
          AVG(ml.latencia_ms) FILTER (WHERE ml.latencia_ms IS NOT NULL) as latencia_media,
          PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY ml.latencia_ms) FILTER (WHERE ml.latencia_ms IS NOT NULL) as latencia_mediana,
          PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY ml.latencia_ms) FILTER (WHERE ml.latencia_ms IS NOT NULL) as latencia_p95,
          COUNT(*) FILTER (WHERE ml.erro IS NOT NULL) as total_erros,
          COUNT(DISTINCT ml.conversa_id) as conversas_unicas,
          COUNT(DISTINCT c.agente_id) as agentes_unicos
        FROM mensagens_log ml
        JOIN conversas c ON c.id = ml.conversa_id
        WHERE ${baseWhere}${agenteFilter}
      `, params);

      // Distribuição por modelo
      const modelosResult = await pool.query(`
        SELECT
          ml.modelo_usado,
          COUNT(*) as total_chamadas,
          SUM(ml.tokens_input + ml.tokens_output) as total_tokens,
          AVG(ml.latencia_ms) as latencia_media,
          COUNT(*) FILTER (WHERE ml.erro IS NOT NULL) as total_erros
        FROM mensagens_log ml
        JOIN conversas c ON c.id = ml.conversa_id
        WHERE ${baseWhere}${agenteFilter}
          AND ml.modelo_usado IS NOT NULL
        GROUP BY ml.modelo_usado
        ORDER BY total_chamadas DESC
      `, params);

      // Tools mais usadas
      const toolsResult = await pool.query(`
        SELECT
          tool_data.tool_name,
          COUNT(*) as total_invocacoes,
          COUNT(DISTINCT tool_data.conversa_id) as conversas_unicas,
          COUNT(DISTINCT tool_data.agente_id) as agentes_unicos
        FROM (
          SELECT
            ml.conversa_id,
            c.agente_id,
            jsonb_array_elements(ml.tools_invocadas_json)->>'name' as tool_name
          FROM mensagens_log ml
          JOIN conversas c ON c.id = ml.conversa_id
          WHERE ${baseWhere}${agenteFilter}
            AND ml.tools_invocadas_json IS NOT NULL
        ) tool_data
        GROUP BY tool_data.tool_name
        ORDER BY total_invocacoes DESC
        LIMIT 20
      `, params);

      // Padrões de erro
      const errosResult = await pool.query(`
        SELECT
          CASE
            WHEN ml.erro LIKE '%rate%limit%' THEN 'Rate Limit'
            WHEN ml.erro LIKE '%timeout%' THEN 'Timeout'
            WHEN ml.erro LIKE '%invalid%' THEN 'Invalid Request'
            WHEN ml.erro LIKE '%network%' THEN 'Network Error'
            ELSE 'Outros'
          END as tipo_erro,
          COUNT(*) as total
        FROM mensagens_log ml
        JOIN conversas c ON c.id = ml.conversa_id
        WHERE ${baseWhere}${agenteFilter}
          AND ml.erro IS NOT NULL
        GROUP BY tipo_erro
        ORDER BY total DESC
      `, params);

      return {
        success: true,
        data: {
          periodo: periodo,
          metricas: metricsResult.rows[0],
          distribuicao_modelos: modelosResult.rows,
          tools_populares: toolsResult.rows,
          padroes_erro: errosResult.rows,
          custo_estimado: {
            total_usd: calculateTotalCost(modelosResult.rows),
            por_modelo: modelosResult.rows.map(m => ({
              modelo: m.modelo_usado,
              custo_usd: calculateCost(m.modelo_usado, 0, m.total_tokens)
            }))
          }
        }
      };
    } catch (error) {
      logger.error('Error getting log analytics:', error);
      throw error;
    }
  });
}

// Função auxiliar para calcular custo estimado
function calculateCost(modelo, tokensInput, tokensOutput) {
  // Preços estimados por 1M tokens (ajustar conforme necessário)
  const pricing = {
    'gemini-2.0-flash-exp': { input: 0.075, output: 0.30 },
    'gemini-1.5-flash': { input: 0.075, output: 0.30 },
    'gemini-1.5-pro': { input: 1.25, output: 5.00 },
    'gpt-4': { input: 10.00, output: 30.00 },
    'gpt-3.5-turbo': { input: 0.50, output: 1.50 }
  };

  const modelPricing = pricing[modelo] || { input: 0.10, output: 0.30 };

  const inputCost = (tokensInput / 1000000) * modelPricing.input;
  const outputCost = (tokensOutput / 1000000) * modelPricing.output;

  return Number((inputCost + outputCost).toFixed(6));
}

function calculateTotalCost(modelStats) {
  return modelStats.reduce((total, stat) => {
    return total + calculateCost(stat.modelo_usado, 0, stat.total_tokens);
  }, 0).toFixed(2);
}