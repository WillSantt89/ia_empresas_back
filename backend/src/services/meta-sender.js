import { logger } from '../config/logger.js';
import { decrypt } from '../config/encryption.js';
import { pool } from '../config/database.js';

/**
 * Meta Sender (canal Meta Oficial)
 *
 * Envia mensagens via Graph API usando o access_token do próprio cliente
 * (armazenado criptografado em meta_business_accounts).
 *
 * Espelho funcional de whatsapp-sender.js, mas 100% baseado nas tabelas meta_*.
 */

const createLogger = logger.child({ module: 'meta-sender' });

const GRAPH_BASE = process.env.META_GRAPH_BASE_URL || 'https://graph.facebook.com';
const API_VERSION = process.env.META_API_VERSION || 'v21.0';
const GRAPH_URL = `${GRAPH_BASE}/${API_VERSION}`;

/**
 * Resolve token e phone_number_id a partir do meta_phone_id interno.
 */
async function resolveCredentials(metaPhoneId) {
  const result = await pool.query(
    `SELECT mpn.phone_number_id, wba.access_token_encrypted, wba.empresa_id
     FROM meta_phone_numbers mpn
     JOIN meta_business_accounts wba ON wba.id = mpn.meta_waba_id
     WHERE mpn.id = $1 AND mpn.ativo = true AND wba.ativo = true
     LIMIT 1`,
    [metaPhoneId]
  );
  if (result.rows.length === 0) {
    throw new Error(`meta_phone_id ${metaPhoneId} não encontrado ou inativo`);
  }
  const row = result.rows[0];
  return {
    phone_number_id: row.phone_number_id,
    token: decrypt(row.access_token_encrypted),
    empresa_id: row.empresa_id,
  };
}

async function postGraph(phoneNumberId, token, body) {
  const response = await fetch(`${GRAPH_URL}/${phoneNumberId}/messages`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const msg = data?.error?.message || `HTTP ${response.status}`;
    createLogger.error({ status: response.status, error: msg, phoneNumberId }, 'Meta API error');
    return { success: false, wamid: null, error: msg, raw: data };
  }
  return { success: true, wamid: data?.messages?.[0]?.id || null, raw: data };
}

export async function sendText({ metaPhoneId, to, text, contextMessageId = null }) {
  const { phone_number_id, token } = await resolveCredentials(metaPhoneId);
  const body = { messaging_product: 'whatsapp', to, type: 'text', text: { body: text } };
  if (contextMessageId) body.context = { message_id: contextMessageId };
  return postGraph(phone_number_id, token, body);
}

export async function sendTemplate({ metaPhoneId, to, templateName, language = 'pt_BR', components = [] }) {
  const { phone_number_id, token } = await resolveCredentials(metaPhoneId);
  const body = {
    messaging_product: 'whatsapp',
    to,
    type: 'template',
    template: { name: templateName, language: { code: language }, components },
  };
  return postGraph(phone_number_id, token, body);
}

export async function sendMedia({ metaPhoneId, to, mediaType, mediaId, caption = null, filename = null }) {
  const { phone_number_id, token } = await resolveCredentials(metaPhoneId);
  const allowed = ['image', 'video', 'audio', 'document', 'sticker'];
  if (!allowed.includes(mediaType)) {
    throw new Error(`mediaType inválido: ${mediaType}`);
  }
  const payload = { id: mediaId };
  if (caption && ['image', 'video', 'document'].includes(mediaType)) payload.caption = caption;
  if (filename && mediaType === 'document') payload.filename = filename;

  const body = { messaging_product: 'whatsapp', to, type: mediaType, [mediaType]: payload };
  return postGraph(phone_number_id, token, body);
}

/**
 * Upload de mídia para obter media_id do Meta (necessário antes do sendMedia).
 */
export async function uploadMedia({ metaPhoneId, buffer, mimeType, filename }) {
  const { phone_number_id, token } = await resolveCredentials(metaPhoneId);
  const form = new FormData();
  form.append('messaging_product', 'whatsapp');
  form.append('file', new Blob([buffer], { type: mimeType }), filename);

  const response = await fetch(`${GRAPH_URL}/${phone_number_id}/media`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}` },
    body: form,
    signal: AbortSignal.timeout(60000),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const msg = data?.error?.message || `HTTP ${response.status}`;
    return { success: false, media_id: null, error: msg };
  }
  return { success: true, media_id: data.id };
}

export async function markMessageRead({ metaPhoneId, wamid }) {
  const { phone_number_id, token } = await resolveCredentials(metaPhoneId);
  return postGraph(phone_number_id, token, {
    messaging_product: 'whatsapp',
    status: 'read',
    message_id: wamid,
  });
}
