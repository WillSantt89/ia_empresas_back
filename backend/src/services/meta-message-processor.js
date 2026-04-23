import { logger } from '../config/logger.js';
import { pool } from '../config/database.js';
import { sendText, markMessageRead } from './meta-sender.js';
import { registrarConsumoConversa } from './meta-billing.js';
import { consumirCredito } from './creditos-ia.js';

/**
 * Meta Message Processor
 *
 * Processador dedicado ao canal Meta Oficial. Reaproveita os helpers
 * compartilhados (créditos IA, Gemini, memória, filas) porém mantém
 * ciclo de vida, logs e sender próprios — 100% isolado de whatsapp_numbers.
 *
 * Ordem do processamento:
 *  1. Resolve meta_phone_number_id → meta_waba_id → empresa_id
 *  2. Persiste inbound em meta_mensagens_log
 *  3. Marca como lido (Meta)
 *  4. Consome 1 crédito IA (mesmo pool) — se zerado, devolve pra fila humana
 *  5. (Stub) Integração com pipeline de IA: chama serviço central passando
 *     sender = meta-sender. Delegação implementada em iteração seguinte.
 *  6. Persiste outbound em meta_mensagens_log
 */

const createLogger = logger.child({ module: 'meta-message-processor' });

/**
 * Resolve contexto empresa/waba a partir do phone_number_id externo.
 */
async function resolveContext(phoneNumberId) {
  const result = await pool.query(
    `SELECT mpn.id AS meta_phone_id, mpn.empresa_id, mpn.meta_waba_id, mpn.display_phone_number,
            wba.id AS waba_row_id
     FROM meta_phone_numbers mpn
     JOIN meta_business_accounts wba ON wba.id = mpn.meta_waba_id
     WHERE mpn.phone_number_id = $1 AND mpn.ativo = true AND wba.ativo = true
     LIMIT 1`,
    [phoneNumberId]
  );
  if (result.rows.length === 0) return null;
  return result.rows[0];
}

async function logInbound(ctx, message) {
  const tipo = message.type;
  let conteudo = null;
  let midiaUrl = null;
  let midiaMime = null;

  if (tipo === 'text') {
    conteudo = message.text?.body || null;
  } else if (['image', 'video', 'audio', 'document', 'sticker'].includes(tipo)) {
    midiaMime = message[tipo]?.mime_type || null;
    midiaUrl = message[tipo]?.id || null;
    conteudo = message[tipo]?.caption || null;
  } else if (tipo === 'interactive') {
    conteudo = JSON.stringify(message.interactive || {});
  } else if (tipo === 'button') {
    conteudo = message.button?.text || null;
  } else if (tipo === 'location') {
    conteudo = JSON.stringify(message.location || {});
  } else {
    conteudo = JSON.stringify(message);
  }

  await pool.query(
    `INSERT INTO meta_mensagens_log (
       empresa_id, meta_phone_number_id, wamid, direcao, tipo, de, para,
       conteudo, midia_url, midia_mime_type, status, enviada_em, raw_payload
     ) VALUES ($1, $2, $3, 'in', $4, $5, $6, $7, $8, $9, 'delivered', NOW(), $10::jsonb)
     ON CONFLICT (wamid) DO NOTHING`,
    [
      ctx.empresa_id,
      ctx.meta_phone_id,
      message.id,
      tipo,
      message.from,
      ctx.display_phone_number,
      conteudo,
      midiaUrl,
      midiaMime,
      JSON.stringify(message),
    ]
  );
}

async function logOutbound(ctx, { to, tipo, conteudo, wamid, templateName = null, raw = null }) {
  await pool.query(
    `INSERT INTO meta_mensagens_log (
       empresa_id, meta_phone_number_id, wamid, direcao, tipo, de, para,
       conteudo, template_name, status, enviada_em, raw_payload
     ) VALUES ($1, $2, $3, 'out', $4, $5, $6, $7, $8, 'sent', NOW(), $9::jsonb)
     ON CONFLICT (wamid) DO NOTHING`,
    [
      ctx.empresa_id,
      ctx.meta_phone_id,
      wamid,
      tipo,
      ctx.display_phone_number,
      to,
      conteudo,
      templateName,
      raw ? JSON.stringify(raw) : null,
    ]
  );
}

/**
 * Processa uma mensagem única vinda do webhook Meta.
 */
export async function processMetaMessage({ phoneNumberId, message, contacts = [] }) {
  const ctx = await resolveContext(phoneNumberId);
  if (!ctx) {
    createLogger.warn({ phoneNumberId }, 'phone_number_id não encontrado em meta_phone_numbers');
    return { ok: false, reason: 'phone_not_found' };
  }

  const from = message.from;
  const wamid = message.id;

  try {
    await logInbound(ctx, message);
  } catch (err) {
    createLogger.error({ err, wamid }, 'Falha ao logar mensagem inbound');
  }

  // Marca como lido (best effort)
  markMessageRead({ metaPhoneId: ctx.meta_phone_id, wamid }).catch(() => {});

  // Consome crédito IA (pool compartilhado com canal legado)
  const credito = await consumirCredito(ctx.empresa_id, 'meta_oficial').catch(err => {
    createLogger.warn({ err: err.message, empresa_id: ctx.empresa_id }, 'Falha ao consumir crédito IA');
    return { consumido: false };
  });

  if (!credito?.consumido) {
    createLogger.info({ empresa_id: ctx.empresa_id, fonte: credito?.fonte }, 'Sem créditos IA — mensagem fica para fila humana');
    return { ok: true, deferred: true, reason: 'no_credit' };
  }

  // TODO(iteração 2): integrar com pipeline Gemini/memory/tool-runner.
  // Plano: chamar um helper centralizado `runAiPipeline({ empresa_id, phone, text, channel: 'meta' })`
  // que retorna `{ reply, transfer, tool_results }`. Aqui apenas envia um eco placeholder
  // para deixar o fluxo E2E funcional antes da integração completa com Gemini.
  const text = message.type === 'text' ? (message.text?.body || '') : '';
  if (!text) {
    createLogger.info({ wamid, type: message.type }, 'Mensagem não-texto ainda não tratada pelo canal Meta');
    return { ok: true, deferred: true, reason: 'unsupported_type' };
  }

  const placeholder = `Recebemos sua mensagem: "${text}".\nEm breve um atendente responderá.`;
  const sendResult = await sendText({
    metaPhoneId: ctx.meta_phone_id,
    to: from,
    text: placeholder,
  });

  if (sendResult.success && sendResult.wamid) {
    await logOutbound(ctx, {
      to: from,
      tipo: 'text',
      conteudo: placeholder,
      wamid: sendResult.wamid,
      raw: sendResult.raw,
    }).catch(err => createLogger.error({ err }, 'Falha ao logar outbound'));
  } else {
    createLogger.error({ error: sendResult.error, empresa_id: ctx.empresa_id, to: from }, 'Envio Meta falhou');
  }

  return { ok: true, sent: sendResult.success, wamid: sendResult.wamid };
}

/**
 * Processa um array de eventos `statuses` (delivery, read, pricing).
 * Extrai consumo pra billing e atualiza estado das mensagens.
 */
export async function processMetaStatuses({ phoneNumberId, statuses = [] }) {
  if (!Array.isArray(statuses) || statuses.length === 0) return;
  const ctx = await resolveContext(phoneNumberId);
  if (!ctx) return;

  for (const st of statuses) {
    try {
      // Atualiza status da mensagem local
      const statusMap = { sent: 'sent', delivered: 'delivered', read: 'read', failed: 'failed' };
      const localStatus = statusMap[st.status] || null;
      if (localStatus && st.id) {
        const col = st.status === 'delivered' ? 'entregue_em' : st.status === 'read' ? 'lida_em' : st.status === 'failed' ? 'falhou_em' : null;
        const errCode = st.errors?.[0]?.code || null;
        const errMsg = st.errors?.[0]?.message || null;
        await pool.query(
          `UPDATE meta_mensagens_log
           SET status = $1
             ${col ? `, ${col} = NOW()` : ''}
             ${errCode ? ', erro_code = $4, erro_message = $5' : ''}
           WHERE wamid = $2 AND empresa_id = $3`,
          errCode
            ? [localStatus, st.id, ctx.empresa_id, String(errCode), errMsg]
            : [localStatus, st.id, ctx.empresa_id]
        );
      }

      // Billing: qualquer status com `pricing` registra/atualiza a conversa
      if (st.pricing && st.conversation?.id) {
        await registrarConsumoConversa({
          empresaId: ctx.empresa_id,
          metaWabaId: ctx.waba_row_id,
          metaPhoneId: ctx.meta_phone_id,
          phoneNumberId,
          statusEvent: st,
        });
      }
    } catch (err) {
      createLogger.error({ err, statusId: st.id }, 'Falha ao processar status Meta');
    }
  }
}
