import { logger } from '../config/logger.js';
import {
  createApiKey,
  listApiKeys,
  revokeApiKey,
  rotateApiKey,
  updateGeminiKey,
  updateApiKeyInfo,
  getApiKeyStats
} from '../services/api-key-manager.js';
import { checkPermission } from '../middleware/permission.js';

/**
 * API Keys Routes
 * Manage API keys for agents
 */

const createLogger = logger.child({ module: 'api-keys-routes' });

const apiKeysRoutes = async (fastify) => {
  /**
   * GET /api/api-keys
   * List all API keys
   */
  fastify.get('/', {
    preHandler: [fastify.authenticate],
    schema: {
      querystring: {
        type: 'object',
        properties: {
          agente_id: { type: 'string', format: 'uuid' }
        }
      }
    }
  }, async (request, reply) => {
    const { empresa_id } = request.user;
    const { agente_id } = request.query;

    try {
      const keys = await listApiKeys(empresa_id, agente_id);

      return {
        success: true,
        data: {
          keys
        }
      };

    } catch (error) {
      createLogger.error('Failed to list API keys', {
        empresa_id,
        error: error.message
      });
      throw error;
    }
  });

  /**
   * POST /api/api-keys
   * Create new API key
   */
  fastify.post('/', {
    preHandler: [fastify.authenticate, checkPermission(['master', 'admin'])],
    schema: {
      body: {
        type: 'object',
        properties: {
          agente_id: { type: 'string', format: 'uuid' },
          nome: { type: 'string', minLength: 2, maxLength: 100 },
          gemini_api_key: { type: 'string', minLength: 20 },
          expires_at: { type: 'string', format: 'date-time' }
        },
        required: ['agente_id', 'nome', 'gemini_api_key']
      }
    }
  }, async (request, reply) => {
    const { empresa_id, id: userId } = request.user;
    const { agente_id, nome, gemini_api_key } = request.body;

    try {
      const apiKey = await createApiKey({
        empresaId: empresa_id,
        agenteId: agente_id,
        geminiApiKey: gemini_api_key,
        nome,
        createdBy: userId
      });

      createLogger.info('API key created', {
        empresa_id,
        agente_id,
        key_id: apiKey.id
      });

      return {
        success: true,
        data: {
          key: apiKey
        }
      };

    } catch (error) {
      createLogger.error('Failed to create API key', {
        empresa_id,
        agente_id,
        error: error.message
      });
      throw error;
    }
  });

  /**
   * PUT /api/api-keys/:id
   * Update API key info (name, priority, gemini key)
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
      body: {
        type: 'object',
        properties: {
          nome: { type: 'string', minLength: 2, maxLength: 100 },
          prioridade: { type: 'integer', minimum: 1, maximum: 100 },
          gemini_api_key: { type: 'string', minLength: 20 },
          status: { type: 'string', enum: ['ativa', 'standby', 'desativada'] }
        }
      }
    }
  }, async (request, reply) => {
    const { empresa_id } = request.user;
    const { id } = request.params;
    const updates = request.body;

    try {
      const updated = await updateApiKeyInfo(empresa_id, id, updates);

      if (!updated) {
        return reply.code(404).send({
          success: false,
          error: {
            code: 'KEY_NOT_FOUND',
            message: 'API key not found'
          }
        });
      }

      return {
        success: true,
        data: {
          key: updated
        }
      };

    } catch (error) {
      createLogger.error('Failed to update API key', {
        empresa_id,
        key_id: id,
        error: error.message
      });
      throw error;
    }
  });

  /**
   * DELETE /api/api-keys/:id
   * Revoke API key
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
    const { empresa_id, id: userId } = request.user;
    const { id } = request.params;

    try {
      const revoked = await revokeApiKey(empresa_id, id, userId);

      if (!revoked) {
        return reply.code(404).send({
          success: false,
          error: {
            code: 'KEY_NOT_FOUND',
            message: 'API key not found or already revoked'
          }
        });
      }

      return {
        success: true,
        data: {
          message: 'API key revoked successfully'
        }
      };

    } catch (error) {
      createLogger.error('Failed to revoke API key', {
        empresa_id,
        key_id: id,
        error: error.message
      });
      throw error;
    }
  });

  /**
   * POST /api/api-keys/:id/rotate
   * Rotate API key
   */
  fastify.post('/:id/rotate', {
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
          gemini_api_key: { type: 'string', minLength: 20 }
        },
        required: ['gemini_api_key']
      }
    }
  }, async (request, reply) => {
    const { empresa_id, id: userId } = request.user;
    const { id } = request.params;
    const { gemini_api_key } = request.body;

    try {
      const newKey = await rotateApiKey(empresa_id, id, gemini_api_key, userId);

      createLogger.info('API key rotated', {
        empresa_id,
        old_key_id: id,
        new_key_id: newKey.id
      });

      return {
        success: true,
        data: {
          key: newKey
        }
      };

    } catch (error) {
      createLogger.error('Failed to rotate API key', {
        empresa_id,
        key_id: id,
        error: error.message
      });
      throw error;
    }
  });

  /**
   * PUT /api/api-keys/:id/gemini-key
   * Update Gemini API key
   */
  fastify.put('/:id/gemini-key', {
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
          gemini_api_key: { type: 'string', minLength: 20 }
        },
        required: ['gemini_api_key']
      }
    }
  }, async (request, reply) => {
    const { empresa_id } = request.user;
    const { id } = request.params;
    const { gemini_api_key } = request.body;

    try {
      const updated = await updateGeminiKey(empresa_id, id, gemini_api_key);

      if (!updated) {
        return reply.code(404).send({
          success: false,
          error: {
            code: 'KEY_NOT_FOUND',
            message: 'API key not found or inactive'
          }
        });
      }

      return {
        success: true,
        data: {
          message: 'Gemini API key updated successfully'
        }
      };

    } catch (error) {
      createLogger.error('Failed to update Gemini key', {
        empresa_id,
        key_id: id,
        error: error.message
      });
      throw error;
    }
  });

  /**
   * GET /api/api-keys/stats
   * Get API key statistics
   */
  fastify.get('/stats', {
    preHandler: fastify.authenticate
  }, async (request, reply) => {
    const { empresa_id } = request.user;

    try {
      const stats = await getApiKeyStats(empresa_id);

      return {
        success: true,
        data: {
          stats
        }
      };

    } catch (error) {
      createLogger.error('Failed to get API key stats', {
        empresa_id,
        error: error.message
      });
      throw error;
    }
  });

  /**
   * POST /api/api-keys/validate-gemini
   * Validate Gemini API key
   */
  fastify.post('/validate-gemini', {
    preHandler: fastify.authenticate,
    schema: {
      body: {
        type: 'object',
        properties: {
          gemini_api_key: { type: 'string', minLength: 20 }
        },
        required: ['gemini_api_key']
      }
    }
  }, async (request, reply) => {
    const { gemini_api_key } = request.body;

    try {
      // Test the Gemini API key
      const { GoogleGenAI } = await import('@google/genai');
      const ai = new GoogleGenAI({ apiKey: gemini_api_key });

      // Simple test to validate the key
      try {
        await ai.models.generateContent({
          model: 'gemini-2.5-flash',
          contents: 'test',
        });
      } catch (error) {
        const status = error.status || error.httpStatusCode;
        if (status === 400 || status === 401 || status === 403 ||
            error.message?.includes('API key') || error.message?.includes('PERMISSION_DENIED')) {
          return {
            success: true,
            data: {
              valid: false,
              message: 'Invalid Gemini API key'
            }
          };
        }
        // Other errors might still mean the key is valid
      }

      return {
        success: true,
        data: {
          valid: true,
          message: 'Gemini API key is valid'
        }
      };

    } catch (error) {
      createLogger.error('Failed to validate Gemini key', {
        error: error.message
      });

      return {
        success: true,
        data: {
          valid: false,
          message: 'Failed to validate API key'
        }
      };
    }
  });
};

export default apiKeysRoutes;