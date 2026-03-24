/**
 * Follow-up Checker Job
 *
 * Roda a cada 2 minutos e verifica conversas ativas controladas pela IA
 * que estão sem resposta do cliente. Envia follow-up automático conforme
 * configuração da empresa (mensagem fixa ou via Gemini).
 *
 * Validações antes de disparar:
 * 1. Ticket ativo e controlado pela IA
 * 2. Cliente não respondeu desde última mensagem de saída
 * 3. Dentro do horário de funcionamento
 * 4. Dentro da janela de 24h do WhatsApp
 * 5. Não excedeu máximo de retries
 */
import { pool } from '../config/database.js';
import { logger } from '../config/logger.js';
import { decrypt } from '../config/encryption.js';
import { sendTextMessage } from '../services/whatsapp-sender.js';
import { getActiveKeysForAgent } from '../services/api-key-manager.js';
import { addToHistory, archiveConversation } from '../services/memory.js';
import { emitNovaMensagem, emitConversaAtualizada } from '../services/websocket.js';

const flog = logger.child({ module: 'followup-checker' });

let intervalId = null;
let isRunning = false;
const INTERVAL_MS = 1 * 60 * 1000; // 1 minuto
const MAX_PER_CYCLE = 3000; // Máximo de conversas por ciclo

async function checkFollowups() {
  // Lock para evitar execução paralela (ciclo anterior ainda rodando)
  if (isRunning) {
    flog.warn('Followup checker still running from previous cycle, skipping');
    return;
  }
  isRunning = true;
  try {
    // 1. Buscar todas as configs ativas (por fila e padrão)
    const configsResult = await pool.query(`
      SELECT cf.*, e.nome as empresa_nome, f.nome as fila_nome
      FROM config_followup cf
      JOIN empresas e ON e.id = cf.empresa_id AND e.ativo = true
      LEFT JOIN filas_atendimento f ON f.id = cf.fila_id
      WHERE cf.ativo = true
    `);

    if (configsResult.rows.length === 0) { isRunning = false; return; }

    // Agrupar configs por empresa
    const configsPorEmpresa = {};
    for (const config of configsResult.rows) {
      if (!configsPorEmpresa[config.empresa_id]) {
        configsPorEmpresa[config.empresa_id] = { padrao: null, porFila: {} };
      }
      if (config.fila_id) {
        configsPorEmpresa[config.empresa_id].porFila[config.fila_id] = config;
      } else {
        configsPorEmpresa[config.empresa_id].padrao = config;
      }
    }

    for (const [empresa_id, configs] of Object.entries(configsPorEmpresa)) {
      await processEmpresaFollowups(empresa_id, configs);
    }
  } catch (error) {
    flog.error({ err: error }, 'Erro no followup checker');
  } finally {
    isRunning = false;
  }
}

async function processEmpresaFollowups(empresa_id, configs) {
  // Determinar max retries global (maior entre todas as configs)
  const allConfigs = [configs.padrao, ...Object.values(configs.porFila)].filter(Boolean);
  const globalMaxRetries = Math.max(...allConfigs.map(c => (Array.isArray(c.retries) ? c.retries.length : 0)));
  if (globalMaxRetries === 0) return;

  // 2. Buscar conversas elegíveis
  const conversasResult = await pool.query(`
    SELECT
      c.id, c.empresa_id, c.contato_whatsapp, c.contato_nome, c.contato_id,
      c.agente_id, c.fila_id, c.whatsapp_number_id,
      c.followup_count, c.followup_ultimo_em,
      c.ultima_msg_entrada_em, c.atualizado_em,
      c.criado_em as conversa_criada_em
    FROM conversas c
    WHERE c.empresa_id = $1
      AND c.status = 'ativo'
      AND c.controlado_por IN ('ia', 'fila')
      AND c.followup_count < $2
      AND c.agente_id IS NOT NULL
      AND c.whatsapp_number_id IS NOT NULL
    ORDER BY c.atualizado_em ASC
    LIMIT $3
  `, [empresa_id, globalMaxRetries, MAX_PER_CYCLE]);

  for (const conversa of conversasResult.rows) {
    // Resolver config: específica da fila ou padrão
    const config = (conversa.fila_id && configs.porFila[conversa.fila_id]) || configs.padrao;
    if (!config || !config.ativo) continue;

    const { retries, horario_inicio, horario_fim, dias_semana, mensagem_encerramento } = config;
    const retriesArr = Array.isArray(retries) ? retries : [];
    if (retriesArr.length === 0) continue;
    if (conversa.followup_count >= retriesArr.length) continue;

    // Verificar horário de funcionamento
    if (!isWithinBusinessHours(horario_inicio, horario_fim, dias_semana)) continue;
    try {
      await processConversaFollowup(conversa, retriesArr, mensagem_encerramento);
    } catch (error) {
      flog.error({ err: error, conversa_id: conversa.id }, 'Erro ao processar followup de conversa');
    }
  }
}

async function processConversaFollowup(conversa, retriesArr, mensagem_encerramento) {
  const { id: conversa_id, empresa_id, followup_count } = conversa;

  // Determinar qual retry estamos (0-based index)
  const retryIndex = followup_count;
  const retryConfig = retriesArr[retryIndex];
  if (!retryConfig) return;

  const intervaloMs = retryConfig.intervalo_minutos * 60 * 1000;

  // Buscar última mensagem de SAÍDA (do agente/ia) para esta conversa
  const ultimaSaidaResult = await pool.query(`
    SELECT criado_em FROM mensagens_log
    WHERE conversa_id = $1 AND direcao = 'saida'
    ORDER BY criado_em DESC LIMIT 1
  `, [conversa_id]);

  if (ultimaSaidaResult.rows.length === 0) return;
  const ultimaSaidaEm = new Date(ultimaSaidaResult.rows[0].criado_em);

  // Buscar última mensagem de ENTRADA (do cliente) depois da última saída
  const ultimaEntradaResult = await pool.query(`
    SELECT criado_em FROM mensagens_log
    WHERE conversa_id = $1 AND direcao = 'entrada' AND criado_em > $2
    ORDER BY criado_em DESC LIMIT 1
  `, [conversa_id, ultimaSaidaEm]);

  // Se cliente respondeu depois da última saída, resetar followup
  if (ultimaEntradaResult.rows.length > 0) {
    await pool.query(
      `UPDATE conversas SET followup_count = 0, followup_ultimo_em = NULL, atualizado_em = NOW() WHERE id = $1`,
      [conversa_id]
    );
    return;
  }

  // Verificar se já passou tempo suficiente desde a última saída (ou último followup)
  const referencia = conversa.followup_ultimo_em
    ? new Date(conversa.followup_ultimo_em)
    : ultimaSaidaEm;

  const agora = new Date();
  if (agora - referencia < intervaloMs) return; // Ainda não é hora

  // Validar janela de 24h do WhatsApp
  const ultimaEntradaGeral = conversa.ultima_msg_entrada_em
    ? new Date(conversa.ultima_msg_entrada_em)
    : null;

  if (!ultimaEntradaGeral) return; // Nunca recebeu mensagem do cliente

  const horasDesdeUltimaMsgCliente = (agora - ultimaEntradaGeral) / (1000 * 60 * 60);
  if (horasDesdeUltimaMsgCliente > 24) {
    // Janela expirada — finalizar silenciosamente
    flog.info({ conversa_id }, 'Janela 24h expirada, finalizando conversa silenciosamente');
    await finalizarConversaSilenciosa(conversa_id, empresa_id, conversa);
    return;
  }

  // Verificar se é o ÚLTIMO retry
  const isUltimoRetry = retryIndex === retriesArr.length - 1;

  const retryNumero = followup_count + 1;
  const totalRetries = retriesArr.length;

  if (isUltimoRetry) {
    // Enviar mensagem de encerramento e finalizar
    await enviarFollowupFixo(conversa, mensagem_encerramento || 'Obrigado pelo contato! Estamos encerrando o atendimento.', retryNumero, totalRetries);
    await finalizarConversaSilenciosa(conversa_id, empresa_id, conversa);
    flog.info({ conversa_id, followup_count: retryNumero }, 'Último followup enviado, conversa finalizada');
    return;
  }

  // Reservar conversa atomicamente (incrementar ANTES de enviar para evitar duplicatas)
  const reserveResult = await pool.query(
    `UPDATE conversas SET followup_count = followup_count + 1, followup_ultimo_em = NOW(), atualizado_em = NOW()
     WHERE id = $1 AND followup_count = $2
     RETURNING id`,
    [conversa_id, followup_count]
  );

  // Se não reservou (outro ciclo já processou), pular
  if (reserveResult.rows.length === 0) {
    flog.info({ conversa_id }, 'Followup already processed by another cycle, skipping');
    return;
  }

  // Enviar followup conforme tipo
  try {
    if (retryConfig.tipo === 'fixo') {
      await enviarFollowupFixo(conversa, retryConfig.mensagem_fixa, retryNumero, totalRetries);
    } else {
      await enviarFollowupIA(conversa, retryNumero, totalRetries);
    }
    flog.info({ conversa_id, empresa_id: conversa.empresa_id, retry: retryNumero }, 'Follow-up enviado');
  } catch (sendErr) {
    // Se falhar o envio, reverter o contador
    await pool.query(
      `UPDATE conversas SET followup_count = followup_count - 1, followup_ultimo_em = NULL, atualizado_em = NOW() WHERE id = $1`,
      [conversa_id]
    );
    throw sendErr;
  }
}

/**
 * Envia mensagem fixa direta (sem Gemini)
 */
async function enviarFollowupFixo(conversa, mensagem, retryNumero, totalRetries) {
  const { id: conversa_id, empresa_id, contato_whatsapp, whatsapp_number_id, fila_id } = conversa;

  // Buscar credenciais WhatsApp
  const wnResult = await pool.query(
    `SELECT phone_number_id, token_graph_api FROM whatsapp_numbers WHERE id = $1 AND empresa_id = $2 AND ativo = true`,
    [whatsapp_number_id, empresa_id]
  );
  if (wnResult.rows.length === 0) return;

  const graphToken = decrypt(wnResult.rows[0].token_graph_api);
  if (!graphToken) return;

  const sendResult = await sendTextMessage(wnResult.rows[0].phone_number_id, graphToken, contato_whatsapp, mensagem);

  const nomeFollowup = `Follow-up ${retryNumero}/${totalRetries}`;

  // Logar mensagem
  const logResult = await pool.query(`
    INSERT INTO mensagens_log (conversa_id, empresa_id, direcao, conteudo, remetente_tipo, remetente_nome, tipo_mensagem, whatsapp_message_id, status_entrega, criado_em)
    VALUES ($1, $2, 'saida', $3, 'followup', $4, 'text', $5, $6, NOW())
    RETURNING id, criado_em
  `, [conversa_id, empresa_id, mensagem, nomeFollowup, sendResult.wamid, sendResult.success ? 'sent' : 'failed']);

  // Salvar no Redis history
  const conversationKey = `whatsapp:${contato_whatsapp}`;
  await addToHistory(empresa_id, conversationKey, 'model', mensagem);

  // WebSocket
  if (logResult.rows[0]) {
    emitNovaMensagem(conversa_id, fila_id, {
      id: logResult.rows[0].id,
      conversa_id,
      conteudo: mensagem,
      direcao: 'saida',
      remetente_tipo: 'followup',
      remetente_nome: nomeFollowup,
      tipo_mensagem: 'text',
      criado_em: logResult.rows[0].criado_em,
    });
  }
}

/**
 * Envia follow-up via Gemini (IA gera a mensagem)
 */
async function enviarFollowupIA(conversa, retryNumero, totalRetries) {
  const { id: conversa_id, empresa_id, contato_whatsapp, contato_id, contato_nome, agente_id, fila_id, whatsapp_number_id } = conversa;

  // Buscar agente
  const agentResult = await pool.query(
    `SELECT id as agente_id, nome as agente_nome, modelo, temperatura, max_tokens, prompt_ativo,
            cache_enabled, gemini_cache_id, cache_expires_at, mensagem_midia_nao_suportada
     FROM agentes WHERE id = $1 AND empresa_id = $2 AND ativo = true`,
    [agente_id, empresa_id]
  );
  if (agentResult.rows.length === 0) return;
  const agent = agentResult.rows[0];

  // Buscar API keys
  const availableKeys = await getActiveKeysForAgent(empresa_id, agente_id);
  if (availableKeys.length === 0) return;

  // Buscar credenciais WhatsApp
  const wnResult = await pool.query(
    `SELECT phone_number_id, token_graph_api FROM whatsapp_numbers WHERE id = $1 AND empresa_id = $2 AND ativo = true`,
    [whatsapp_number_id, empresa_id]
  );
  if (wnResult.rows.length === 0) return;

  const phoneNumberId = wnResult.rows[0].phone_number_id;
  const graphToken = decrypt(wnResult.rows[0].token_graph_api);
  if (!graphToken) return;

  // Montar mensagem de contexto para o Gemini
  const conversationKey = `whatsapp:${contato_whatsapp}`;
  const followupInstruction = `[Sistema] O cliente não respondeu. Esta é a tentativa de follow-up ${retryNumero} de ${totalRetries}. Envie uma mensagem gentil perguntando se o cliente ainda precisa de ajuda. Seja breve e natural, não mencione que é um follow-up automático.`;

  await addToHistory(empresa_id, conversationKey, 'user', followupInstruction);

  // Import dinâmico para evitar circular dependency
  const { processAIResponse } = await import('../services/message-processor.js');

  const startTime = Date.now();
  const result = await processAIResponse({
    empresa_id,
    conversa_id,
    contato_id,
    agente_id,
    agent,
    availableKeys,
    conversationKey,
    messageText: followupInstruction,
    parts: [{ text: followupInstruction }],
    startTime,
  });

  if (!result || !result.text) {
    flog.warn({ conversa_id }, 'Gemini não produziu resposta para followup');
    return;
  }

  // Enviar para WhatsApp
  const sendResult = await sendTextMessage(phoneNumberId, graphToken, contato_whatsapp, result.text);

  const nomeFollowup = `Follow-up ${retryNumero}/${totalRetries}`;

  // Logar
  const logResult = await pool.query(`
    INSERT INTO mensagens_log (
      conversa_id, empresa_id, direcao, conteudo, remetente_tipo, remetente_nome, tipo_mensagem,
      tokens_input, tokens_output, modelo_usado, latencia_ms,
      whatsapp_message_id, status_entrega, criado_em
    ) VALUES ($1, $2, 'saida', $3, 'followup', $4, 'text', $5, $6, $7, $8, $9, $10, NOW())
    RETURNING id, criado_em
  `, [
    conversa_id, empresa_id, result.text, nomeFollowup,
    result.tokensInput, result.tokensOutput, result.modelo,
    result.processingTime, sendResult.wamid, sendResult.success ? 'sent' : 'failed',
  ]);

  // WebSocket
  if (logResult.rows[0]) {
    emitNovaMensagem(conversa_id, fila_id, {
      id: logResult.rows[0].id,
      conversa_id,
      conteudo: result.text,
      direcao: 'saida',
      remetente_tipo: 'followup',
      remetente_nome: nomeFollowup,
      tipo_mensagem: 'text',
      criado_em: logResult.rows[0].criado_em,
    });
  }
}

/**
 * Finaliza conversa sem enviar mensagem (janela expirada ou após último retry)
 */
async function finalizarConversaSilenciosa(conversa_id, empresa_id, conversa) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query(
      `UPDATE conversas SET status = 'finalizado', atualizado_em = NOW() WHERE id = $1`,
      [conversa_id]
    );

    await client.query(`
      INSERT INTO controle_historico (conversa_id, empresa_id, acao, de_controlador, para_controlador, motivo)
      VALUES ($1, $2, 'finalizado', 'ia', NULL, 'Finalizado por inatividade do cliente (follow-up)')
    `, [conversa_id, empresa_id]);

    // Finalizar atendimento ativo
    await client.query(
      `UPDATE atendimentos SET status = 'finalizado', finalizado_em = NOW() WHERE conversa_id = $1 AND status = 'ativo'`,
      [conversa_id]
    );

    await client.query('COMMIT');

    // Arquivar Redis
    const conversationKey = `whatsapp:${conversa.contato_whatsapp}`;
    archiveConversation(empresa_id, conversationKey).catch(() => {});

    // WebSocket — notificar que conversa foi finalizada
    emitConversaAtualizada(conversa_id, conversa.fila_id, { id: conversa_id, status: 'finalizado' });

    flog.info({ conversa_id, empresa_id }, 'Conversa finalizada por inatividade (followup)');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Verifica se está dentro do horário de funcionamento
 */
function isWithinBusinessHours(horarioInicio, horarioFim, diasSemana) {
  const now = new Date();
  const diaSemana = now.getDay(); // 0=dom, 1=seg..6=sab

  if (!diasSemana.includes(diaSemana)) return false;

  const [hInicio, mInicio] = (horarioInicio || '08:00').split(':').map(Number);
  const [hFim, mFim] = (horarioFim || '18:00').split(':').map(Number);

  const horaAtual = now.getHours();
  const minutoAtual = now.getMinutes();

  const minutosInicio = hInicio * 60 + mInicio;
  const minutosFim = hFim * 60 + mFim;
  const minutosAtual = horaAtual * 60 + minutoAtual;

  return minutosAtual >= minutosInicio && minutosAtual <= minutosFim;
}

/**
 * Inicia o job de follow-up
 */
export function start() {
  if (intervalId) {
    flog.warn('Follow-up checker already running');
    return;
  }

  // Primeira execução após 30s (dar tempo para o server iniciar)
  setTimeout(() => checkFollowups(), 30000);

  intervalId = setInterval(checkFollowups, INTERVAL_MS);

  flog.info('Follow-up checker started — running every 2 minutes');
}

/**
 * Para o job
 */
export function stop() {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
    flog.info('Follow-up checker stopped');
  }
}

export default {
  start,
  stop,
  checkFollowups,
};
