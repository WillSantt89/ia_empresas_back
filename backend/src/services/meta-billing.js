import { logger } from '../config/logger.js';
import { pool } from '../config/database.js';
import { redis } from '../config/redis.js';

/**
 * Meta Billing Service
 *
 * - Captura eventos `statuses[*].pricing` do webhook da Meta
 * - Converte USD → BRL via câmbio em tempo real (cacheado em Redis)
 * - Aplica precificação híbrida: default global + override por empresa
 *   + fallback de override por categoria em BRL
 * - Persiste em meta_conversas_consumo
 * - Fecha fatura mensal agregada em meta_fatura_mensal
 */

const createLogger = logger.child({ module: 'meta-billing' });

const CAMBIO_CACHE_TTL = 60 * 60; // 1h
const CAMBIO_CACHE_KEY = 'meta:cambio:usd_brl';

/**
 * Busca cotação USD/BRL. Source: awesomeapi (gratuita, sem key).
 * Cache 1h no Redis.
 */
export async function getCotacaoUsdBrl() {
  const cached = await redis.get(CAMBIO_CACHE_KEY);
  if (cached) {
    const parsed = parseFloat(cached);
    if (!isNaN(parsed) && parsed > 0) return parsed;
  }

  try {
    const resp = await fetch('https://economia.awesomeapi.com.br/last/USD-BRL', {
      signal: AbortSignal.timeout(5000),
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    const bid = parseFloat(data?.USDBRL?.bid);
    if (!isNaN(bid) && bid > 0) {
      await redis.set(CAMBIO_CACHE_KEY, String(bid), 'EX', CAMBIO_CACHE_TTL);
      return bid;
    }
    throw new Error('cotação inválida');
  } catch (err) {
    createLogger.warn({ err: err.message }, 'Falha ao buscar cotação USD/BRL, usando fallback 5.00');
    return 5.00;
  }
}

/**
 * Resolve config de precificação efetiva (override empresa ou default global).
 */
export async function getPrecificacaoEfetiva(empresaId) {
  const result = await pool.query(
    `SELECT * FROM meta_precificacao_config
     WHERE ativo = true
       AND vigencia_inicio <= CURRENT_DATE
       AND (vigencia_fim IS NULL OR vigencia_fim >= CURRENT_DATE)
       AND (empresa_id = $1 OR empresa_id IS NULL)
     ORDER BY empresa_id NULLS LAST
     LIMIT 1`,
    [empresaId]
  );
  if (result.rows.length === 0) {
    return {
      markup_percentual: 50,
      taxa_cambio_fixa: null,
      preco_marketing_brl: null,
      preco_utility_brl: null,
      preco_authentication_brl: null,
      preco_service_brl: null,
    };
  }
  return result.rows[0];
}

function precoCategoriaOverride(config, category) {
  switch (category) {
    case 'marketing': return config.preco_marketing_brl;
    case 'utility': return config.preco_utility_brl;
    case 'authentication': return config.preco_authentication_brl;
    case 'service': return config.preco_service_brl;
    default: return null;
  }
}

/**
 * Calcula preço final BRL a cobrar do cliente para uma conversa.
 */
export async function calcularPrecoCliente({ empresaId, custoUsd, category }) {
  const config = await getPrecificacaoEfetiva(empresaId);
  const overrideBrl = precoCategoriaOverride(config, category);

  const taxaCambio = config.taxa_cambio_fixa
    ? parseFloat(config.taxa_cambio_fixa)
    : await getCotacaoUsdBrl();

  const custoBrl = Number(custoUsd) * Number(taxaCambio);

  let precoCliente;
  if (overrideBrl !== null && overrideBrl !== undefined) {
    precoCliente = parseFloat(overrideBrl);
  } else {
    const markup = Number(config.markup_percentual) / 100;
    precoCliente = custoBrl * (1 + markup);
  }

  return {
    custo_brl: Number(custoBrl.toFixed(4)),
    preco_cliente_brl: Number(precoCliente.toFixed(4)),
    taxa_cambio_snapshot: Number(taxaCambio.toFixed(4)),
    markup_aplicado: Number(config.markup_percentual),
    usou_override: overrideBrl !== null && overrideBrl !== undefined,
  };
}

/**
 * Registra consumo de uma conversa a partir do payload `statuses.pricing` da Meta.
 * O evento pode chegar múltiplas vezes pra mesma conversation_id — usamos UPSERT
 * por conversation_id (já é UNIQUE).
 *
 * Meta fields relevantes no payload `statuses[i]`:
 *   - conversation.id
 *   - conversation.origin.type (business_initiated/user_initiated/referral_conversion)
 *   - pricing.category
 *   - pricing.pricing_model (CBP/PMP)
 *   - pricing.billable
 */
export async function registrarConsumoConversa({ empresaId, metaWabaId, metaPhoneId, statusEvent, phoneNumberId }) {
  const conversationId = statusEvent?.conversation?.id;
  const pricing = statusEvent?.pricing;
  if (!conversationId || !pricing) return null;

  const category = pricing.category || 'service';
  const billable = Boolean(pricing.billable ?? true);
  const pricingModel = pricing.pricing_model || null;
  const originType = statusEvent?.conversation?.origin?.type || null;
  const expiration = statusEvent?.conversation?.expiration_timestamp;
  const expiraEm = expiration ? new Date(Number(expiration) * 1000) : null;

  // Meta não retorna o custo numérico direto no webhook de statuses.
  // Usamos uma tabela de preços base por categoria (USD) definida nas env vars
  // ou valores default da documentação pública da Meta para Brasil.
  // Estes valores são ajustáveis no master via meta_precificacao_config.preco_*_brl
  // (override em BRL) ou por ajuste manual do custo após reconciliação mensal.
  const CUSTO_USD_BASE_POR_CATEGORIA = {
    marketing: parseFloat(process.env.META_CUSTO_MARKETING_USD || '0.0625'),
    utility: parseFloat(process.env.META_CUSTO_UTILITY_USD || '0.014'),
    authentication: parseFloat(process.env.META_CUSTO_AUTHENTICATION_USD || '0.0315'),
    service: parseFloat(process.env.META_CUSTO_SERVICE_USD || '0'),
    referral_conversion: parseFloat(process.env.META_CUSTO_REFERRAL_USD || '0'),
  };
  const custoUsd = billable ? (CUSTO_USD_BASE_POR_CATEGORIA[category] ?? 0) : 0;

  const precos = await calcularPrecoCliente({ empresaId, custoUsd, category });

  const iniciadaEm = new Date();
  const cicloRef = new Date(iniciadaEm.getFullYear(), iniciadaEm.getMonth(), 1)
    .toISOString().slice(0, 10);

  await pool.query(
    `INSERT INTO meta_conversas_consumo (
       empresa_id, meta_waba_id, meta_phone_number_id, conversation_id, category,
       pricing_model, origin_type, billable, custo_usd, taxa_cambio_snapshot,
       custo_brl, markup_aplicado, preco_cliente_brl,
       iniciada_em, expira_em, ciclo_ref, raw_payload
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17::jsonb)
     ON CONFLICT (conversation_id) DO UPDATE SET
       category = EXCLUDED.category,
       pricing_model = EXCLUDED.pricing_model,
       origin_type = EXCLUDED.origin_type,
       billable = EXCLUDED.billable,
       expira_em = COALESCE(EXCLUDED.expira_em, meta_conversas_consumo.expira_em),
       raw_payload = EXCLUDED.raw_payload,
       atualizado_em = NOW()
    `,
    [
      empresaId, metaWabaId, metaPhoneId, conversationId, category,
      pricingModel, originType, billable, custoUsd, precos.taxa_cambio_snapshot,
      precos.custo_brl, precos.markup_aplicado, precos.preco_cliente_brl,
      iniciadaEm, expiraEm, cicloRef, JSON.stringify(statusEvent),
    ]
  );

  createLogger.info({
    empresaId,
    conversationId,
    category,
    billable,
    custo_usd: custoUsd,
    custo_brl: precos.custo_brl,
    preco_cliente_brl: precos.preco_cliente_brl,
  }, 'Consumo registrado');

  return { conversation_id: conversationId, category, ...precos };
}

/**
 * Recalcula e faz upsert da fatura mensal agregada de uma empresa.
 * Roda ao final do ciclo ou quando master consulta/fecha manualmente.
 */
export async function recalcularFaturaMensal({ empresaId, mesRef }) {
  const result = await pool.query(
    `SELECT
       COUNT(*) AS total,
       COUNT(*) FILTER (WHERE billable) AS billable,
       COUNT(*) FILTER (WHERE category = 'marketing' AND billable) AS marketing,
       COUNT(*) FILTER (WHERE category = 'utility' AND billable) AS utility,
       COUNT(*) FILTER (WHERE category = 'authentication' AND billable) AS authentication,
       COUNT(*) FILTER (WHERE category = 'service' AND billable) AS service,
       COALESCE(SUM(custo_usd) FILTER (WHERE billable), 0) AS total_usd,
       COALESCE(SUM(custo_brl) FILTER (WHERE billable), 0) AS total_custo_brl,
       COALESCE(SUM(preco_cliente_brl) FILTER (WHERE billable), 0) AS total_preco_brl
     FROM meta_conversas_consumo
     WHERE empresa_id = $1 AND ciclo_ref = $2`,
    [empresaId, mesRef]
  );

  const row = result.rows[0];
  const upsert = await pool.query(
    `INSERT INTO meta_fatura_mensal (
       empresa_id, mes_ref, total_conversas, total_billable,
       qtd_marketing, qtd_utility, qtd_authentication, qtd_service,
       total_custo_usd, total_custo_brl, total_preco_cliente_brl
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     ON CONFLICT (empresa_id, mes_ref) DO UPDATE SET
       total_conversas = EXCLUDED.total_conversas,
       total_billable = EXCLUDED.total_billable,
       qtd_marketing = EXCLUDED.qtd_marketing,
       qtd_utility = EXCLUDED.qtd_utility,
       qtd_authentication = EXCLUDED.qtd_authentication,
       qtd_service = EXCLUDED.qtd_service,
       total_custo_usd = EXCLUDED.total_custo_usd,
       total_custo_brl = EXCLUDED.total_custo_brl,
       total_preco_cliente_brl = EXCLUDED.total_preco_cliente_brl,
       atualizado_em = NOW()
     RETURNING *`,
    [
      empresaId, mesRef, row.total, row.billable,
      row.marketing, row.utility, row.authentication, row.service,
      row.total_usd, row.total_custo_brl, row.total_preco_brl,
    ]
  );
  return upsert.rows[0];
}

/**
 * Resumo consolidado do consumo da empresa no ciclo corrente.
 */
export async function resumoConsumoAtual(empresaId) {
  const mesRef = new Date().toISOString().slice(0, 7) + '-01';
  const result = await pool.query(
    `SELECT
       COUNT(*) AS total,
       COUNT(*) FILTER (WHERE billable) AS billable,
       COALESCE(SUM(custo_usd) FILTER (WHERE billable), 0) AS total_usd,
       COALESCE(SUM(custo_brl) FILTER (WHERE billable), 0) AS total_brl,
       COALESCE(SUM(preco_cliente_brl) FILTER (WHERE billable), 0) AS preco_cliente,
       jsonb_object_agg(category, qtd) FILTER (WHERE category IS NOT NULL) AS por_categoria
     FROM (
       SELECT billable, custo_usd, custo_brl, preco_cliente_brl, category,
              COUNT(*) OVER (PARTITION BY category) AS qtd
       FROM meta_conversas_consumo
       WHERE empresa_id = $1 AND ciclo_ref = $2
     ) sub`,
    [empresaId, mesRef]
  );
  return { mes_ref: mesRef, ...result.rows[0] };
}
