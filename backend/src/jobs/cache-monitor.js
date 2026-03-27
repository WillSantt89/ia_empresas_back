/**
 * Cache Monitor Job
 *
 * Roda 2x por dia (a cada 12h) e renova caches expirados de agentes
 * com cache_auto_renew = true.
 */
import { pool } from '../config/database.js';
import { logger } from '../config/logger.js';
import { decrypt } from '../config/encryption.js';
import { createContextCache, deleteContextCache } from '../services/gemini.js';
import { getActiveKeysForAgent } from '../services/api-key-manager.js';
import { buildToolDeclarations } from '../services/gemini.js';

const clog = logger.child({ module: 'cache-monitor' });

let intervalId = null;
const INTERVAL_MS = 4 * 60 * 60 * 1000; // 4 horas (6x por dia)

async function checkCaches() {
  try {
    // Buscar agentes com auto-renew ativo que precisam de criação ou renovação
    const result = await pool.query(`
      SELECT a.id, a.empresa_id, a.nome, a.modelo, a.prompt_ativo,
             a.cache_enabled, a.gemini_cache_id, a.cache_expires_at,
             a.cache_api_key_id
      FROM agentes a
      WHERE a.ativo = true
        AND a.cache_auto_renew = true
        AND a.prompt_ativo IS NOT NULL
        AND LENGTH(a.prompt_ativo) >= 4096
        AND (
          a.cache_enabled = false
          OR a.cache_expires_at IS NULL
          OR a.cache_expires_at < NOW() + INTERVAL '2 hours'
        )
    `);

    if (result.rows.length === 0) {
      clog.info('No caches to renew');
      return;
    }

    clog.info(`Found ${result.rows.length} agent(s) needing cache renewal`);

    let renewed = 0;
    let failed = 0;

    for (const agent of result.rows) {
      try {
        await renewAgentCache(agent);
        renewed++;
      } catch (err) {
        clog.error({ err, agente_id: agent.id, agente_nome: agent.nome }, 'Failed to renew cache');
        failed++;
      }
    }

    clog.info(`Cache monitor complete: ${renewed} renewed, ${failed} failed`);
  } catch (error) {
    clog.error({ err: error }, 'Cache monitor error');
  }
}

async function renewAgentCache(agent) {
  const { id, empresa_id, nome, modelo, prompt_ativo, gemini_cache_id } = agent;

  // Buscar API key ativa
  const availableKeys = await getActiveKeysForAgent(empresa_id, id);
  if (!availableKeys || availableKeys.length === 0) {
    clog.warn({ agente_id: id, agente_nome: nome }, 'No API keys available, skipping cache renewal');
    return;
  }

  const primaryKey = availableKeys[0];

  // Buscar tools do agente
  const toolsResult = await pool.query(`
    SELECT t.id, t.nome, t.descricao_para_llm, t.parametros_schema_json
    FROM tools t
    INNER JOIN agente_tools at2 ON t.id = at2.tool_id
    WHERE at2.agente_id = $1 AND t.ativo = true
    ORDER BY at2.ordem_prioridade ASC
  `, [id]);

  const toolDeclarations = toolsResult.rows.length > 0 ? buildToolDeclarations(toolsResult.rows) : [];

  // Deletar cache antigo se existir
  if (gemini_cache_id) {
    try {
      await deleteContextCache(primaryKey.gemini_api_key, gemini_cache_id);
    } catch (err) {
      clog.warn({ agente_id: id, error: err.message }, 'Failed to delete old cache (may have already expired)');
    }
  }

  // Criar novo cache
  const cachedContent = await createContextCache({
    apiKey: primaryKey.gemini_api_key,
    model: modelo,
    systemPrompt: prompt_ativo,
    tools: toolDeclarations,
    ttlSeconds: 86400, // 24 horas
  });

  // Atualizar no banco (ativa cache se estava desativado)
  await pool.query(`
    UPDATE agentes SET
      cache_enabled = true,
      gemini_cache_id = $1,
      cache_expires_at = $2,
      cache_api_key_id = $3,
      atualizado_em = CURRENT_TIMESTAMP
    WHERE id = $4
  `, [cachedContent.name, cachedContent.expireTime, primaryKey.id, id]);

  clog.info({
    agente_id: id,
    agente_nome: nome,
    cache_name: cachedContent.name,
    expires_at: cachedContent.expireTime,
  }, 'Cache renewed successfully');
}

export function start() {
  if (intervalId) {
    clog.warn('Cache monitor already running');
    return;
  }

  // Executar primeira vez após 5 minutos (dar tempo do server iniciar)
  setTimeout(() => {
    checkCaches();
    intervalId = setInterval(checkCaches, INTERVAL_MS);
  }, 5 * 60 * 1000);

  clog.info(`Cache monitor started (runs every ${INTERVAL_MS / 3600000}h)`);
}

export function stop() {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
    clog.info('Cache monitor stopped');
  }
}

export function forceRun() {
  return checkCaches();
}

export default { start, stop, forceRun };
