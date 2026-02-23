import crypto from 'crypto';
import { pool, tenantQuery } from '../config/database.js';
import { logger } from '../config/logger.js';
import { encrypt, decrypt, hash } from '../utils/encryption.js';
import { redis, setWithExpiry, getJSON } from '../config/redis.js';

/**
 * API Key Manager Service
 * Handles creation, validation, and management of API keys for Gemini
 */

const createLogger = logger.child({ module: 'api-key-manager' });

// Cache keys
const API_KEY_CACHE_PREFIX = 'apikey:';
const API_KEY_CACHE_TTL = 300; // 5 minutes

/**
 * Generate a secure API key identifier
 * @returns {string} API key in format: sk_live_[random]
 */
function generateApiKey() {
  const prefix = 'sk_live_';
  const randomBytes = crypto.randomBytes(32).toString('base64url');
  return `${prefix}${randomBytes}`;
}

/**
 * Create a new API key for an agent
 * @param {Object} options - API key creation options
 * @param {string} options.empresaId - Company ID
 * @param {number} options.agenteId - Agent ID
 * @param {string} options.geminiApiKey - Gemini API key to encrypt
 * @param {string} options.nome - Key name/description
 * @param {number} options.createdBy - User ID who created the key
 * @returns {Promise<Object>} Created API key details
 */
export async function createApiKey(options) {
  const { empresaId, agenteId, geminiApiKey, nome, createdBy } = options;
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // Generate API key
    const apiKey = generateApiKey();
    const apiKeyHash = await hash(apiKey);

    // Encrypt the Gemini API key
    const encryptedGeminiKey = encrypt(geminiApiKey);

    // Store in database
    const query = `
      INSERT INTO api_keys (
        empresa_id,
        agente_id,
        nome,
        key_hash,
        gemini_key_encrypted,
        created_by,
        last_used_at
      ) VALUES ($1, $2, $3, $4, $5, $6, NULL)
      RETURNING
        id,
        nome,
        created_at,
        is_active
    `;

    const result = await tenantQuery(
      client,
      empresaId,
      query,
      [empresaId, agenteId, nome, apiKeyHash, encryptedGeminiKey, createdBy]
    );

    await client.query('COMMIT');

    const created = result.rows[0];

    createLogger.info('API key created', {
      empresa_id: empresaId,
      agente_id: agenteId,
      key_id: created.id,
      created_by: createdBy
    });

    // Return the key only once (won't be shown again)
    return {
      id: created.id,
      api_key: apiKey, // Only returned on creation
      nome: created.nome,
      created_at: created.created_at,
      is_active: created.is_active,
      message: 'Store this API key securely. It will not be shown again.'
    };

  } catch (error) {
    await client.query('ROLLBACK');
    createLogger.error('Failed to create API key', {
      empresa_id: empresaId,
      agente_id: agenteId,
      error: error.message
    });
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Validate API key and get associated Gemini key
 * @param {string} apiKey - API key to validate
 * @returns {Promise<Object|null>} Validated key data or null
 */
export async function validateApiKey(apiKey) {
  try {
    // Check cache first
    const cacheKey = `${API_KEY_CACHE_PREFIX}${apiKey}`;
    const cached = await getJSON(cacheKey);

    if (cached) {
      createLogger.debug('API key found in cache');
      return cached;
    }

    // Hash the provided key
    const apiKeyHash = await hash(apiKey);

    // Query database
    const query = `
      SELECT
        ak.id,
        ak.empresa_id,
        ak.agente_id,
        ak.gemini_key_encrypted,
        ak.is_active,
        ak.expires_at,
        a.nome as agente_nome,
        a.modelo,
        a.temperatura,
        a.max_tokens,
        a.prompt_ativo,
        e.is_active as empresa_active
      FROM api_keys ak
      INNER JOIN agentes a ON ak.agente_id = a.id
      INNER JOIN empresas e ON ak.empresa_id = e.id
      WHERE ak.key_hash = $1
        AND ak.is_active = true
        AND a.is_active = true
    `;

    const result = await pool.query(query, [apiKeyHash]);

    if (result.rows.length === 0) {
      createLogger.warn('Invalid API key attempt');
      return null;
    }

    const keyData = result.rows[0];

    // Check if company is active
    if (!keyData.empresa_active) {
      createLogger.warn('API key for inactive company', {
        empresa_id: keyData.empresa_id
      });
      return null;
    }

    // Check expiration
    if (keyData.expires_at && new Date(keyData.expires_at) < new Date()) {
      createLogger.warn('Expired API key', {
        key_id: keyData.id,
        expired_at: keyData.expires_at
      });
      return null;
    }

    // Decrypt Gemini key
    const geminiApiKey = decrypt(keyData.gemini_key_encrypted);

    // Update last used timestamp
    pool.query(
      'UPDATE api_keys SET last_used_at = CURRENT_TIMESTAMP WHERE id = $1',
      [keyData.id]
    ).catch(err => {
      createLogger.error('Failed to update last_used_at', {
        key_id: keyData.id,
        error: err.message
      });
    });

    const validatedData = {
      id: keyData.id,
      empresa_id: keyData.empresa_id,
      agente_id: keyData.agente_id,
      agente_nome: keyData.agente_nome,
      gemini_api_key: geminiApiKey,
      modelo: keyData.modelo,
      temperatura: keyData.temperatura,
      max_tokens: keyData.max_tokens,
      prompt_ativo: keyData.prompt_ativo
    };

    // Cache the validated data
    await setWithExpiry(cacheKey, validatedData, API_KEY_CACHE_TTL);

    createLogger.debug('API key validated', {
      key_id: keyData.id,
      empresa_id: keyData.empresa_id,
      agente_id: keyData.agente_id
    });

    return validatedData;

  } catch (error) {
    createLogger.error('API key validation error', {
      error: error.message
    });
    return null;
  }
}

/**
 * List API keys for a company
 * @param {string} empresaId - Company ID
 * @param {number} agenteId - Optional agent ID filter
 * @returns {Promise<Array>} List of API keys
 */
export async function listApiKeys(empresaId, agenteId = null) {
  try {
    let query = `
      SELECT
        ak.id,
        ak.nome,
        ak.agente_id,
        a.nome as agente_nome,
        ak.created_at,
        ak.last_used_at,
        ak.expires_at,
        ak.is_active,
        u.nome as created_by_nome
      FROM api_keys ak
      INNER JOIN agentes a ON ak.agente_id = a.id
      LEFT JOIN usuarios u ON ak.created_by = u.id
      WHERE ak.empresa_id = $1
    `;

    const params = [empresaId];

    if (agenteId) {
      query += ' AND ak.agente_id = $2';
      params.push(agenteId);
    }

    query += ' ORDER BY ak.created_at DESC';

    const result = await tenantQuery(pool, empresaId, query, params);

    return result.rows.map(key => ({
      id: key.id,
      nome: key.nome,
      agente: {
        id: key.agente_id,
        nome: key.agente_nome
      },
      created_at: key.created_at,
      created_by: key.created_by_nome,
      last_used_at: key.last_used_at,
      expires_at: key.expires_at,
      is_active: key.is_active
    }));

  } catch (error) {
    createLogger.error('Failed to list API keys', {
      empresa_id: empresaId,
      agente_id: agenteId,
      error: error.message
    });
    throw error;
  }
}

/**
 * Revoke an API key
 * @param {string} empresaId - Company ID
 * @param {string} keyId - API key ID
 * @param {number} revokedBy - User ID who revoked the key
 * @returns {Promise<boolean>} True if revoked
 */
export async function revokeApiKey(empresaId, keyId, revokedBy) {
  try {
    const query = `
      UPDATE api_keys
      SET
        is_active = false,
        revoked_at = CURRENT_TIMESTAMP,
        revoked_by = $3
      WHERE empresa_id = $1 AND id = $2 AND is_active = true
    `;

    const result = await tenantQuery(pool, empresaId, query, [empresaId, keyId, revokedBy]);

    if (result.rowCount === 0) {
      return false;
    }

    // Clear from cache
    // Note: We can't clear by API key value, but the cache will expire

    createLogger.info('API key revoked', {
      empresa_id: empresaId,
      key_id: keyId,
      revoked_by: revokedBy
    });

    return true;

  } catch (error) {
    createLogger.error('Failed to revoke API key', {
      empresa_id: empresaId,
      key_id: keyId,
      error: error.message
    });
    throw error;
  }
}

/**
 * Rotate an API key (create new, revoke old)
 * @param {string} empresaId - Company ID
 * @param {string} oldKeyId - Current API key ID
 * @param {string} geminiApiKey - New Gemini API key
 * @param {number} rotatedBy - User ID who rotated the key
 * @returns {Promise<Object>} New API key details
 */
export async function rotateApiKey(empresaId, oldKeyId, geminiApiKey, rotatedBy) {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // Get current key details
    const currentQuery = `
      SELECT agente_id, nome
      FROM api_keys
      WHERE empresa_id = $1 AND id = $2 AND is_active = true
    `;

    const currentResult = await tenantQuery(
      client,
      empresaId,
      currentQuery,
      [empresaId, oldKeyId]
    );

    if (currentResult.rows.length === 0) {
      throw new Error('API key not found or already revoked');
    }

    const { agente_id, nome } = currentResult.rows[0];

    // Create new key
    const newKey = await createApiKey({
      empresaId,
      agenteId: agente_id,
      geminiApiKey,
      nome: `${nome} (Rotated)`,
      createdBy: rotatedBy
    });

    // Revoke old key
    await revokeApiKey(empresaId, oldKeyId, rotatedBy);

    await client.query('COMMIT');

    createLogger.info('API key rotated', {
      empresa_id: empresaId,
      old_key_id: oldKeyId,
      new_key_id: newKey.id,
      rotated_by: rotatedBy
    });

    return newKey;

  } catch (error) {
    await client.query('ROLLBACK');
    createLogger.error('Failed to rotate API key', {
      empresa_id: empresaId,
      old_key_id: oldKeyId,
      error: error.message
    });
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Update Gemini API key for an existing key
 * @param {string} empresaId - Company ID
 * @param {string} keyId - API key ID
 * @param {string} newGeminiKey - New Gemini API key
 * @returns {Promise<boolean>} True if updated
 */
export async function updateGeminiKey(empresaId, keyId, newGeminiKey) {
  try {
    const encryptedKey = encrypt(newGeminiKey);

    const query = `
      UPDATE api_keys
      SET gemini_key_encrypted = $3
      WHERE empresa_id = $1 AND id = $2 AND is_active = true
    `;

    const result = await tenantQuery(
      pool,
      empresaId,
      query,
      [empresaId, keyId, encryptedKey]
    );

    if (result.rowCount === 0) {
      return false;
    }

    // Clear cache for this key (we don't have the actual key, but cache will expire)

    createLogger.info('Gemini key updated', {
      empresa_id: empresaId,
      key_id: keyId
    });

    return true;

  } catch (error) {
    createLogger.error('Failed to update Gemini key', {
      empresa_id: empresaId,
      key_id: keyId,
      error: error.message
    });
    throw error;
  }
}

/**
 * Clean up expired keys
 * @returns {Promise<number>} Number of keys cleaned
 */
export async function cleanupExpiredKeys() {
  try {
    const query = `
      UPDATE api_keys
      SET is_active = false
      WHERE expires_at < CURRENT_TIMESTAMP
        AND is_active = true
      RETURNING id
    `;

    const result = await pool.query(query);

    if (result.rowCount > 0) {
      createLogger.info('Expired keys cleaned up', {
        count: result.rowCount,
        key_ids: result.rows.map(r => r.id)
      });
    }

    return result.rowCount;

  } catch (error) {
    createLogger.error('Failed to cleanup expired keys', {
      error: error.message
    });
    return 0;
  }
}

/**
 * Get API key statistics for a company
 * @param {string} empresaId - Company ID
 * @returns {Promise<Object>} Statistics
 */
export async function getApiKeyStats(empresaId) {
  try {
    const query = `
      SELECT
        COUNT(*) FILTER (WHERE is_active = true) as active_count,
        COUNT(*) FILTER (WHERE is_active = false) as revoked_count,
        COUNT(*) FILTER (WHERE last_used_at > CURRENT_TIMESTAMP - INTERVAL '24 hours') as used_today,
        COUNT(*) FILTER (WHERE expires_at < CURRENT_TIMESTAMP AND is_active = true) as expired_count,
        MAX(created_at) as last_created_at,
        MAX(last_used_at) as last_used_at
      FROM api_keys
      WHERE empresa_id = $1
    `;

    const result = await tenantQuery(pool, empresaId, query, [empresaId]);

    return {
      active_keys: parseInt(result.rows[0].active_count) || 0,
      revoked_keys: parseInt(result.rows[0].revoked_count) || 0,
      used_today: parseInt(result.rows[0].used_today) || 0,
      expired_keys: parseInt(result.rows[0].expired_count) || 0,
      last_created: result.rows[0].last_created_at,
      last_used: result.rows[0].last_used_at
    };

  } catch (error) {
    createLogger.error('Failed to get API key stats', {
      empresa_id: empresaId,
      error: error.message
    });
    throw error;
  }
}