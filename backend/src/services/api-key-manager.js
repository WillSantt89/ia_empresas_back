import crypto from 'crypto';
import { pool } from '../config/database.js';
import { logger } from '../config/logger.js';
import { encrypt, decrypt, hash as sha256Hash } from '../config/encryption.js';
import { redis, setWithExpiry, getJSON } from '../config/redis.js';

/**
 * API Key Manager Service
 * Handles creation, validation, and management of API keys for Gemini
 *
 * DB schema for api_keys:
 *   id, empresa_id, provedor, nome_exibicao, api_key_encrypted, status,
 *   prioridade, total_requests_hoje, total_tokens_hoje, ultimo_uso,
 *   ultimo_erro, retry_apos, ultimo_erro_msg, tentativas_erro,
 *   criado_por, criado_em, atualizado_em, agente_id (legacy), todos_agentes
 *
 * api_key_agentes (tabela ponte N:N):
 *   api_key_id, agente_id
 */

const createLogger = logger.child({ module: 'api-key-manager' });

// Cache keys
const API_KEY_CACHE_PREFIX = 'apikey:';
const API_KEY_CACHE_TTL = 300; // 5 minutes

/**
 * Create a new API key for one or more agents (or all)
 * @param {Object} options
 * @param {string} options.empresaId
 * @param {string} [options.agenteId] - Legacy single agent (still supported)
 * @param {string[]} [options.agenteIds] - Multiple agents
 * @param {boolean} [options.todosAgentes] - Apply to all agents
 * @param {string} options.geminiApiKey
 * @param {string} options.nome
 * @param {string} options.createdBy
 */
export async function createApiKey(options) {
  const { empresaId, agenteId, agenteIds, todosAgentes, geminiApiKey, nome, createdBy } = options;
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // Encrypt the Gemini API key + store hash for fast lookup
    const encryptedKey = encrypt(geminiApiKey);
    const keyHash = sha256Hash(geminiApiKey);

    // Store in database
    const query = `
      INSERT INTO api_keys (
        empresa_id,
        agente_id,
        todos_agentes,
        provedor,
        nome_exibicao,
        api_key_encrypted,
        api_key_hash,
        status,
        prioridade,
        criado_por
      ) VALUES ($1, $2, $3, 'gemini', $4, $5, $6, 'ativa', 1, $7)
      RETURNING
        id,
        nome_exibicao,
        status,
        criado_em
    `;

    // Legacy: single agenteId for backwards compat (first agent or null)
    const ids = agenteIds || (agenteId ? [agenteId] : []);
    const legacyAgenteId = ids.length === 1 && !todosAgentes ? ids[0] : null;

    const result = await client.query(query,
      [empresaId, legacyAgenteId, !!todosAgentes, nome, encryptedKey, keyHash, createdBy]
    );

    const created = result.rows[0];

    // Insert into api_key_agentes pivot table (when not todos_agentes)
    if (!todosAgentes && ids.length > 0) {
      for (const agId of ids) {
        await client.query(
          'INSERT INTO api_key_agentes (api_key_id, agente_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
          [created.id, agId]
        );
      }
    }

    await client.query('COMMIT');

    createLogger.info('API key created', {
      empresa_id: empresaId,
      todos_agentes: !!todosAgentes,
      agente_ids: ids,
      key_id: created.id,
      created_by: createdBy
    });

    return {
      id: created.id,
      nome: created.nome_exibicao,
      created_at: created.criado_em,
      is_active: created.status === 'ativa',
      message: 'API key created successfully.'
    };

  } catch (error) {
    await client.query('ROLLBACK');
    createLogger.error('Failed to create API key', {
      empresa_id: empresaId,
      error: error.message
    });
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Validate API key and get associated Gemini key
 * Uses hash-based O(1) lookup instead of decrypting all keys
 */
export async function validateApiKey(apiKey) {
  try {
    const keyHash = sha256Hash(apiKey);

    // Check cache first (keyed by hash, NOT the raw key)
    const cacheKey = `${API_KEY_CACHE_PREFIX}${keyHash}`;
    const cached = await getJSON(cacheKey);

    if (cached) {
      createLogger.debug('API key found in cache');
      return cached;
    }

    // Fast lookup by hash — O(1) via index
    const query = `
      SELECT
        ak.id,
        ak.empresa_id,
        ak.agente_id,
        ak.api_key_encrypted,
        ak.status,
        a.nome as agente_nome,
        a.modelo,
        a.temperatura,
        a.max_tokens,
        a.prompt_ativo,
        e.ativo as empresa_active
      FROM api_keys ak
      LEFT JOIN agentes a ON ak.agente_id = a.id
      INNER JOIN empresas e ON ak.empresa_id = e.id
      WHERE ak.api_key_hash = $1
        AND ak.status = 'ativa'
        AND (a.ativo = true OR ak.agente_id IS NULL)
      LIMIT 1
    `;

    let result = await pool.query(query, [keyHash]);

    // Fallback for keys created before migration 046 (no hash stored)
    if (result.rows.length === 0) {
      const fallbackResult = await pool.query(`
        SELECT ak.id, ak.empresa_id, ak.agente_id, ak.api_key_encrypted, ak.status,
               a.nome as agente_nome, a.modelo, a.temperatura, a.max_tokens, a.prompt_ativo,
               e.ativo as empresa_active
        FROM api_keys ak
        LEFT JOIN agentes a ON ak.agente_id = a.id
        INNER JOIN empresas e ON ak.empresa_id = e.id
        WHERE ak.api_key_hash IS NULL AND ak.status = 'ativa'
          AND (a.ativo = true OR ak.agente_id IS NULL)
      `);

      for (const row of fallbackResult.rows) {
        try {
          const decryptedKey = decrypt(row.api_key_encrypted);
          if (decryptedKey === apiKey) {
            // Backfill the hash for future lookups
            pool.query('UPDATE api_keys SET api_key_hash = $1 WHERE id = $2', [keyHash, row.id]).catch(() => {});
            result = { rows: [row] };
            break;
          }
        } catch (e) {
          continue;
        }
      }

      if (result.rows.length === 0) {
        createLogger.warn('Invalid API key attempt');
        return null;
      }
    }

    const matchedKey = result.rows[0];

    // Check if company is active
    if (!matchedKey.empresa_active) {
      createLogger.warn('API key for inactive company', {
        empresa_id: matchedKey.empresa_id
      });
      return null;
    }

    // Decrypt Gemini key
    const geminiApiKey = decrypt(matchedKey.api_key_encrypted);

    // Update last used timestamp (non-blocking)
    pool.query(
      'UPDATE api_keys SET ultimo_uso = CURRENT_TIMESTAMP WHERE id = $1',
      [matchedKey.id]
    ).catch(err => {
      createLogger.error('Failed to update ultimo_uso', {
        key_id: matchedKey.id,
        error: err.message
      });
    });

    const validatedData = {
      id: matchedKey.id,
      empresa_id: matchedKey.empresa_id,
      agente_id: matchedKey.agente_id,
      agente_nome: matchedKey.agente_nome,
      gemini_api_key: geminiApiKey,
      modelo: matchedKey.modelo,
      temperatura: matchedKey.temperatura,
      max_tokens: matchedKey.max_tokens,
      prompt_ativo: matchedKey.prompt_ativo
    };

    // Cache keyed by hash (NOT the raw API key — never cache raw secrets as keys)
    await setWithExpiry(cacheKey, validatedData, API_KEY_CACHE_TTL);

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
 */
export async function listApiKeys(empresaId, agenteId = null) {
  try {
    let query = `
      SELECT
        ak.id,
        ak.nome_exibicao as nome,
        ak.agente_id,
        ak.todos_agentes,
        ak.provedor,
        ak.status,
        ak.prioridade,
        ak.ultimo_uso,
        ak.criado_em,
        ak.atualizado_em,
        ak.tentativas_erro,
        ak.ultimo_erro,
        ak.ultimo_erro_msg,
        ak.total_requests_hoje,
        u.nome as created_by_nome
      FROM api_keys ak
      LEFT JOIN usuarios u ON ak.criado_por = u.id
      WHERE ak.empresa_id = $1
    `;

    const params = [empresaId];

    if (agenteId) {
      query += ` AND (ak.todos_agentes = true OR ak.id IN (SELECT api_key_id FROM api_key_agentes WHERE agente_id = $2))`;
      params.push(agenteId);
    }

    query += ' ORDER BY ak.criado_em DESC';

    const result = await pool.query(query, params);

    // Fetch agentes for each key from pivot table
    const keyIds = result.rows.map(r => r.id);
    let agentesMap = {};
    if (keyIds.length > 0) {
      const agentesResult = await pool.query(`
        SELECT aka.api_key_id, a.id, a.nome
        FROM api_key_agentes aka
        INNER JOIN agentes a ON aka.agente_id = a.id
        WHERE aka.api_key_id = ANY($1)
        ORDER BY a.nome
      `, [keyIds]);
      for (const row of agentesResult.rows) {
        if (!agentesMap[row.api_key_id]) agentesMap[row.api_key_id] = [];
        agentesMap[row.api_key_id].push({ id: row.id, nome: row.nome });
      }
    }

    return result.rows.map(key => ({
      id: key.id,
      nome: key.nome,
      provedor: key.provedor,
      status: key.status,
      prioridade: key.prioridade,
      todos_agentes: key.todos_agentes || false,
      agentes: key.todos_agentes ? [] : (agentesMap[key.id] || []),
      // Legacy compat
      agente: key.agente_id ? { id: key.agente_id } : null,
      created_at: key.criado_em,
      created_by: key.created_by_nome,
      last_used_at: key.ultimo_uso,
      is_active: key.status === 'ativa',
      tentativas_erro: key.tentativas_erro || 0,
      ultimo_erro: key.ultimo_erro,
      ultimo_erro_msg: key.ultimo_erro_msg,
      total_requests_hoje: key.total_requests_hoje || 0
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
 */
export async function revokeApiKey(empresaId, keyId, revokedBy) {
  try {
    const query = `
      UPDATE api_keys
      SET
        status = 'revogado',
        atualizado_em = CURRENT_TIMESTAMP
      WHERE empresa_id = $1 AND id = $2 AND status = 'ativa'
    `;

    const result = await pool.query(query, [empresaId, keyId]);

    if (result.rowCount === 0) {
      return false;
    }

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
 */
export async function rotateApiKey(empresaId, oldKeyId, geminiApiKey, rotatedBy) {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // Get current key details
    const currentQuery = `
      SELECT agente_id, todos_agentes, nome_exibicao as nome
      FROM api_keys
      WHERE empresa_id = $1 AND id = $2 AND status = 'ativa'
    `;

    const currentResult = await client.query(currentQuery, [empresaId, oldKeyId]);

    if (currentResult.rows.length === 0) {
      throw new Error('API key not found or already revoked');
    }

    const { agente_id, todos_agentes, nome } = currentResult.rows[0];

    // Get associated agents from pivot table
    const agentesResult = await client.query(
      'SELECT agente_id FROM api_key_agentes WHERE api_key_id = $1',
      [oldKeyId]
    );
    const agenteIds = agentesResult.rows.map(r => r.agente_id);

    // Create new key preserving associations
    const newKey = await createApiKey({
      empresaId,
      agenteIds: agenteIds.length > 0 ? agenteIds : (agente_id ? [agente_id] : []),
      todosAgentes: todos_agentes,
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
 * Update API key metadata (name, priority, agents, and optionally the Gemini key)
 */
export async function updateApiKeyInfo(empresaId, keyId, updates) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const setClauses = ['atualizado_em = CURRENT_TIMESTAMP'];
    const params = [empresaId, keyId];
    let paramIdx = 3;

    if (updates.nome !== undefined) {
      setClauses.push(`nome_exibicao = $${paramIdx++}`);
      params.push(updates.nome);
    }
    if (updates.prioridade !== undefined) {
      setClauses.push(`prioridade = $${paramIdx++}`);
      params.push(updates.prioridade);
    }
    if (updates.gemini_api_key) {
      setClauses.push(`api_key_encrypted = $${paramIdx++}`);
      params.push(encrypt(updates.gemini_api_key));
      setClauses.push(`api_key_hash = $${paramIdx++}`);
      params.push(sha256Hash(updates.gemini_api_key));
    }
    if (updates.status !== undefined) {
      setClauses.push(`status = $${paramIdx++}`);
      params.push(updates.status);
    }
    if (updates.todos_agentes !== undefined) {
      setClauses.push(`todos_agentes = $${paramIdx++}`);
      params.push(updates.todos_agentes);
    }

    const query = `
      UPDATE api_keys
      SET ${setClauses.join(', ')}
      WHERE empresa_id = $1 AND id = $2
      RETURNING id, nome_exibicao as nome, prioridade, status, todos_agentes, atualizado_em
    `;

    const result = await client.query(query, params);

    if (result.rowCount === 0) {
      await client.query('ROLLBACK');
      return null;
    }

    // Update agent associations if provided
    if (updates.agente_ids !== undefined) {
      // Remove all existing associations
      await client.query('DELETE FROM api_key_agentes WHERE api_key_id = $1', [keyId]);
      // Insert new ones
      if (!updates.todos_agentes && updates.agente_ids.length > 0) {
        for (const agId of updates.agente_ids) {
          await client.query(
            'INSERT INTO api_key_agentes (api_key_id, agente_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
            [keyId, agId]
          );
        }
      }
      // Update legacy agente_id column
      const legacyId = updates.agente_ids.length === 1 && !updates.todos_agentes ? updates.agente_ids[0] : null;
      await client.query('UPDATE api_keys SET agente_id = $1 WHERE id = $2', [legacyId, keyId]);
    }

    await client.query('COMMIT');

    createLogger.info('API key info updated', {
      empresa_id: empresaId,
      key_id: keyId,
      fields: Object.keys(updates)
    });

    return result.rows[0];

  } catch (error) {
    await client.query('ROLLBACK');
    createLogger.error('Failed to update API key info', {
      empresa_id: empresaId,
      key_id: keyId,
      error: error.message
    });
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Update Gemini API key for an existing key
 */
export async function updateGeminiKey(empresaId, keyId, newGeminiKey) {
  try {
    const encryptedKey = encrypt(newGeminiKey);
    const keyHash = sha256Hash(newGeminiKey);

    const query = `
      UPDATE api_keys
      SET api_key_encrypted = $3, api_key_hash = $4, atualizado_em = CURRENT_TIMESTAMP
      WHERE empresa_id = $1 AND id = $2 AND status = 'ativa'
    `;

    const result = await pool.query(query, [empresaId, keyId, encryptedKey, keyHash]);

    if (result.rowCount === 0) {
      return false;
    }

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
 * Get all active API keys for an agent, ordered by priority
 * Used for failover: when one key fails, try the next
 * Supports: todos_agentes=true, pivot table api_key_agentes, and legacy agente_id
 */
export async function getActiveKeysForAgent(empresaId, agenteId) {
  try {
    const query = `
      SELECT
        id,
        api_key_encrypted,
        prioridade,
        tentativas_erro,
        ultimo_erro,
        retry_apos
      FROM api_keys
      WHERE empresa_id = $1
        AND status = 'ativa'
        AND (retry_apos IS NULL OR retry_apos < CURRENT_TIMESTAMP)
        AND (
          todos_agentes = true
          OR id IN (SELECT api_key_id FROM api_key_agentes WHERE agente_id = $2)
          OR agente_id = $2
        )
      ORDER BY prioridade ASC, tentativas_erro ASC, criado_em ASC
    `;

    const result = await pool.query(query, [empresaId, agenteId]);

    return result.rows.map(row => ({
      id: row.id,
      gemini_api_key: decrypt(row.api_key_encrypted),
      prioridade: row.prioridade,
      tentativas_erro: row.tentativas_erro
    }));

  } catch (error) {
    createLogger.error('Failed to get active keys for agent', {
      empresa_id: empresaId,
      agente_id: agenteId,
      error: error.message
    });
    return [];
  }
}

/**
 * Record an error on an API key (for failover tracking)
 */
export async function recordKeyError(keyId, errorMessage) {
  try {
    // After 5 consecutive errors, set retry_apos to 30 min from now
    const query = `
      UPDATE api_keys
      SET
        tentativas_erro = tentativas_erro + 1,
        ultimo_erro = CURRENT_TIMESTAMP,
        ultimo_erro_msg = $2,
        retry_apos = CASE
          WHEN tentativas_erro + 1 >= 5 THEN CURRENT_TIMESTAMP + INTERVAL '30 minutes'
          WHEN tentativas_erro + 1 >= 3 THEN CURRENT_TIMESTAMP + INTERVAL '5 minutes'
          ELSE NULL
        END,
        atualizado_em = CURRENT_TIMESTAMP
      WHERE id = $1
    `;

    await pool.query(query, [keyId, errorMessage]);

    createLogger.warn('API key error recorded', {
      key_id: keyId,
      error: errorMessage
    });
  } catch (error) {
    createLogger.error('Failed to record key error', {
      key_id: keyId,
      error: error.message
    });
  }
}

/**
 * Reset error count on successful use
 */
export async function recordKeySuccess(keyId) {
  try {
    await pool.query(`
      UPDATE api_keys
      SET
        tentativas_erro = 0,
        ultimo_erro = NULL,
        ultimo_erro_msg = NULL,
        retry_apos = NULL,
        ultimo_uso = CURRENT_TIMESTAMP,
        total_requests_hoje = total_requests_hoje + 1,
        atualizado_em = CURRENT_TIMESTAMP
      WHERE id = $1
    `, [keyId]);
  } catch (error) {
    createLogger.error('Failed to record key success', {
      key_id: keyId,
      error: error.message
    });
  }
}

/**
 * Clean up expired/errored keys
 */
export async function cleanupExpiredKeys() {
  try {
    const query = `
      UPDATE api_keys
      SET status = 'inativo'
      WHERE tentativas_erro >= 10
        AND status = 'ativa'
      RETURNING id
    `;

    const result = await pool.query(query);

    if (result.rowCount > 0) {
      createLogger.info('Problem keys cleaned up', {
        count: result.rowCount,
        key_ids: result.rows.map(r => r.id)
      });
    }

    return result.rowCount;

  } catch (error) {
    createLogger.error('Failed to cleanup keys', {
      error: error.message
    });
    return 0;
  }
}

/**
 * Get API key statistics for a company
 */
export async function getApiKeyStats(empresaId) {
  try {
    const query = `
      SELECT
        COUNT(*) FILTER (WHERE status = 'ativa') as active_count,
        COUNT(*) FILTER (WHERE status != 'ativa') as revoked_count,
        COUNT(*) FILTER (WHERE ultimo_uso > CURRENT_TIMESTAMP - INTERVAL '24 hours') as used_today,
        COUNT(*) FILTER (WHERE tentativas_erro > 0) as error_count,
        MAX(criado_em) as last_created_at,
        MAX(ultimo_uso) as last_used_at
      FROM api_keys
      WHERE empresa_id = $1
    `;

    const result = await pool.query(query, [empresaId]);

    return {
      active_keys: parseInt(result.rows[0].active_count) || 0,
      revoked_keys: parseInt(result.rows[0].revoked_count) || 0,
      used_today: parseInt(result.rows[0].used_today) || 0,
      error_keys: parseInt(result.rows[0].error_count) || 0,
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
