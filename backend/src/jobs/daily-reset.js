import { pool } from '../config/database.js';
import { logger } from '../config/logger.js';
import * as apiKeyManager from '../services/api-key-manager.js';
import { resetMensalCreditos } from '../services/creditos-ia.js';

let timeoutId = null;

/**
 * Job que reseta contadores diários e reativa keys
 */
async function performDailyReset() {
  logger.info('Starting daily reset job...');

  try {
    // 1. Resetar contadores diários das API keys
    await apiKeyManager.resetDailyCounters();
    logger.info('✓ API key daily counters reset');

    // 2. Reativar keys que estavam rate limited
    const reactivatedKeys = await reactivateRateLimitedKeys();
    logger.info(`✓ Reactivated ${reactivatedKeys} rate-limited keys`);

    // 3. Resetar contadores de uso diário de agentes
    const resetAgents = await resetAgentDailyUsage();
    logger.info(`✓ Reset daily usage for ${resetAgents} agents`);

    // 4. Criar registros de uso diário para o novo dia
    await createDailyUsageRecords();
    logger.info('✓ Created daily usage records for today');

    // 5. Limpar logs antigos (opcional - manter apenas últimos 30 dias)
    const deletedLogs = await cleanOldLogs();
    logger.info(`✓ Cleaned ${deletedLogs} old log entries`);

    // 6. Reset mensal de créditos IA (empresas cujo ciclo venceu)
    try {
      const resetados = await resetMensalCreditos();
      if (resetados > 0) {
        logger.info(`✓ Reset mensal de créditos IA: ${resetados} empresas`);
      }
    } catch (err) {
      logger.error('Erro no reset mensal de créditos IA:', err);
    }

    // 7. Gerar notificação de reset concluído
    await createResetNotification();

    logger.info('Daily reset completed successfully');

  } catch (error) {
    logger.error('Daily reset failed:', error);

    // Criar notificação de erro
    try {
      await createErrorNotification(error);
    } catch (notifError) {
      logger.error('Failed to create error notification:', notifError);
    }
  }
}

async function reactivateRateLimitedKeys() {
  const result = await pool.query(`
    UPDATE api_keys
    SET
      status = 'ativa',
      tentativas_erro = 0,
      retry_apos = NULL,
      atualizado_em = NOW()
    WHERE status = 'rate_limited'
      AND (retry_apos IS NULL OR retry_apos <= NOW())
    RETURNING id
  `);

  return result.rowCount;
}

async function resetAgentDailyUsage() {
  // Marcar registros antigos como finalizados
  const result = await pool.query(`
    UPDATE uso_diario_agente
    SET limite_atingido = false
    WHERE data < CURRENT_DATE
      AND limite_atingido = true
    RETURNING id
  `);

  return result.rowCount;
}

async function createDailyUsageRecords() {
  // Criar registros para todos os agentes ativos
  await pool.query(`
    INSERT INTO uso_diario_agente (id, empresa_id, agente_id, data, total_atendimentos, limite_diario, limite_atingido)
    SELECT
      gen_random_uuid(),
      a.empresa_id,
      a.id,
      CURRENT_DATE,
      0,
      COALESCE(
        (SELECT fi.limite_diario
         FROM assinatura_itens ai
         JOIN assinaturas ass ON ass.id = ai.assinatura_id
         JOIN faixas_item fi ON fi.id = ai.faixa_id
         JOIN itens_cobraveis ic ON ic.id = ai.item_cobravel_id
         WHERE ass.empresa_id = a.empresa_id
           AND ic.slug = 'agente_ia'
           AND ai.ativo = true
           AND ass.status = 'ativa'
         LIMIT 1),
        500 -- limite padrão se não houver assinatura
      ),
      false
    FROM agentes a
    WHERE a.ativo = true
      AND a.conta_atendimento = true
      AND NOT EXISTS (
        SELECT 1 FROM uso_diario_agente uda
        WHERE uda.agente_id = a.id
          AND uda.data = CURRENT_DATE
      )
  `);
}

async function cleanOldLogs() {
  // Manter apenas logs dos últimos 30 dias
  const result = await pool.query(`
    DELETE FROM mensagens_log
    WHERE criado_em < NOW() - INTERVAL '30 days'
    RETURNING id
  `);

  return result.rowCount;
}

async function createResetNotification() {
  await pool.query(`
    INSERT INTO notificacoes (id, empresa_id, tipo, titulo, mensagem, severidade, lida, criado_em)
    SELECT gen_random_uuid(), id, 'daily_reset', 'Reset diário concluído',
      'Os contadores diários foram resetados com sucesso às ' || TO_CHAR(NOW(), 'HH24:MI'),
      'info', false, NOW()
    FROM empresas WHERE ativo = true
  `);
}

async function createErrorNotification(error) {
  await pool.query(`
    INSERT INTO notificacoes (id, empresa_id, tipo, titulo, mensagem, severidade, lida, criado_em)
    SELECT gen_random_uuid(), id, 'daily_reset_error',
      'Erro no reset diário',
      'Falha ao executar reset diário: ' || $1,
      'critical', false, NOW()
    FROM empresas WHERE ativo = true
  `, [error.message]);
}

/**
 * Calcula o tempo até a próxima meia-noite
 */
function getTimeUntilMidnight() {
  const now = new Date();
  const midnight = new Date();
  midnight.setHours(24, 0, 0, 0);
  return midnight - now;
}

/**
 * Agenda o próximo reset
 */
function scheduleNextReset() {
  const delay = getTimeUntilMidnight();
  const nextRun = new Date(Date.now() + delay);

  logger.info(`Next daily reset scheduled for ${nextRun.toISOString()}`);

  timeoutId = setTimeout(() => {
    performDailyReset()
      .then(() => {
        // Agendar próximo reset
        scheduleNextReset();
      })
      .catch(error => {
        logger.error('Daily reset crashed:', error);
        // Reagendar mesmo em caso de erro
        scheduleNextReset();
      });
  }, delay);
}

/**
 * Inicia o job de reset diário
 */
export function start() {
  if (timeoutId) {
    logger.warn('Daily reset already scheduled');
    return;
  }

  // Se estiver em desenvolvimento, executar a cada minuto para teste
  if (process.env.NODE_ENV === 'development' && process.env.DAILY_RESET_TEST === 'true') {
    logger.info('Daily reset in TEST MODE - running every minute');
    performDailyReset();
    timeoutId = setInterval(performDailyReset, 60 * 1000);
  } else {
    // Em produção, agendar para meia-noite
    scheduleNextReset();
  }

  logger.info('Daily reset job started');
}

/**
 * Para o job de reset
 */
export function stop() {
  if (timeoutId) {
    if (process.env.NODE_ENV === 'development' && process.env.DAILY_RESET_TEST === 'true') {
      clearInterval(timeoutId);
    } else {
      clearTimeout(timeoutId);
    }
    timeoutId = null;
    logger.info('Daily reset job stopped');
  }
}

/**
 * Força execução imediata (útil para testes)
 */
export function forceRun() {
  return performDailyReset();
}

export default {
  start,
  stop,
  forceRun,
  performDailyReset
};