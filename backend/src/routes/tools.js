import { logger } from '../config/logger.js';
import { pool } from '../config/database.js';
import { checkPermission } from '../middleware/permission.js';
import { validateTool, testTool } from '../services/tool-runner.js';

/**
 * Tools Routes
 * External HTTP tools management
 */

const createLogger = logger.child({ module: 'tools-routes' });

const toolsRoutes = async (fastify) => {
  // Tool schema
  const toolSchema = {
    type: 'object',
    properties: {
      nome: { type: 'string', minLength: 2, maxLength: 100 },
      descricao: { type: 'string', maxLength: 500 },
      descricao_para_llm: { type: 'string', minLength: 10, maxLength: 1000 },
      url: { type: 'string', format: 'uri' },
      metodo: { type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] },
      headers_json: { type: 'object' },
      body_template_json: { type: 'object' },
      parametros_schema_json: {
        type: 'object',
        properties: {
          type: { const: 'object' },
          properties: { type: 'object' },
          required: { type: 'array', items: { type: 'string' } }
        },
        required: ['type', 'properties']
      },
      timeout_ms: { type: 'integer', minimum: 100, maximum: 30000, default: 5000 },
      ativo: { type: 'boolean' }
    }
  };

  /**
   * GET /api/tools
   * List all tools
   */
  fastify.get('/', {
    preHandler: fastify.authenticate,
    schema: {
      querystring: {
        type: 'object',
        properties: {
          page: { type: 'integer', minimum: 1, default: 1 },
          limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
          search: { type: 'string' },
          ativo: { type: 'boolean' },
          is_global: { type: 'boolean' }
        }
      }
    }
  }, async (request, reply) => {
    const { empresa_id } = request.user;
    const { page, limit, search, ativo, is_global } = request.query;
    const offset = (page - 1) * limit;

    try {
      let query = `
        SELECT
          t.id,
          t.nome,
          t.descricao,
          t.url,
          t.metodo,
          t.ativo,
          t.is_global,
          t.timeout_ms,
          t.criado_em,
          t.atualizado_em,
          CASE
            WHEN t.is_global = true THEN NULL
            ELSE t.empresa_id
          END as empresa_id,
          (
            SELECT COUNT(DISTINCT at.agente_id)
            FROM agent_tools at
            WHERE at.tool_id = t.id
              AND (t.is_global = true OR at.empresa_id = $1)
          ) as agent_count,
          (
            SELECT COUNT(*)
            FROM conversacao_analytics ca
            WHERE ca.tools_chamadas > 0
              AND ca.empresa_id = $1
              AND ca.criado_em >= CURRENT_DATE - INTERVAL '7 days'
              AND EXISTS (
                SELECT 1 FROM conversas c
                WHERE c.id = ca.conversation_id
                  AND c.metadata_json->>'tools' LIKE '%' || t.nome || '%'
              )
          ) as usage_last_week
        FROM tools t
        WHERE (t.is_global = true OR t.empresa_id = $1)
      `;

      const params = [empresa_id];
      let paramIndex = 2;

      // Add filters
      if (search) {
        query += ` AND (t.nome ILIKE $${paramIndex} OR t.descricao ILIKE $${paramIndex})`;
        params.push(`%${search}%`);
        paramIndex++;
      }

      if (ativo !== undefined) {
        query += ` AND t.ativo = $${paramIndex}`;
        params.push(ativo);
        paramIndex++;
      }

      if (is_global !== undefined) {
        query += ` AND t.is_global = $${paramIndex}`;
        params.push(is_global);
        paramIndex++;
      }

      // Get total count
      const countQuery = query.replace(
        /SELECT[\s\S]*FROM tools t/,
        'SELECT COUNT(*) as total FROM tools t'
      );

      const countResult = await pool.query(countQuery, params);
      const total = parseInt(countResult.rows[0].total) || 0;

      // Add pagination
      query += ` ORDER BY t.is_global DESC, t.criado_em DESC LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
      params.push(limit, offset);

      const result = await pool.query(query, params);

      return {
        success: true,
        data: {
          tools: result.rows,
          pagination: {
            page,
            limit,
            total,
            pages: Math.ceil(total / limit)
          }
        }
      };

    } catch (error) {
      createLogger.error('Failed to list tools', {
        empresa_id,
        error: error.message
      });
      throw error;
    }
  });

  /**
   * POST /api/tools
   * Create new tool
   */
  fastify.post('/', {
    preHandler: [fastify.authenticate, checkPermission(['master', 'admin'])],
    schema: {
      body: {
        type: 'object',
        properties: toolSchema.properties,
        required: ['nome', 'descricao_para_llm', 'url', 'metodo', 'parametros_schema_json']
      }
    }
  }, async (request, reply) => {
    const { empresa_id } = request.user;
    const toolData = request.body;

    try {
      // Validate tool configuration
      const validation = validateTool(toolData);
      if (!validation.valid) {
        return reply.code(400).send({
          success: false,
          error: {
            code: 'INVALID_TOOL',
            message: 'Invalid tool configuration',
            details: validation.errors
          }
        });
      }

      // Check if tool name already exists for this company
      const existingQuery = `
        SELECT id FROM tools
        WHERE nome = $1 AND (empresa_id = $2 OR is_global = true)
      `;

      const existing = await pool.query(existingQuery, [toolData.nome, empresa_id]);

      if (existing.rows.length > 0) {
        return reply.code(409).send({
          success: false,
          error: {
            code: 'TOOL_EXISTS',
            message: 'Tool with this name already exists'
          }
        });
      }

      // Create tool
      const query = `
        INSERT INTO tools (
          empresa_id,
          nome,
          descricao,
          descricao_para_llm,
          url,
          metodo,
          headers_json,
          body_template_json,
          parametros_schema_json,
          timeout_ms,
          ativo,
          is_global
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, false)
        RETURNING *
      `;

      const result = await pool.query(query,
        [
          empresa_id,
          toolData.nome,
          toolData.descricao || null,
          toolData.descricao_para_llm,
          toolData.url,
          toolData.metodo,
          toolData.headers_json || {},
          toolData.body_template_json || {},
          toolData.parametros_schema_json,
          toolData.timeout_ms || 5000,
          toolData.ativo !== false
        ]
      );

      const tool = result.rows[0];

      createLogger.info('Tool created', {
        empresa_id,
        tool_id: tool.id,
        tool_name: tool.nome
      });

      return {
        success: true,
        data: {
          tool
        }
      };

    } catch (error) {
      createLogger.error('Failed to create tool', {
        empresa_id,
        error: error.message
      });
      throw error;
    }
  });

  /**
   * GET /api/tools/:id
   * Get tool details
   */
  fastify.get('/:id', {
    preHandler: fastify.authenticate,
    schema: {
      params: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' }
        }
      }
    }
  }, async (request, reply) => {
    const { empresa_id } = request.user;
    const { id } = request.params;

    try {
      const query = `
        SELECT
          t.*,
          (
            SELECT json_agg(json_build_object(
              'id', a.id,
              'nome', a.nome,
              'prioridade', at.prioridade
            ) ORDER BY at.prioridade)
            FROM agentes a
            INNER JOIN agent_tools at ON a.id = at.agente_id
            WHERE at.tool_id = t.id
              AND (t.is_global = true OR at.empresa_id = $1)
          ) as agents,
          (
            SELECT json_build_object(
              'total_calls', COUNT(*),
              'success_calls', COUNT(*) FILTER (WHERE sucesso = true),
              'avg_duration_ms', COALESCE(AVG(tempo_processamento_ms), 0),
              'last_used', MAX(criado_em)
            )
            FROM tool_executions te
            WHERE te.tool_id = t.id
              AND te.empresa_id = $1
          ) as usage_stats
        FROM tools t
        WHERE t.id = $2
          AND (t.is_global = true OR t.empresa_id = $1)
      `;

      const result = await pool.query(query, [empresa_id, id]);

      if (result.rows.length === 0) {
        return reply.code(404).send({
          success: false,
          error: {
            code: 'TOOL_NOT_FOUND',
            message: 'Tool not found'
          }
        });
      }

      return {
        success: true,
        data: {
          tool: result.rows[0]
        }
      };

    } catch (error) {
      createLogger.error('Failed to get tool', {
        empresa_id,
        tool_id: id,
        error: error.message
      });
      throw error;
    }
  });

  /**
   * PUT /api/tools/:id
   * Update tool
   */
  fastify.put('/:id', {
    preHandler: [fastify.authenticate, checkPermission(['master', 'admin'])],
    schema: {
      params: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' }
        }
      },
      body: toolSchema
    }
  }, async (request, reply) => {
    const { empresa_id } = request.user;
    const { id } = request.params;
    const updates = request.body;

    try {
      // Check if tool exists and user has permission
      const checkQuery = `
        SELECT id, is_global, empresa_id
        FROM tools
        WHERE id = $1 AND (empresa_id = $2 OR is_global = false)
      `;

      const checkResult = await pool.query(checkQuery, [id, empresa_id]);

      if (checkResult.rows.length === 0) {
        return reply.code(404).send({
          success: false,
          error: {
            code: 'TOOL_NOT_FOUND',
            message: 'Tool not found or you do not have permission to update it'
          }
        });
      }

      if (checkResult.rows[0].is_global) {
        return reply.code(403).send({
          success: false,
          error: {
            code: 'FORBIDDEN',
            message: 'Cannot update global tools'
          }
        });
      }

      // Validate if updating configuration
      if (updates.url || updates.metodo || updates.parametros_schema_json) {
        const currentTool = { ...checkResult.rows[0], ...updates };
        const validation = validateTool(currentTool);
        if (!validation.valid) {
          return reply.code(400).send({
            success: false,
            error: {
              code: 'INVALID_TOOL',
              message: 'Invalid tool configuration',
              details: validation.errors
            }
          });
        }
      }

      const fields = [];
      const values = [];
      let index = 1;

      // Build update query
      Object.entries(updates).forEach(([key, value]) => {
        if (value !== undefined && key !== 'id' && key !== 'empresa_id' && key !== 'is_global') {
          fields.push(`${key} = $${index}`);
          values.push(value);
          index++;
        }
      });

      if (fields.length === 0) {
        return {
          success: true,
          data: {
            message: 'No fields to update'
          }
        };
      }

      values.push(empresa_id, id);
      const query = `
        UPDATE tools
        SET ${fields.join(', ')}, atualizado_em = CURRENT_TIMESTAMP
        WHERE empresa_id = $${index} AND id = $${index + 1}
        RETURNING *
      `;

      const result = await pool.query(query, values);

      createLogger.info('Tool updated', {
        empresa_id,
        tool_id: id,
        updated_fields: Object.keys(updates)
      });

      return {
        success: true,
        data: {
          tool: result.rows[0]
        }
      };

    } catch (error) {
      createLogger.error('Failed to update tool', {
        empresa_id,
        tool_id: id,
        error: error.message
      });
      throw error;
    }
  });

  /**
   * DELETE /api/tools/:id
   * Delete tool
   */
  fastify.delete('/:id', {
    preHandler: [fastify.authenticate, checkPermission(['master', 'admin'])],
    schema: {
      params: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' }
        }
      }
    }
  }, async (request, reply) => {
    const { empresa_id } = request.user;
    const { id } = request.params;

    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      // Check if tool exists and has permissions
      const checkQuery = `
        SELECT id, nome, is_global
        FROM tools
        WHERE id = $1 AND empresa_id = $2 AND is_global = false
      `;

      const checkResult = await client.query(checkQuery, [id, empresa_id]);

      if (checkResult.rows.length === 0) {
        await client.query('ROLLBACK');
        return reply.code(404).send({
          success: false,
          error: {
            code: 'TOOL_NOT_FOUND',
            message: 'Tool not found or cannot be deleted'
          }
        });
      }

      // Remove tool from all agents
      await client.query('DELETE FROM agent_tools WHERE empresa_id = $1 AND tool_id = $2',
        [empresa_id, id]
      );

      // Delete tool
      await client.query('DELETE FROM tools WHERE empresa_id = $1 AND id = $2',
        [empresa_id, id]
      );

      await client.query('COMMIT');

      createLogger.info('Tool deleted', {
        empresa_id,
        tool_id: id,
        tool_name: checkResult.rows[0].nome
      });

      return {
        success: true,
        data: {
          message: 'Tool deleted successfully',
          tool: checkResult.rows[0]
        }
      };

    } catch (error) {
      await client.query('ROLLBACK');
      createLogger.error('Failed to delete tool', {
        empresa_id,
        tool_id: id,
        error: error.message
      });
      throw error;
    } finally {
      client.release();
    }
  });

  /**
   * POST /api/tools/:id/test
   * Test tool execution
   */
  fastify.post('/:id/test', {
    preHandler: [fastify.authenticate],
    schema: {
      params: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' }
        }
      },
      body: {
        type: 'object',
        properties: {
          args: { type: 'object' }
        }
      }
    }
  }, async (request, reply) => {
    const { empresa_id } = request.user;
    const { id } = request.params;
    const { args = {} } = request.body;

    try {
      // Get tool configuration
      const query = `
        SELECT *
        FROM tools
        WHERE id = $1
          AND (is_global = true OR empresa_id = $2)
          AND ativo = true
      `;

      const result = await pool.query(query, [id, empresa_id]);

      if (result.rows.length === 0) {
        return reply.code(404).send({
          success: false,
          error: {
            code: 'TOOL_NOT_FOUND',
            message: 'Active tool not found'
          }
        });
      }

      const tool = result.rows[0];

      // Test tool execution
      const testResult = await testTool(tool, args);

      // Log test execution
      const logQuery = `
        INSERT INTO tool_executions (
          empresa_id,
          tool_id,
          agente_id,
          conversation_id,
          parametros_json,
          resposta_json,
          sucesso,
          tempo_processamento_ms
        ) VALUES ($1, $2, NULL, NULL, $3, $4, $5, $6)
      `;

      pool.query(logQuery, [
        empresa_id,
        id,
        args,
        testResult.test_result,
        testResult.success,
        testResult.test_result?.duration_ms || 0
      ]).catch(err => {
        createLogger.error('Failed to log tool test', {
          error: err.message
        });
      });

      createLogger.info('Tool tested', {
        empresa_id,
        tool_id: id,
        tool_name: tool.nome,
        success: testResult.success
      });

      return {
        success: true,
        data: testResult
      };

    } catch (error) {
      createLogger.error('Failed to test tool', {
        empresa_id,
        tool_id: id,
        error: error.message
      });
      throw error;
    }
  });

  /**
   * GET /api/tools/templates
   * Get tool templates
   */
  fastify.get('/templates', {
    preHandler: fastify.authenticate
  }, async (request, reply) => {
    // Return common tool templates
    const templates = [
      {
        name: 'weather_api',
        template: {
          nome: 'buscar_clima',
          descricao: 'Busca informações climáticas de uma cidade',
          descricao_para_llm: 'Busca informações sobre o clima atual e previsão do tempo para uma cidade específica. Retorna temperatura, condições e previsão.',
          url: 'https://api.weatherapi.com/v1/current.json',
          metodo: 'GET',
          headers_json: {
            'Accept': 'application/json'
          },
          parametros_schema_json: {
            type: 'object',
            properties: {
              q: {
                type: 'string',
                description: 'Nome da cidade para buscar o clima'
              },
              lang: {
                type: 'string',
                description: 'Idioma da resposta (pt para português)',
                default: 'pt'
              }
            },
            required: ['q']
          },
          timeout_ms: 5000
        }
      },
      {
        name: 'search_api',
        template: {
          nome: 'pesquisar_web',
          descricao: 'Realiza pesquisas na web',
          descricao_para_llm: 'Pesquisa informações na web sobre qualquer tópico. Use para obter informações atualizadas ou quando precisar de dados externos.',
          url: 'https://api.search.com/search',
          metodo: 'POST',
          headers_json: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer {{api_key}}'
          },
          body_template_json: {
            query: '{{query}}',
            limit: 5
          },
          parametros_schema_json: {
            type: 'object',
            properties: {
              query: {
                type: 'string',
                description: 'Termo de pesquisa'
              }
            },
            required: ['query']
          },
          timeout_ms: 10000
        }
      },
      {
        name: 'crm_api',
        template: {
          nome: 'buscar_cliente_crm',
          descricao: 'Busca dados de clientes no CRM',
          descricao_para_llm: 'Busca informações de clientes no sistema CRM da empresa. Pode buscar por nome, email ou ID.',
          url: 'https://api.company.com/v1/customers/search',
          metodo: 'POST',
          headers_json: {
            'Content-Type': 'application/json',
            'X-API-Key': '{{api_key}}'
          },
          body_template_json: {
            filters: {
              search: '{{search_term}}'
            }
          },
          parametros_schema_json: {
            type: 'object',
            properties: {
              search_term: {
                type: 'string',
                description: 'Nome, email ou ID do cliente'
              }
            },
            required: ['search_term']
          },
          timeout_ms: 8000
        }
      }
    ];

    return {
      success: true,
      data: {
        templates
      }
    };
  });
};

export default toolsRoutes;