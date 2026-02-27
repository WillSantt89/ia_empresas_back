import { logger } from '../config/logger.js';
import { pool } from '../config/database.js';
import { checkPermission } from '../middleware/permission.js';
import { ALL_MODELS, AI_PROVIDERS, PROVIDER_MODELS, DEFAULT_LIMITS } from '../config/constants.js';
import { processMessageWithTools } from '../services/gemini.js';
import { executeTool, buildToolDeclarations, transformResultForLLM } from '../services/tool-runner.js';
import { getHistory, addToHistory, formatHistoryForGemini, clearHistory } from '../services/memory.js';
import { decrypt } from '../config/encryption.js';
import { getActiveKeysForAgent, recordKeySuccess, recordKeyError } from '../services/api-key-manager.js';

/**
 * Agentes Routes
 * AI Agent configuration and management
 */

const createLogger = logger.child({ module: 'agentes-routes' });

const agentesRoutes = async (fastify) => {
  // Agent schema
  const agentSchema = {
    type: 'object',
    properties: {
      nome: { type: 'string', minLength: 2, maxLength: 255 },
      descricao: { type: 'string', maxLength: 1000 },
      provider: { type: 'string', enum: Object.values(AI_PROVIDERS), default: 'google' },
      modelo: {
        type: 'string',
        enum: ALL_MODELS
      },
      prompt_ativo: { type: 'string', minLength: 10, maxLength: 10000 },
      temperatura: { type: 'number', minimum: 0, maximum: 2, default: DEFAULT_LIMITS.TEMPERATURE },
      max_tokens: { type: 'integer', minimum: 100, maximum: 8192, default: DEFAULT_LIMITS.MAX_TOKENS },
      config_json: { type: 'object' },
      ativo: { type: 'boolean' }
    }
  };

  /**
   * GET /api/agentes
   * List all agents
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
          ativo: { type: 'boolean' }
        }
      }
    }
  }, async (request, reply) => {
    const { empresa_id } = request.user;
    const { page, limit, search, ativo } = request.query;
    const offset = (page - 1) * limit;

    try {
      let query = `
        SELECT
          a.id,
          a.nome,
          a.descricao,
          a.modelo,
          a.temperatura,
          a.max_tokens,
          a.ativo,
          a.criado_em,
          a.atualizado_em,
          (
            SELECT COUNT(*)
            FROM agente_tools at2
            WHERE at2.agente_id = a.id
          ) as tool_count,
          (
            SELECT COUNT(*)
            FROM api_keys ak
            WHERE ak.agente_id = a.id AND ak.empresa_id = $1 AND ak.status = 'ativa'
          ) as active_keys,
          (
            SELECT json_build_object(
              'total_messages', COUNT(*),
              'total_tokens', COALESCE(SUM(tokens_input + tokens_output), 0),
              'avg_response_time', COALESCE(AVG(tempo_processamento_ms), 0),
              'success_rate', CASE
                WHEN COUNT(*) = 0 THEN 0
                ELSE (COUNT(*) FILTER (WHERE sucesso = true))::float / COUNT(*) * 100
              END
            )
            FROM conversacao_analytics ca
            WHERE ca.agente_id = a.id
              AND ca.empresa_id = $1
              AND ca.criado_em >= CURRENT_DATE - INTERVAL '30 days'
          ) as stats
        FROM agentes a
        WHERE a.empresa_id = $1
      `;

      const params = [empresa_id];
      let paramIndex = 2;

      // Add filters
      if (search) {
        query += ` AND (a.nome ILIKE $${paramIndex} OR a.descricao ILIKE $${paramIndex})`;
        params.push(`%${search}%`);
        paramIndex++;
      }

      if (ativo !== undefined) {
        query += ` AND a.ativo = $${paramIndex}`;
        params.push(ativo);
        paramIndex++;
      }

      // Get total count
      const countQuery = query.replace(
        /SELECT[\s\S]*FROM agentes a/,
        'SELECT COUNT(*) as total FROM agentes a'
      );

      const countResult = await pool.query(countQuery, params);
      const total = parseInt(countResult.rows[0].total) || 0;

      // Add pagination
      query += ` ORDER BY a.criado_em DESC LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
      params.push(limit, offset);

      const result = await pool.query(query, params);

      return {
        success: true,
        data: {
          agents: result.rows.map(agent => ({
            ...agent,
            stats: agent.stats || {
              total_messages: 0,
              total_tokens: 0,
              avg_response_time: 0,
              success_rate: 0
            }
          })),
          pagination: {
            page,
            limit,
            total,
            pages: Math.ceil(total / limit)
          }
        }
      };

    } catch (error) {
      createLogger.error('Failed to list agents', {
        empresa_id,
        error: error.message
      });
      throw error;
    }
  });

  /**
   * POST /api/agentes
   * Create new agent
   */
  fastify.post('/', {
    preHandler: [fastify.authenticate, checkPermission(['master', 'admin'])],
    schema: {
      body: {
        type: 'object',
        properties: agentSchema.properties,
        required: ['nome', 'modelo', 'prompt_ativo']
      }
    }
  }, async (request, reply) => {
    const { empresa_id } = request.user;
    const agentData = request.body;

    try {
      // Check agent limit
      const limitQuery = `
        SELECT
          el.max_agentes,
          (SELECT COUNT(*) FROM agentes WHERE empresa_id = $1 AND ativo = true) as current_agents
        FROM empresa_limits el
        WHERE el.empresa_id = $1
      `;

      const limitResult = await pool.query(limitQuery, [empresa_id]);

      if (limitResult.rows.length > 0) {
        const { max_agentes, current_agents } = limitResult.rows[0];
        if (current_agents >= max_agentes) {
          return reply.code(403).send({
            success: false,
            error: {
              code: 'LIMIT_EXCEEDED',
              message: `Agent limit reached (${max_agentes} agents)`
            }
          });
        }
      }

      // Create agent
      const query = `
        INSERT INTO agentes (
          empresa_id,
          nome,
          descricao,
          provider,
          modelo,
          prompt_ativo,
          temperatura,
          max_tokens,
          config_json,
          ativo
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        RETURNING *
      `;

      const result = await pool.query(query,
        [
          empresa_id,
          agentData.nome,
          agentData.descricao || null,
          agentData.provider || 'google',
          agentData.modelo,
          agentData.prompt_ativo,
          agentData.temperatura || DEFAULT_LIMITS.TEMPERATURE,
          agentData.max_tokens || DEFAULT_LIMITS.MAX_TOKENS,
          agentData.config_json || {},
          agentData.ativo !== false
        ]
      );

      const agent = result.rows[0];

      // Add default system prompt to history format
      const defaultPrompt = `
        Você é ${agent.nome}. ${agent.descricao || ''}

        ${agent.prompt_ativo}

        Diretrizes:
        - Responda sempre em português brasileiro
        - Seja claro e objetivo nas respostas
        - Use as ferramentas disponíveis quando necessário
        - Mantenha o contexto da conversa
      `.trim();

      // Update with formatted prompt
      await pool.query('UPDATE agentes SET prompt_ativo = $2 WHERE id = $1',
        [agent.id, defaultPrompt]
      );

      createLogger.info('Agent created', {
        empresa_id,
        agent_id: agent.id,
        model: agent.modelo
      });

      return {
        success: true,
        data: {
          agent: {
            ...agent,
            prompt_ativo: defaultPrompt
          }
        }
      };

    } catch (error) {
      createLogger.error('Failed to create agent', {
        empresa_id,
        error: error.message
      });
      throw error;
    }
  });

  /**
   * GET /api/agentes/:id
   * Get agent details
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
          a.*,
          (
            SELECT json_agg(json_build_object(
              'id', t.id,
              'nome', t.nome,
              'descricao', t.descricao,
              'prioridade', at2.ordem_prioridade
            ) ORDER BY at2.ordem_prioridade)
            FROM tools t
            INNER JOIN agente_tools at2 ON t.id = at2.tool_id
            WHERE at2.agente_id = a.id
          ) as tools,
          (
            SELECT json_agg(json_build_object(
              'id', ak.id,
              'nome', ak.nome_exibicao,
              'criado_em', ak.criado_em,
              'ultimo_uso', ak.ultimo_uso,
              'status', ak.status
            ))
            FROM api_keys ak
            WHERE ak.agente_id = a.id AND ak.empresa_id = $1
          ) as api_keys,
          (
            SELECT json_build_object(
              'total_conversations', COUNT(DISTINCT conversation_id),
              'total_messages', COUNT(*),
              'total_tokens', COALESCE(SUM(tokens_input + tokens_output), 0),
              'total_tool_calls', COALESCE(SUM(tools_chamadas), 0),
              'avg_response_time', COALESCE(AVG(tempo_processamento_ms), 0),
              'success_rate', CASE
                WHEN COUNT(*) = 0 THEN 0
                ELSE (COUNT(*) FILTER (WHERE sucesso = true))::float / COUNT(*) * 100
              END,
              'last_used', MAX(criado_em)
            )
            FROM conversacao_analytics ca
            WHERE ca.agente_id = a.id AND ca.empresa_id = $1
          ) as lifetime_stats
        FROM agentes a
        WHERE a.empresa_id = $1 AND a.id = $2
      `;

      const result = await pool.query(query, [empresa_id, id]);

      if (result.rows.length === 0) {
        return reply.code(404).send({
          success: false,
          error: {
            code: 'AGENT_NOT_FOUND',
            message: 'Agent not found'
          }
        });
      }

      return {
        success: true,
        data: {
          agent: result.rows[0]
        }
      };

    } catch (error) {
      createLogger.error('Failed to get agent', {
        empresa_id,
        agent_id: id,
        error: error.message
      });
      throw error;
    }
  });

  /**
   * PUT /api/agentes/:id
   * Update agent
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
      body: agentSchema
    }
  }, async (request, reply) => {
    const { empresa_id } = request.user;
    const { id } = request.params;
    const updates = request.body;

    try {
      const fields = [];
      const values = [];
      let index = 1;

      // Build update query
      Object.entries(updates).forEach(([key, value]) => {
        if (value !== undefined && key !== 'id' && key !== 'empresa_id') {
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
        UPDATE agentes
        SET ${fields.join(', ')}, atualizado_em = CURRENT_TIMESTAMP
        WHERE empresa_id = $${index} AND id = $${index + 1}
        RETURNING *
      `;

      const result = await pool.query(query, values);

      if (result.rows.length === 0) {
        return reply.code(404).send({
          success: false,
          error: {
            code: 'AGENT_NOT_FOUND',
            message: 'Agent not found'
          }
        });
      }

      createLogger.info('Agent updated', {
        empresa_id,
        agent_id: id,
        updated_fields: Object.keys(updates)
      });

      return {
        success: true,
        data: {
          agent: result.rows[0]
        }
      };

    } catch (error) {
      createLogger.error('Failed to update agent', {
        empresa_id,
        agent_id: id,
        error: error.message
      });
      throw error;
    }
  });

  /**
   * DELETE /api/agentes/:id
   * Deactivate agent
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

      // Deactivate agent
      const agentQuery = `
        UPDATE agentes
        SET ativo = false, atualizado_em = CURRENT_TIMESTAMP
        WHERE empresa_id = $1 AND id = $2
        RETURNING id, nome
      `;

      const agentResult = await client.query(agentQuery,
        [empresa_id, id]
      );

      if (agentResult.rows.length === 0) {
        await client.query('ROLLBACK');
        return reply.code(404).send({
          success: false,
          error: {
            code: 'AGENT_NOT_FOUND',
            message: 'Agent not found'
          }
        });
      }

      // Revoke all API keys for this agent
      await client.query(`UPDATE api_keys
         SET status = 'revogado', atualizado_em = CURRENT_TIMESTAMP
         WHERE empresa_id = $1 AND agente_id = $2`,
        [empresa_id, id]
      );

      await client.query('COMMIT');

      createLogger.info('Agent deactivated', {
        empresa_id,
        agent_id: id
      });

      return {
        success: true,
        data: {
          message: 'Agent deactivated successfully',
          agent: agentResult.rows[0]
        }
      };

    } catch (error) {
      await client.query('ROLLBACK');
      createLogger.error('Failed to deactivate agent', {
        empresa_id,
        agent_id: id,
        error: error.message
      });
      throw error;
    } finally {
      client.release();
    }
  });

  /**
   * POST /api/agentes/:id/tools
   * Assign tools to agent
   */
  fastify.post('/:id/tools', {
    preHandler: [fastify.authenticate, checkPermission(['master', 'admin'])],
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
          tool_ids: {
            type: 'array',
            items: { type: 'string', format: 'uuid' }
          }
        },
        required: ['tool_ids']
      }
    }
  }, async (request, reply) => {
    const { empresa_id } = request.user;
    const { id } = request.params;
    const { tool_ids } = request.body;

    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      // Verify agent exists
      const agentCheck = await client.query('SELECT id FROM agentes WHERE empresa_id = $1 AND id = $2',
        [empresa_id, id]
      );

      if (agentCheck.rows.length === 0) {
        await client.query('ROLLBACK');
        return reply.code(404).send({
          success: false,
          error: {
            code: 'AGENT_NOT_FOUND',
            message: 'Agent not found'
          }
        });
      }

      // Remove existing tools
      await client.query('DELETE FROM agente_tools WHERE agente_id = $1',
        [id]
      );

      // Add new tools
      if (tool_ids.length > 0) {
        const values = [];
        const placeholders = [];

        tool_ids.forEach((toolId, index) => {
          const baseIndex = index * 3;
          placeholders.push(`($${baseIndex + 1}, $${baseIndex + 2}, $${baseIndex + 3})`);
          values.push(id, toolId, index + 1);
        });

        const insertQuery = `
          INSERT INTO agente_tools (agente_id, tool_id, ordem_prioridade)
          VALUES ${placeholders.join(', ')}
        `;

        await client.query(insertQuery, values);
      }

      await client.query('COMMIT');

      // Get updated tools list
      const toolsQuery = `
        SELECT
          t.id,
          t.nome,
          t.descricao,
          at2.ordem_prioridade as prioridade
        FROM tools t
        INNER JOIN agente_tools at2 ON t.id = at2.tool_id
        WHERE at2.agente_id = $1
        ORDER BY at2.ordem_prioridade
      `;

      const toolsResult = await pool.query(toolsQuery, [id]);

      createLogger.info('Agent tools updated', {
        empresa_id,
        agent_id: id,
        tool_count: tool_ids.length
      });

      return {
        success: true,
        data: {
          agent_id: id,
          tools: toolsResult.rows
        }
      };

    } catch (error) {
      await client.query('ROLLBACK');
      createLogger.error('Failed to update agent tools', {
        empresa_id,
        agent_id: id,
        error: error.message
      });
      throw error;
    } finally {
      client.release();
    }
  });

  /**
   * POST /api/agentes/:id/test
   * Test agent with real Gemini API call
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
          message: { type: 'string', minLength: 1, maxLength: 2000 }
        },
        required: ['message']
      }
    }
  }, async (request, reply) => {
    const { empresa_id, id: userId } = request.user;
    const { id } = request.params;
    const { message } = request.body;

    try {
      // 1. Get agent config
      const agentQuery = `
        SELECT a.nome, a.modelo, a.prompt_ativo, a.temperatura, a.max_tokens
        FROM agentes a
        WHERE a.empresa_id = $1 AND a.id = $2 AND a.ativo = true
      `;
      const agentResult = await pool.query(agentQuery, [empresa_id, id]);

      if (agentResult.rows.length === 0) {
        return reply.code(404).send({
          success: false,
          error: { code: 'AGENT_NOT_FOUND', message: 'Agente ativo nao encontrado' }
        });
      }

      const agent = agentResult.rows[0];

      // 2. Get active API keys with failover support
      const availableKeys = await getActiveKeysForAgent(empresa_id, id);

      if (!availableKeys || availableKeys.length === 0) {
        return reply.code(400).send({
          success: false,
          error: {
            code: 'NO_API_KEY',
            message: 'Nenhuma API key ativa configurada para este agente. Va em API Keys e adicione uma chave Gemini.'
          }
        });
      }

      // 3. Load agent tools
      const toolsQuery = `
        SELECT t.id, t.nome, t.descricao_para_llm, t.url, t.metodo,
               t.headers_json, t.body_template_json, t.parametros_schema_json, t.timeout_ms
        FROM tools t
        INNER JOIN agente_tools at2 ON t.id = at2.tool_id
        WHERE at2.agente_id = $1 AND t.ativo = true
        ORDER BY at2.ordem_prioridade ASC
      `;
      const toolsResult = await pool.query(toolsQuery, [id]);
      const tools = toolsResult.rows;

      // 4. Test conversation history (isolated from real conversations)
      const testConversationId = `test:${id}:${userId}`;
      const history = await getHistory(empresa_id, testConversationId);
      await addToHistory(empresa_id, testConversationId, 'user', message);

      // 5. Build tool declarations and executor
      const toolDeclarations = tools.length > 0 ? buildToolDeclarations(tools) : [];

      const toolExecutor = async (tool, args) => {
        const toolConfig = tools.find(t => t.nome === tool.nome);
        if (!toolConfig) throw new Error(`Tool ${tool.nome} nao encontrada`);
        const result = await executeTool(toolConfig, args);
        return transformResultForLLM(result, 2000);
      };

      // 6. Call Gemini with failover
      let result;
      for (let keyIndex = 0; keyIndex < availableKeys.length; keyIndex++) {
        const currentKey = availableKeys[keyIndex];
        try {
          result = await processMessageWithTools(
            {
              apiKey: currentKey.gemini_api_key,
              model: agent.modelo,
              systemPrompt: agent.prompt_ativo,
              tools: toolDeclarations,
              history: formatHistoryForGemini(history),
              message,
              temperature: parseFloat(agent.temperatura) || DEFAULT_LIMITS.TEMPERATURE,
              maxTokens: agent.max_tokens || DEFAULT_LIMITS.MAX_TOKENS
            },
            toolExecutor
          );
          if (currentKey.id) recordKeySuccess(currentKey.id).catch(() => {});
          break;
        } catch (error) {
          if (currentKey.id) recordKeyError(currentKey.id, error.message).catch(() => {});
          if (keyIndex >= availableKeys.length - 1) throw error;
          createLogger.warn('Test: API key failed, trying next', {
            key_index: keyIndex, error: error.message
          });
        }
      }

      // 7. Save response to test history
      await addToHistory(empresa_id, testConversationId, 'model', result.text);

      return {
        success: true,
        data: {
          response: result.text,
          tools_called: result.toolsCalled.map(tc => ({
            name: tc.name,
            args: tc.args
          })),
          tokens_used: {
            input: result.tokensInput,
            output: result.tokensOutput
          }
        }
      };

    } catch (error) {
      createLogger.error('Failed to test agent', {
        empresa_id, agent_id: id, error: error.message, stack: error.stack
      });
      return reply.code(500).send({
        success: false,
        error: {
          code: 'TEST_FAILED',
          message: error.message || 'Erro ao testar agente',
          detail: String(error)
        }
      });
    }
  });

  /**
   * DELETE /api/agentes/:id/test
   * Clear test conversation history
   */
  fastify.delete('/:id/test', {
    preHandler: [fastify.authenticate],
    schema: {
      params: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' }
        }
      }
    }
  }, async (request, reply) => {
    const { empresa_id, id: userId } = request.user;
    const { id } = request.params;
    const testConversationId = `test:${id}:${userId}`;

    await clearHistory(empresa_id, testConversationId);

    return {
      success: true,
      data: { message: 'Historico de teste limpo' }
    };
  });

  /**
   * GET /api/agentes/providers
   * List available AI providers and their models
   */
  fastify.get('/providers', {
    preHandler: fastify.authenticate
  }, async (request, reply) => {
    return {
      success: true,
      data: {
        providers: Object.entries(PROVIDER_MODELS).map(([key, models]) => ({
          id: key,
          nome: key === 'google' ? 'Google AI' : key === 'claude' ? 'Anthropic Claude' : key === 'grok' ? 'xAI Grok' : key,
          disponivel: key === 'google',
          modelos: models,
        })),
      }
    };
  });
};

export default agentesRoutes;