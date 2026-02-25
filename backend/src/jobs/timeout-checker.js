import { pool } from '../config/database.js';
import { logger } from '../config/logger.js';
import chatwootService from '../services/chatwoot.js';

let intervalId = null;

/**
 * Job que verifica conversas com humano inativo e devolve para IA
 */
async function checkTimeouts() {
  const client = await pool.connect();

  try {
    // Buscar conversas controladas por humano que estão inativas
    const result = await client.query(`
      SELECT
        c.*,
        cch.timeout_inatividade_minutos,
        cch.mensagem_retorno_ia,
        e.chatwoot_url,
        e.chatwoot_api_token,
        e.chatwoot_account_id
      FROM conversas c
      JOIN empresas e ON e.id = c.empresa_id
      LEFT JOIN config_controle_humano cch ON cch.empresa_id = c.empresa_id
      WHERE c.controlado_por = 'humano'
        AND c.status = 'ativo'
        AND cch.ativo = true
        AND c.humano_ultima_msg_em < NOW() - INTERVAL '1 minute' * COALESCE(cch.timeout_inatividade_minutos, 30)
    `);

    logger.info(`Found ${result.rows.length} timed out conversations`);

    for (const conversa of result.rows) {
      await processTimeoutConversation(client, conversa);
    }

  } catch (error) {
    logger.error('Error in timeout checker:', error);
  } finally {
    client.release();
  }
}

async function processTimeoutConversation(client, conversa) {
  try {
    await client.query('BEGIN');

    // 1. Atualizar conversa para controle da IA
    await client.query(`
      UPDATE conversas
      SET
        controlado_por = 'ia',
        humano_devolveu_em = NOW(),
        atualizado_em = NOW()
      WHERE id = $1
    `, [conversa.id]);

    // 2. Registrar no histórico de controle
    await client.query(`
      INSERT INTO controle_historico (
        id, conversa_id, empresa_id, acao,
        de_controlador, para_controlador,
        humano_id, humano_nome, motivo, criado_em
      )
      VALUES (
        gen_random_uuid(), $1, $2, 'timeout_ia_reassumiu',
        'humano', 'ia',
        $3, $4, $5, NOW()
      )
    `, [
      conversa.id,
      conversa.empresa_id,
      conversa.humano_id,
      conversa.humano_nome,
      `Timeout de ${conversa.timeout_inatividade_minutos} minutos`
    ]);

    // 3. Criar notificação
    await client.query(`
      INSERT INTO notificacoes (
        id, empresa_id, tipo, titulo, mensagem,
        severidade, lida, criado_em
      )
      VALUES (
        gen_random_uuid(), $1, 'timeout_conversa',
        'Conversa retornada para IA',
        $2,
        'warning', false, NOW()
      )
    `, [
      conversa.empresa_id,
      `A conversa ${conversa.conversation_id_chatwoot} foi devolvida para a IA devido a inatividade de ${conversa.timeout_inatividade_minutos} minutos`
    ]);

    // 4. Se configurado, enviar mensagem de retorno
    if (conversa.mensagem_retorno_ia && conversa.chatwoot_url) {
      try {
        await chatwootService.sendMessage({
          chatwoot_url: conversa.chatwoot_url,
          chatwoot_api_token: conversa.chatwoot_api_token,
          chatwoot_account_id: conversa.chatwoot_account_id
        }, conversa.conversation_id_chatwoot, conversa.mensagem_retorno_ia);

        logger.info(`Sent return message for conversation ${conversa.id}`);
      } catch (error) {
        logger.error(`Failed to send return message for conversation ${conversa.id}:`, error);
      }
    }

    // 5. Desatribuir agente no Chatwoot
    if (conversa.chatwoot_url) {
      try {
        await chatwootService.unassignAgent({
          chatwoot_url: conversa.chatwoot_url,
          chatwoot_api_token: conversa.chatwoot_api_token,
          chatwoot_account_id: conversa.chatwoot_account_id
        }, conversa.conversation_id_chatwoot);

        logger.info(`Unassigned agent in Chatwoot for conversation ${conversa.id}`);
      } catch (error) {
        logger.error(`Failed to unassign agent for conversation ${conversa.id}:`, error);
      }
    }

    await client.query('COMMIT');
    logger.info(`Successfully processed timeout for conversation ${conversa.id}`);

  } catch (error) {
    await client.query('ROLLBACK');
    logger.error(`Failed to process timeout for conversation ${conversa.id}:`, error);
  }
}

/**
 * Inicia o job de verificação de timeout
 */
export function start() {
  if (intervalId) {
    logger.warn('Timeout checker already running');
    return;
  }

  const INTERVAL = 5 * 60 * 1000; // 5 minutos

  // Executar imediatamente na primeira vez
  checkTimeouts();

  // Configurar intervalo
  intervalId = setInterval(checkTimeouts, INTERVAL);

  logger.info('Timeout checker started - running every 5 minutes');
}

/**
 * Para o job de verificação
 */
export function stop() {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
    logger.info('Timeout checker stopped');
  }
}

export default {
  start,
  stop,
  checkTimeouts
};