/**
 * Bulk Operations Worker
 *
 * Processa operações em lote: finalizar, enviar template, enviar mensagem,
 * transferir fila. Roda em background sem timeout.
 */
import { Worker } from 'bullmq';
import { REDIS_CONNECTION, QUEUE_NAMES } from '../queues/config.js';
import { deadLetterQueue } from '../queues/queues.js';
import { pool } from '../config/database.js';
import { logger } from '../config/logger.js';
import { decrypt } from '../config/encryption.js';
import { sendTextMessage, sendTemplateMessage } from '../services/whatsapp-sender.js';
import { archiveConversation } from '../services/memory.js';
import { clearFlowState } from '../services/flow-engine.js';
import { calcularStatsFila } from '../services/fila-manager.js';
import { emitConversaAtualizada, emitFilaStats, emitNovaMensagem } from '../services/websocket.js';

const blog = logger.child({ module: 'bulk-operations-worker' });

async function processBulkJob(job) {
  const { empresa_id, operation, data, user } = job.data;

  blog.info({ jobId: job.id, empresa_id, operation, total: data.conversa_ids?.length }, 'Starting bulk operation');

  switch (operation) {
    case 'finalizar':
      return await bulkFinalizar(empresa_id, data, user, job);
    case 'template':
      return await bulkTemplate(empresa_id, data, user, job);
    case 'mensagem':
      return await bulkMensagem(empresa_id, data, user, job);
    case 'transferir':
      return await bulkTransferir(empresa_id, data, user, job);
    default:
      throw new Error(`Unknown bulk operation: ${operation}`);
  }
}

// --- Finalizar em lote ---
async function bulkFinalizar(empresa_id, data, user, job) {
  const { conversa_ids } = data;
  let sucesso = 0, erros = 0;
  const filasAfetadas = new Set();

  for (let i = 0; i < conversa_ids.length; i++) {
    const cid = conversa_ids[i];
    try {
      const conversa = await pool.query(
        `SELECT id, fila_id, contato_whatsapp, controlado_por FROM conversas WHERE id = $1 AND empresa_id = $2 AND status IN ('ativo', 'pendente')`,
        [cid, empresa_id]
      );
      if (conversa.rows.length === 0) { erros++; continue; }

      const c = conversa.rows[0];
      await pool.query(`UPDATE conversas SET status = 'finalizado', atualizado_em = NOW() WHERE id = $1`, [cid]);
      await pool.query(`UPDATE atendimentos SET status = 'finalizado', finalizado_em = NOW() WHERE conversa_id = $1 AND status = 'ativo'`, [cid]);
      await pool.query(
        `INSERT INTO controle_historico (conversa_id, empresa_id, acao, de_controlador, para_controlador, humano_id, humano_nome, motivo)
         VALUES ($1, $2, 'finalizado', $3, NULL, $4, $5, 'Finalizado em lote (background)')`,
        [cid, empresa_id, c.controlado_por, user.id, user.nome]
      );

      if (c.contato_whatsapp) {
        archiveConversation(empresa_id, `whatsapp:${c.contato_whatsapp}`).catch(() => {});
        clearFlowState(empresa_id, c.contato_whatsapp).catch(() => {});
      }

      emitConversaAtualizada(cid, c.fila_id, { id: cid, status: 'finalizado' });
      if (c.fila_id) filasAfetadas.add(c.fila_id);
      sucesso++;
    } catch (err) {
      blog.error({ err, conversa_id: cid }, 'Error finalizing conversation');
      erros++;
    }

    // Progress update a cada 50
    if (i % 50 === 0) await job.updateProgress(Math.round((i / conversa_ids.length) * 100));
  }

  // Atualizar stats das filas
  for (const filaId of filasAfetadas) {
    calcularStatsFila(filaId).then(s => emitFilaStats(filaId, s)).catch(() => {});
  }

  // Notificação
  await pool.query(
    `INSERT INTO notificacoes (id, empresa_id, tipo, titulo, mensagem, severidade, criado_em)
     VALUES (gen_random_uuid(), $1, 'bulk_finalizar', 'Fechamento em lote concluído', $2, 'info', NOW())`,
    [empresa_id, `${sucesso} tickets fechados, ${erros} erros — por ${user.nome}`]
  );

  blog.info({ empresa_id, sucesso, erros }, 'Bulk finalizar completed');
  return { sucesso, erros };
}

// --- Template em lote ---
async function bulkTemplate(empresa_id, data, user, job) {
  const { conversa_ids, template_name, whatsapp_number_id, language_code = 'pt_BR' } = data;

  // Buscar conexão
  const wnResult = await pool.query(
    'SELECT phone_number_id, token_graph_api FROM whatsapp_numbers WHERE id = $1 AND empresa_id = $2 AND ativo = true',
    [whatsapp_number_id, empresa_id]
  );
  if (wnResult.rows.length === 0) throw new Error('Conexão WhatsApp não encontrada');
  const graphToken = decrypt(wnResult.rows[0].token_graph_api);
  const phone_number_id = wnResult.rows[0].phone_number_id;

  let fechados = 0, enviados = 0, erros = 0;

  for (let i = 0; i < conversa_ids.length; i++) {
    const cid = conversa_ids[i];
    try {
      const conversa = await pool.query(
        `SELECT id, contato_whatsapp, fila_id, controlado_por FROM conversas WHERE id = $1 AND empresa_id = $2 AND status = 'ativo'`,
        [cid, empresa_id]
      );
      if (conversa.rows.length === 0) continue;
      const c = conversa.rows[0];

      // Fechar ticket
      await pool.query(`UPDATE conversas SET status = 'finalizado', atualizado_em = NOW() WHERE id = $1`, [cid]);
      await pool.query(`UPDATE atendimentos SET status = 'finalizado', finalizado_em = NOW() WHERE conversa_id = $1 AND status = 'ativo'`, [cid]);
      if (c.contato_whatsapp) {
        archiveConversation(empresa_id, `whatsapp:${c.contato_whatsapp}`).catch(() => {});
        clearFlowState(empresa_id, c.contato_whatsapp).catch(() => {});
      }
      emitConversaAtualizada(cid, c.fila_id, { id: cid, status: 'finalizado' });
      fechados++;

      // Enviar template
      const result = await sendTemplateMessage(phone_number_id, graphToken, c.contato_whatsapp, template_name, language_code);
      if (result.wamid) enviados++;
      else erros++;
    } catch (err) {
      blog.error({ err, conversa_id: cid }, 'Error in bulk template');
      erros++;
    }
    if (i % 50 === 0) await job.updateProgress(Math.round((i / conversa_ids.length) * 100));
  }

  await pool.query(
    `INSERT INTO notificacoes (id, empresa_id, tipo, titulo, mensagem, severidade, criado_em)
     VALUES (gen_random_uuid(), $1, 'bulk_template', 'Template em lote concluído', $2, 'info', NOW())`,
    [empresa_id, `${fechados} fechados, ${enviados} templates enviados, ${erros} erros — por ${user.nome}`]
  );

  blog.info({ empresa_id, fechados, enviados, erros }, 'Bulk template completed');
  return { fechados, enviados, erros };
}

// --- Mensagem em lote ---
async function bulkMensagem(empresa_id, data, user, job) {
  const { conversa_ids, mensagem } = data;
  let enviados = 0, erros = 0;
  const tokenCache = {};

  for (let i = 0; i < conversa_ids.length; i++) {
    const cid = conversa_ids[i];
    try {
      const conversa = await pool.query(`
        SELECT c.id, c.contato_whatsapp, c.fila_id, c.whatsapp_number_id, c.ultima_msg_entrada_em,
               wn.phone_number_id, wn.token_graph_api
        FROM conversas c
        JOIN whatsapp_numbers wn ON wn.id = c.whatsapp_number_id AND wn.ativo = true
        WHERE c.id = $1 AND c.empresa_id = $2 AND c.status = 'ativo'
          AND c.ultima_msg_entrada_em > NOW() - INTERVAL '24 hours'
      `, [cid, empresa_id]);
      if (conversa.rows.length === 0) continue;
      const c = conversa.rows[0];

      if (!tokenCache[c.whatsapp_number_id]) {
        tokenCache[c.whatsapp_number_id] = { phone_number_id: c.phone_number_id, graphToken: decrypt(c.token_graph_api) };
      }
      const { phone_number_id, graphToken } = tokenCache[c.whatsapp_number_id];

      const result = await sendTextMessage(phone_number_id, graphToken, c.contato_whatsapp, mensagem);
      if (result.wamid) {
        const logResult = await pool.query(`
          INSERT INTO mensagens_log (conversa_id, empresa_id, direcao, conteudo, remetente_tipo, remetente_nome, tipo_mensagem, whatsapp_message_id, criado_em)
          VALUES ($1, $2, 'saida', $3, 'mensagem_lote', $4, 'text', $5, NOW()) RETURNING id, criado_em
        `, [cid, empresa_id, mensagem, user.nome, result.wamid]);

        if (logResult.rows[0]) {
          emitNovaMensagem(cid, c.fila_id, {
            id: logResult.rows[0].id, conversa_id: cid, conteudo: mensagem, direcao: 'saida',
            remetente_tipo: 'mensagem_lote', remetente_nome: user.nome,
            tipo_mensagem: 'text', criado_em: logResult.rows[0].criado_em,
          });
        }
        enviados++;
      } else erros++;
    } catch (err) {
      blog.error({ err, conversa_id: cid }, 'Error in bulk message');
      erros++;
    }
    if (i % 50 === 0) await job.updateProgress(Math.round((i / conversa_ids.length) * 100));
  }

  await pool.query(
    `INSERT INTO notificacoes (id, empresa_id, tipo, titulo, mensagem, severidade, criado_em)
     VALUES (gen_random_uuid(), $1, 'bulk_mensagem', 'Mensagem em lote concluída', $2, 'info', NOW())`,
    [empresa_id, `${enviados} enviados, ${erros} erros — por ${user.nome}`]
  );

  blog.info({ empresa_id, enviados, erros }, 'Bulk message completed');
  return { enviados, erros };
}

// --- Transferir fila em lote ---
async function bulkTransferir(empresa_id, data, user, job) {
  const { conversa_ids, fila_destino_id } = data;
  let transferidos = 0, erros = 0;

  for (let i = 0; i < conversa_ids.length; i++) {
    try {
      const result = await pool.query(
        `UPDATE conversas SET fila_id = $1, controlado_por = 'fila', atualizado_em = NOW() WHERE id = $2 AND empresa_id = $3 AND status = 'ativo' RETURNING id`,
        [fila_destino_id, conversa_ids[i], empresa_id]
      );
      if (result.rows.length > 0) transferidos++;
      else erros++;
    } catch (err) { erros++; }
    if (i % 50 === 0) await job.updateProgress(Math.round((i / conversa_ids.length) * 100));
  }

  calcularStatsFila(fila_destino_id).then(s => emitFilaStats(fila_destino_id, s)).catch(() => {});

  blog.info({ empresa_id, transferidos, erros }, 'Bulk transfer completed');
  return { transferidos, erros };
}

// --- Worker ---
export const bulkOperationsWorker = new Worker(
  QUEUE_NAMES.BULK_OPERATIONS,
  processBulkJob,
  {
    connection: REDIS_CONNECTION,
    concurrency: 2, // Apenas 2 jobs simultâneos (operações pesadas)
    lockDuration: 600000, // 10 min lock (lotes grandes demoram)
    stalledInterval: 600000,
  }
);

bulkOperationsWorker.on('completed', (job, result) => {
  blog.info({ jobId: job.id, result }, 'Bulk operation completed');
});

bulkOperationsWorker.on('failed', async (job, err) => {
  blog.error({ jobId: job?.id, error: err.message }, 'Bulk operation failed');
  if (job) {
    try {
      await deadLetterQueue.add('failed-bulk', {
        originalJob: job.data, error: err.message, failedAt: new Date().toISOString(),
      });
    } catch (dlqErr) {
      blog.error('Failed to add to DLQ', { error: dlqErr.message });
    }
  }
});

export async function closeBulkOperationsWorker() {
  blog.info('Closing bulk operations worker...');
  await bulkOperationsWorker.close();
}
