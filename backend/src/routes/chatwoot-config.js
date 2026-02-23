import { logger } from '../config/logger.js';
import { pool, tenantQuery } from '../config/database.js';
import { checkPermission } from '../middleware/permission.js';
import { encrypt, decrypt } from '../utils/encryption.js';
import { getConversation, sendMessage } from '../services/chatwoot.js';

/**
 * Chatwoot Config Routes
 * Manage Chatwoot integration configurations
 */

const createLogger = logger.child({ module: 'chatwoot-config-routes' });

const chatwootConfigRoutes = async (fastify) => {
  // Chatwoot config schema
  const configSchema = {
    type: 'object',
    properties: {
      nome: { type: 'string', minLength: 2, maxLength: 100 },
      chatwoot_url: { type: 'string', format: 'uri' },
      chatwoot_account_id: { type: 'integer' },
      chatwoot_api_key: { type: 'string', minLength: 20 },
      agente_id: { type: 'string', format: 'uuid' },
      inbox_ids: {
        type: 'array',
        items: { type: 'integer' }
      },
      config_json: { type: 'object' },
      is_active: { type: 'boolean' }
    }
  };

  /**
   * GET /api/chatwoot-config
   * List all Chatwoot configurations
   */
  fastify.get('/', {
    preHandler: fastify.authenticate,
    schema: {
      querystring: {
        type: 'object',
        properties: {
          is_active: { type: 'boolean' }
        }
      }
    }
  }, async (request, reply) => {
    const { empresa_id } = request.user;
    const { is_active } = request.query;

    try {
      let query = `
        SELECT
          ce.id,
          ce.nome,
          ce.chatwoot_url,
          ce.chatwoot_account_id,
          ce.inbox_ids,
          ce.config_json,
          ce.is_active,
          ce.created_at,
          ce.updated_at,
          a.nome as agente_nome,
          ak.nome as api_key_nome,
          (
            SELECT COUNT(DISTINCT conversation_id)
            FROM conversacao_analytics ca
            WHERE ca.empresa_id = $1
              AND ca.agente_id = ce.agente_id
              AND ca.created_at >= CURRENT_DATE - INTERVAL '7 days'
          ) as conversations_last_week
        FROM chatwoot_empresas ce
        LEFT JOIN agentes a ON ce.agente_id = a.id
        LEFT JOIN api_keys ak ON ce.api_key_id = ak.id
        WHERE ce.empresa_id = $1
      `;

      const params = [empresa_id];

      if (is_active !== undefined) {
        query += ' AND ce.is_active = $2';
        params.push(is_active);
      }

      query += ' ORDER BY ce.created_at DESC';

      const result = await tenantQuery(pool, empresa_id, query, params);

      return {
        success: true,
        data: {
          configurations: result.rows.map(config => ({
            ...config,
            // Don't expose API key
            chatwoot_api_key: config.chatwoot_api_key ? '[HIDDEN]' : null
          }))
        }
      };

    } catch (error) {
      createLogger.error('Failed to list Chatwoot configs', {
        empresa_id,
        error: error.message
      });
      throw error;
    }
  });

  /**
   * POST /api/chatwoot-config
   * Create new Chatwoot configuration
   */
  fastify.post('/', {
    preHandler: [fastify.authenticate, checkPermission(['master', 'admin'])],
    schema: {
      body: {
        type: 'object',
        properties: configSchema.properties,
        required: ['nome', 'chatwoot_url', 'chatwoot_account_id', 'chatwoot_api_key', 'agente_id']
      }
    }
  }, async (request, reply) => {
    const { empresa_id } = request.user;
    const configData = request.body;

    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      // Check if account ID already exists
      const existingQuery = `
        SELECT id FROM chatwoot_empresas
        WHERE chatwoot_account_id = $1
      `;

      const existing = await client.query(existingQuery, [configData.chatwoot_account_id]);

      if (existing.rows.length > 0) {
        await client.query('ROLLBACK');
        return reply.code(409).send({
          success: false,
          error: {
            code: 'ACCOUNT_EXISTS',
            message: 'Chatwoot account already configured'
          }
        });
      }

      // Verify agent exists and get its API key
      const agentQuery = `
        SELECT
          a.id,
          ak.id as api_key_id
        FROM agentes a
        LEFT JOIN api_keys ak ON ak.agente_id = a.id
          AND ak.empresa_id = $1 AND ak.is_active = true
        WHERE a.empresa_id = $1 AND a.id = $2 AND a.is_active = true
        LIMIT 1
      `;

      const agentResult = await tenantQuery(
        client,
        empresa_id,
        agentQuery,
        [empresa_id, configData.agente_id]
      );

      if (agentResult.rows.length === 0) {
        await client.query('ROLLBACK');
        return reply.code(404).send({
          success: false,
          error: {
            code: 'AGENT_NOT_FOUND',
            message: 'Active agent not found'
          }
        });
      }

      if (!agentResult.rows[0].api_key_id) {
        await client.query('ROLLBACK');
        return reply.code(400).send({
          success: false,
          error: {
            code: 'NO_API_KEY',
            message: 'Agent must have an active API key'
          }
        });
      }

      // Encrypt Chatwoot API key
      const encryptedKey = encrypt(configData.chatwoot_api_key);

      // Create configuration
      const insertQuery = `
        INSERT INTO chatwoot_empresas (
          empresa_id,
          nome,
          chatwoot_url,
          chatwoot_account_id,
          chatwoot_api_key_encrypted,
          agente_id,
          api_key_id,
          inbox_ids,
          config_json,
          is_active
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        RETURNING id, nome, chatwoot_url, chatwoot_account_id, created_at
      `;

      const result = await tenantQuery(
        client,
        empresa_id,
        insertQuery,
        [
          empresa_id,
          configData.nome,
          configData.chatwoot_url.replace(/\/$/, ''), // Remove trailing slash
          configData.chatwoot_account_id,
          encryptedKey,
          configData.agente_id,
          agentResult.rows[0].api_key_id,
          configData.inbox_ids || [],
          configData.config_json || {},
          configData.is_active !== false
        ]
      );

      await client.query('COMMIT');

      const config = result.rows[0];

      createLogger.info('Chatwoot config created', {
        empresa_id,
        config_id: config.id,
        account_id: config.chatwoot_account_id
      });

      return {
        success: true,
        data: {
          configuration: config
        }
      };

    } catch (error) {
      await client.query('ROLLBACK');
      createLogger.error('Failed to create Chatwoot config', {
        empresa_id,
        error: error.message
      });
      throw error;
    } finally {
      client.release();
    }
  });

  /**
   * GET /api/chatwoot-config/:id
   * Get configuration details
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
          ce.*,
          a.nome as agente_nome,
          a.modelo as agente_modelo,
          ak.nome as api_key_nome,
          (
            SELECT json_build_object(
              'total_conversations', COUNT(DISTINCT conversation_id),
              'total_messages', COUNT(*),
              'total_tokens', COALESCE(SUM(tokens_input + tokens_output), 0),
              'avg_response_time', COALESCE(AVG(tempo_processamento_ms), 0),
              'last_activity', MAX(created_at)
            )
            FROM conversacao_analytics ca
            WHERE ca.empresa_id = $1
              AND ca.agente_id = ce.agente_id
          ) as stats
        FROM chatwoot_empresas ce
        LEFT JOIN agentes a ON ce.agente_id = a.id
        LEFT JOIN api_keys ak ON ce.api_key_id = ak.id
        WHERE ce.empresa_id = $1 AND ce.id = $2
      `;

      const result = await tenantQuery(pool, empresa_id, query, [empresa_id, id]);

      if (result.rows.length === 0) {
        return reply.code(404).send({
          success: false,
          error: {
            code: 'CONFIG_NOT_FOUND',
            message: 'Configuration not found'
          }
        });
      }

      const config = result.rows[0];

      // Don't expose encrypted API key
      delete config.chatwoot_api_key_encrypted;

      return {
        success: true,
        data: {
          configuration: {
            ...config,
            chatwoot_api_key: config.chatwoot_api_key_encrypted ? '[HIDDEN]' : null
          }
        }
      };

    } catch (error) {
      createLogger.error('Failed to get Chatwoot config', {
        empresa_id,
        config_id: id,
        error: error.message
      });
      throw error;
    }
  });

  /**
   * PUT /api/chatwoot-config/:id
   * Update configuration
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
      body: configSchema
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
          if (key === 'chatwoot_api_key') {
            fields.push(`chatwoot_api_key_encrypted = $${index}`);
            values.push(encrypt(value));
          } else if (key === 'chatwoot_url') {
            fields.push(`${key} = $${index}`);
            values.push(value.replace(/\/$/, '')); // Remove trailing slash
          } else {
            fields.push(`${key} = $${index}`);
            values.push(value);
          }
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

      // If updating agent, verify it has API key
      if (updates.agente_id) {
        const agentQuery = `
          SELECT ak.id as api_key_id
          FROM agentes a
          LEFT JOIN api_keys ak ON ak.agente_id = a.id
            AND ak.empresa_id = $1 AND ak.is_active = true
          WHERE a.empresa_id = $1 AND a.id = $2 AND a.is_active = true
        `;

        const agentResult = await tenantQuery(
          pool,
          empresa_id,
          agentQuery,
          [empresa_id, updates.agente_id]
        );

        if (agentResult.rows.length === 0 || !agentResult.rows[0].api_key_id) {
          return reply.code(400).send({
            success: false,
            error: {
              code: 'INVALID_AGENT',
              message: 'Agent not found or has no active API key'
            }
          });
        }

        fields.push(`api_key_id = $${index}`);
        values.push(agentResult.rows[0].api_key_id);
        index++;
      }

      values.push(empresa_id, id);
      const query = `
        UPDATE chatwoot_empresas
        SET ${fields.join(', ')}, updated_at = CURRENT_TIMESTAMP
        WHERE empresa_id = $${index} AND id = $${index + 1}
        RETURNING id, nome, chatwoot_url, chatwoot_account_id, updated_at
      `;

      const result = await tenantQuery(pool, empresa_id, query, values);

      if (result.rows.length === 0) {
        return reply.code(404).send({
          success: false,
          error: {
            code: 'CONFIG_NOT_FOUND',
            message: 'Configuration not found'
          }
        });
      }

      createLogger.info('Chatwoot config updated', {
        empresa_id,
        config_id: id,
        updated_fields: Object.keys(updates)
      });

      return {
        success: true,
        data: {
          configuration: result.rows[0]
        }
      };

    } catch (error) {
      createLogger.error('Failed to update Chatwoot config', {
        empresa_id,
        config_id: id,
        error: error.message
      });
      throw error;
    }
  });

  /**
   * DELETE /api/chatwoot-config/:id
   * Delete configuration
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

    try {
      const query = `
        DELETE FROM chatwoot_empresas
        WHERE empresa_id = $1 AND id = $2
        RETURNING id, nome, chatwoot_account_id
      `;

      const result = await tenantQuery(pool, empresa_id, query, [empresa_id, id]);

      if (result.rows.length === 0) {
        return reply.code(404).send({
          success: false,
          error: {
            code: 'CONFIG_NOT_FOUND',
            message: 'Configuration not found'
          }
        });
      }

      createLogger.info('Chatwoot config deleted', {
        empresa_id,
        config_id: id,
        account_id: result.rows[0].chatwoot_account_id
      });

      return {
        success: true,
        data: {
          message: 'Configuration deleted successfully',
          configuration: result.rows[0]
        }
      };

    } catch (error) {
      createLogger.error('Failed to delete Chatwoot config', {
        empresa_id,
        config_id: id,
        error: error.message
      });
      throw error;
    }
  });

  /**
   * POST /api/chatwoot-config/:id/test
   * Test Chatwoot connection
   */
  fastify.post('/:id/test', {
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
      // Get configuration
      const query = `
        SELECT
          chatwoot_url,
          chatwoot_account_id,
          chatwoot_api_key_encrypted
        FROM chatwoot_empresas
        WHERE empresa_id = $1 AND id = $2 AND is_active = true
      `;

      const result = await tenantQuery(pool, empresa_id, query, [empresa_id, id]);

      if (result.rows.length === 0) {
        return reply.code(404).send({
          success: false,
          error: {
            code: 'CONFIG_NOT_FOUND',
            message: 'Active configuration not found'
          }
        });
      }

      const config = result.rows[0];
      const apiKey = decrypt(config.chatwoot_api_key_encrypted);

      // Test by fetching a conversation (or account info)
      try {
        // Try to fetch account conversations
        const testUrl = `${config.chatwoot_url}/api/v1/accounts/${config.chatwoot_account_id}/conversations?limit=1`;

        const response = await fetch(testUrl, {
          headers: {
            'api_access_token': apiKey
          }
        });

        const data = await response.json();

        if (!response.ok) {
          return {
            success: true,
            data: {
              connected: false,
              error: data.error || `HTTP ${response.status}`
            }
          };
        }

        return {
          success: true,
          data: {
            connected: true,
            account_id: config.chatwoot_account_id,
            conversation_count: data.meta?.count || 0
          }
        };

      } catch (testError) {
        return {
          success: true,
          data: {
            connected: false,
            error: testError.message
          }
        };
      }

    } catch (error) {
      createLogger.error('Failed to test Chatwoot config', {
        empresa_id,
        config_id: id,
        error: error.message
      });
      throw error;
    }
  });
};

export default chatwootConfigRoutes;