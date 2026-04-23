import { logger } from '../config/logger.js';
import { encrypt } from '../config/encryption.js';
import { pool } from '../config/database.js';

/**
 * Meta Embedded Signup Service
 *
 * Responsável pelo onboarding de WABAs de clientes via Facebook Login for Business.
 * Troca o code retornado pelo popup por um access_token permanente, busca detalhes
 * da WABA e do phone_number, registra o número na Cloud API e assina o webhook.
 *
 * Não depende de whatsapp_numbers (legado) — opera exclusivamente nas tabelas meta_*.
 */

const createLogger = logger.child({ module: 'meta-embedded-signup' });

const GRAPH_BASE = process.env.META_GRAPH_BASE_URL || 'https://graph.facebook.com';
const API_VERSION = process.env.META_API_VERSION || 'v21.0';
const GRAPH_URL = `${GRAPH_BASE}/${API_VERSION}`;

function getConfigOrThrow() {
  const appId = process.env.META_APP_ID;
  const appSecret = process.env.META_APP_SECRET;
  if (!appId || !appSecret) {
    throw new Error('META_APP_ID ou META_APP_SECRET não configurados');
  }
  return { appId, appSecret };
}

async function fetchGraph(url, { method = 'GET', token, body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const response = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20000),
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const msg = data?.error?.message || `HTTP ${response.status}`;
    const err = new Error(msg);
    err.code = data?.error?.code || 'META_API_ERROR';
    err.subcode = data?.error?.error_subcode;
    err.status = response.status;
    err.raw = data;
    throw err;
  }
  return data;
}

/**
 * Troca o code (retornado pelo Embedded Signup) por um access_token permanente.
 */
export async function exchangeCodeForToken(code) {
  const { appId, appSecret } = getConfigOrThrow();
  const url = `${GRAPH_URL}/oauth/access_token?` + new URLSearchParams({
    client_id: appId,
    client_secret: appSecret,
    code,
  }).toString();

  const data = await fetchGraph(url);
  if (!data.access_token) {
    throw new Error('access_token não retornado pela Meta');
  }
  return {
    accessToken: data.access_token,
    tokenType: data.token_type,
    expiresIn: data.expires_in ?? null,
  };
}

/**
 * Busca metadados da WABA (WhatsApp Business Account).
 */
export async function fetchWabaDetails(wabaId, token) {
  const fields = 'id,name,currency,timezone_id,message_template_namespace';
  return fetchGraph(`${GRAPH_URL}/${wabaId}?fields=${fields}`, { token });
}

/**
 * Busca metadados de um phone_number dentro de uma WABA.
 */
export async function fetchPhoneDetails(phoneNumberId, token) {
  const fields = 'id,display_phone_number,verified_name,quality_rating,code_verification_status,messaging_limit_tier';
  return fetchGraph(`${GRAPH_URL}/${phoneNumberId}?fields=${fields}`, { token });
}

/**
 * Assina o app da wschat aos eventos da WABA do cliente.
 */
export async function subscribeAppToWaba(wabaId, token) {
  return fetchGraph(`${GRAPH_URL}/${wabaId}/subscribed_apps`, {
    method: 'POST',
    token,
  });
}

/**
 * Registra um número de telefone no Cloud API (2FA PIN).
 * PIN é obrigatório e fornecido pelo cliente via modal no frontend.
 */
export async function registerPhoneNumber(phoneNumberId, token, pin) {
  if (!pin || !/^\d{6}$/.test(String(pin))) {
    const err = new Error('PIN 2FA inválido — precisa ter 6 dígitos');
    err.code = 'INVALID_PIN';
    throw err;
  }
  return fetchGraph(`${GRAPH_URL}/${phoneNumberId}/register`, {
    method: 'POST',
    token,
    body: { messaging_product: 'whatsapp', pin: String(pin) },
  });
}

async function registerAudit(client, empresaId, usuarioId, eventType, payload, errorMessage = null) {
  await client.query(
    `INSERT INTO meta_signup_audit_log (empresa_id, usuario_id, event_type, event_payload, error_message)
     VALUES ($1, $2, $3, $4::jsonb, $5)`,
    [empresaId, usuarioId, eventType, JSON.stringify(payload || {}), errorMessage]
  );
}

/**
 * Orquestra o fluxo completo:
 *  1) Troca code → access_token permanente
 *  2) Busca detalhes da WABA e do phone_number
 *  3) Registra número (com PIN) no Cloud API
 *  4) Assina o app aos eventos da WABA
 *  5) Persiste em meta_business_accounts + meta_phone_numbers
 *  6) Escreve audit log
 *
 * Retorna o registro persistido.
 */
export async function completeOnboarding({ empresaId, usuarioId, code, wabaId, phoneNumberId, pin2fa }) {
  if (!empresaId || !code || !wabaId || !phoneNumberId || !pin2fa) {
    throw new Error('empresa_id, code, waba_id, phone_number_id e pin_2fa são obrigatórios');
  }

  const client = await pool.connect();
  let accessToken = null;

  try {
    await client.query('BEGIN');
    await registerAudit(client, empresaId, usuarioId, 'onboarding_start', { waba_id: wabaId, phone_number_id: phoneNumberId });

    // Verifica duplicidade — WABA ou número já cadastrados
    const dup = await client.query(
      `SELECT wba.empresa_id FROM meta_business_accounts wba
       WHERE wba.waba_id = $1
       UNION ALL
       SELECT mpn.empresa_id FROM meta_phone_numbers mpn
       WHERE mpn.phone_number_id = $2
       LIMIT 1`,
      [wabaId, phoneNumberId]
    );
    if (dup.rows.length > 0) {
      const otherEmpresa = dup.rows[0].empresa_id;
      const err = new Error(
        otherEmpresa === empresaId
          ? 'WABA ou número já conectado para esta empresa'
          : 'WABA ou número já vinculados a outra empresa'
      );
      err.code = 'WABA_ALREADY_ONBOARDED';
      throw err;
    }

    // 1. Trocar code por token
    const tokenResp = await exchangeCodeForToken(code);
    accessToken = tokenResp.accessToken;
    await registerAudit(client, empresaId, usuarioId, 'token_exchanged', { expires_in: tokenResp.expiresIn });

    // 2. Buscar detalhes (em paralelo)
    const [waba, phone] = await Promise.all([
      fetchWabaDetails(wabaId, accessToken),
      fetchPhoneDetails(phoneNumberId, accessToken),
    ]);
    await registerAudit(client, empresaId, usuarioId, 'details_fetched', { waba, phone });

    // 3. Registrar número com PIN
    try {
      await registerPhoneNumber(phoneNumberId, accessToken, pin2fa);
      await registerAudit(client, empresaId, usuarioId, 'phone_registered', { phone_number_id: phoneNumberId });
    } catch (e) {
      await registerAudit(client, empresaId, usuarioId, 'phone_register_failed', { phone_number_id: phoneNumberId }, e.message);
      const err = new Error(`Falha ao registrar número: ${e.message}`);
      err.code = 'REGISTER_FAILED';
      throw err;
    }

    // 4. Subscribe app aos eventos da WABA
    try {
      await subscribeAppToWaba(wabaId, accessToken);
      await registerAudit(client, empresaId, usuarioId, 'app_subscribed', { waba_id: wabaId });
    } catch (e) {
      await registerAudit(client, empresaId, usuarioId, 'app_subscribe_failed', { waba_id: wabaId }, e.message);
      throw e;
    }

    // 5. Persistir WABA
    const tokenEncrypted = encrypt(accessToken);
    const pinEncrypted = encrypt(String(pin2fa));

    const wabaRes = await client.query(
      `INSERT INTO meta_business_accounts (
         empresa_id, waba_id, nome, currency, timezone_id, message_template_namespace,
         access_token_encrypted, onboarding_status, onboarded_at, onboarded_by_usuario_id, meta_raw_payload
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'active', NOW(), $8, $9::jsonb)
       ON CONFLICT (waba_id) DO UPDATE SET
         nome = EXCLUDED.nome,
         currency = EXCLUDED.currency,
         timezone_id = EXCLUDED.timezone_id,
         message_template_namespace = EXCLUDED.message_template_namespace,
         access_token_encrypted = EXCLUDED.access_token_encrypted,
         onboarding_status = 'active',
         onboarded_at = NOW(),
         onboarded_by_usuario_id = EXCLUDED.onboarded_by_usuario_id,
         meta_raw_payload = EXCLUDED.meta_raw_payload,
         atualizado_em = NOW()
       RETURNING id`,
      [
        empresaId,
        wabaId,
        waba.name || null,
        waba.currency || null,
        waba.timezone_id || null,
        waba.message_template_namespace || null,
        tokenEncrypted,
        usuarioId,
        JSON.stringify(waba),
      ]
    );
    const metaWabaId = wabaRes.rows[0].id;

    // 6. Persistir phone number
    const phoneRes = await client.query(
      `INSERT INTO meta_phone_numbers (
         meta_waba_id, empresa_id, phone_number_id, display_phone_number, verified_name,
         quality_rating, messaging_limit_tier, code_verification_status,
         registration_status, registered_at, webhook_subscribed, pin_2fa_encrypted, meta_raw_payload
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'registered', NOW(), true, $9, $10::jsonb)
       ON CONFLICT (phone_number_id) DO UPDATE SET
         meta_waba_id = EXCLUDED.meta_waba_id,
         empresa_id = EXCLUDED.empresa_id,
         display_phone_number = EXCLUDED.display_phone_number,
         verified_name = EXCLUDED.verified_name,
         quality_rating = EXCLUDED.quality_rating,
         messaging_limit_tier = EXCLUDED.messaging_limit_tier,
         code_verification_status = EXCLUDED.code_verification_status,
         registration_status = 'registered',
         registered_at = NOW(),
         webhook_subscribed = true,
         pin_2fa_encrypted = EXCLUDED.pin_2fa_encrypted,
         meta_raw_payload = EXCLUDED.meta_raw_payload,
         atualizado_em = NOW()
       RETURNING id, display_phone_number, verified_name`,
      [
        metaWabaId,
        empresaId,
        phoneNumberId,
        phone.display_phone_number || null,
        phone.verified_name || null,
        phone.quality_rating || null,
        phone.messaging_limit_tier || null,
        phone.code_verification_status || null,
        pinEncrypted,
        JSON.stringify(phone),
      ]
    );

    await registerAudit(client, empresaId, usuarioId, 'onboarding_complete', {
      meta_waba_id: metaWabaId,
      meta_phone_id: phoneRes.rows[0].id,
    });

    await client.query('COMMIT');

    createLogger.info({
      empresaId,
      wabaId,
      phoneNumberId,
      metaWabaId,
    }, 'Embedded Signup concluído com sucesso');

    return {
      meta_waba_id: metaWabaId,
      meta_phone_id: phoneRes.rows[0].id,
      waba_id: wabaId,
      phone_number_id: phoneNumberId,
      display_phone_number: phoneRes.rows[0].display_phone_number,
      verified_name: phoneRes.rows[0].verified_name,
      status: 'active',
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    // Audit de erro em transação isolada (fora do rollback)
    try {
      await pool.query(
        `INSERT INTO meta_signup_audit_log (empresa_id, usuario_id, event_type, event_payload, error_message)
         VALUES ($1, $2, 'onboarding_error', $3::jsonb, $4)`,
        [empresaId, usuarioId, JSON.stringify({ waba_id: wabaId, phone_number_id: phoneNumberId }), error.message]
      );
    } catch { /* ignore audit failure */ }
    createLogger.error({ err: error, empresaId, wabaId, phoneNumberId }, 'Embedded Signup falhou');
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Retorna o access_token descriptografado de uma WABA (uso interno do backend).
 */
export async function getDecryptedTokenByPhoneId(phoneNumberId) {
  const { decrypt } = await import('../config/encryption.js');
  const result = await pool.query(
    `SELECT wba.access_token_encrypted, wba.empresa_id, wba.id as meta_waba_id, mpn.id as meta_phone_id
     FROM meta_phone_numbers mpn
     JOIN meta_business_accounts wba ON wba.id = mpn.meta_waba_id
     WHERE mpn.phone_number_id = $1 AND mpn.ativo = true AND wba.ativo = true
     LIMIT 1`,
    [phoneNumberId]
  );
  if (result.rows.length === 0) return null;
  const row = result.rows[0];
  return {
    token: decrypt(row.access_token_encrypted),
    empresa_id: row.empresa_id,
    meta_waba_id: row.meta_waba_id,
    meta_phone_id: row.meta_phone_id,
  };
}
