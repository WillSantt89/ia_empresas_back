import { logger } from '../config/logger.js';
import { pool } from '../config/database.js';
import { checkPermission } from '../middleware/permission.js';

const createLogger = logger.child({ module: 'tool-executions-routes' });

const toolExecutionsRoutes = async (fastify) => {
  /**
   * GET /api/tool-executions
   * List tool executions with filters and pagination
   */
  fastify.get('/', {
    preHandler: [fastify.authenticate, checkPermission(['master', 'admin_suporte', 'admin', 'supervisor'])],
    schema: {
      querystring: {
        type: 'object',
        properties: {
          page: { type: 'integer', minimum: 1, default: 1 },
          limit: { type: 'integer', minimum: 1, maximum: 100, default: 30 },
          tool_nome: { type: 'string' },
          tipo_tool: { type: 'string' },
          agente_id: { type: 'string', format: 'uuid' },
          sucesso: { type: 'boolean' },
          search: { type: 'string' },
          start_date: { type: 'string', format: 'date' },
          end_date: { type: 'string', format: 'date' },
        }
      }
    }
  }, async (request, reply) => {
    const { empresa_id } = request.user;
    const { page, limit, tool_nome, tipo_tool, agente_id, sucesso, search, start_date, end_date } = request.query;
    const offset = (page - 1) * limit;

    try {
      let query = `
        SELECT
          te.id,
          te.tool_nome,
          te.tipo_tool,
          te.agente_nome,
          te.contato_whatsapp,
          te.contato_nome,
          te.parametros_json,
          te.resultado_json,
          te.sucesso,
          te.erro,
          te.tempo_processamento_ms,
          te.criado_em,
          te.conversa_id,
          te.agente_id,
          te.tool_id
        FROM tool_executions te
        WHERE te.empresa_id = $1
      `;

      const params = [empresa_id];
      let paramIndex = 2;

      if (tool_nome) {
        query += ` AND te.tool_nome ILIKE $${paramIndex}`;
        params.push(`%${tool_nome}%`);
        paramIndex++;
      }

      if (tipo_tool) {
        query += ` AND te.tipo_tool = $${paramIndex}`;
        params.push(tipo_tool);
        paramIndex++;
      }

      if (agente_id) {
        query += ` AND te.agente_id = $${paramIndex}`;
        params.push(agente_id);
        paramIndex++;
      }

      if (sucesso !== undefined) {
        query += ` AND te.sucesso = $${paramIndex}`;
        params.push(sucesso);
        paramIndex++;
      }

      if (search) {
        query += ` AND (te.contato_whatsapp ILIKE $${paramIndex} OR te.contato_nome ILIKE $${paramIndex} OR te.tool_nome ILIKE $${paramIndex})`;
        params.push(`%${search}%`);
        paramIndex++;
      }

      if (start_date) {
        query += ` AND te.criado_em >= $${paramIndex}::date`;
        params.push(start_date);
        paramIndex++;
      }

      if (end_date) {
        query += ` AND te.criado_em < ($${paramIndex}::date + interval '1 day')`;
        params.push(end_date);
        paramIndex++;
      }

      // Count total
      const countQuery = query.replace(
        /SELECT[\s\S]*FROM tool_executions te/,
        'SELECT COUNT(*) as total FROM tool_executions te'
      );
      const countResult = await pool.query(countQuery, params);
      const total = parseInt(countResult.rows[0].total) || 0;

      // Stats
      const statsQuery = query.replace(
        /SELECT[\s\S]*FROM tool_executions te/,
        `SELECT
          COUNT(*) as total,
          COUNT(*) FILTER (WHERE te.sucesso = true) as total_sucesso,
          COUNT(*) FILTER (WHERE te.sucesso = false) as total_falha,
          COALESCE(AVG(te.tempo_processamento_ms), 0) as tempo_medio_ms
        FROM tool_executions te`
      );
      const statsResult = await pool.query(statsQuery, params);
      const stats = statsResult.rows[0];

      // Paginated results
      query += ` ORDER BY te.criado_em DESC LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
      params.push(limit, offset);

      const result = await pool.query(query, params);

      return {
        success: true,
        data: {
          executions: result.rows,
          stats: {
            total: parseInt(stats.total) || 0,
            total_sucesso: parseInt(stats.total_sucesso) || 0,
            total_falha: parseInt(stats.total_falha) || 0,
            tempo_medio_ms: Math.round(parseFloat(stats.tempo_medio_ms)) || 0,
          },
          pagination: {
            page,
            limit,
            total,
            pages: Math.ceil(total / limit),
          }
        }
      };
    } catch (error) {
      // If table doesn't exist yet (migration 054 not run), return empty data
      if (error.message?.includes('tool_executions') && error.message?.includes('does not exist')) {
        createLogger.warn('Table tool_executions does not exist yet — returning empty data');
        return {
          success: true,
          data: {
            executions: [],
            stats: { total: 0, total_sucesso: 0, total_falha: 0, tempo_medio_ms: 0 },
            pagination: { page, limit, total: 0, pages: 0 }
          }
        };
      }
      createLogger.error('Failed to list tool executions', { empresa_id, error: error.message });
      throw error;
    }
  });
};

export default toolExecutionsRoutes;
