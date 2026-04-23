import { pool } from '../config/database.js';
import { logger } from '../config/logger.js';
import { completeOnboarding } from '../services/meta-embedded-signup.js';
import {
  resumoConsumoAtual,
  recalcularFaturaMensal,
  getPrecificacaoEfetiva,
} from '../services/meta-billing.js';

/**
 * Rotas do canal Meta Oficial (Embedded Signup).
 * Prefixo: /api/meta
 *
 * Isolamento total do mundo whatsapp_numbers — não referencia nem depende
 * das tabelas/rotas do canal legado.
 */

export default async function metaOficialRoutes(fastify, opts) {
  const createLogger = logger.child({ module: 'route-meta-oficial' });

  // ============================================================
  // POST /api/meta/signup/complete — finaliza fluxo Embedded Signup
  // Body: { code, waba_id, phone_number_id, pin_2fa }
  // ============================================================
  fastify.post('/signup/complete', {
    preHandler: [
      fastify.authenticate,
      fastify.addTenantFilter,
      fastify.requirePermission('whatsapp_numbers', 'write'),
    ],
    schema: {
      body: {
        type: 'object',
        required: ['code', 'waba_id', 'phone_number_id', 'pin_2fa'],
        properties: {
          code: { type: 'string', minLength: 10 },
          waba_id: { type: 'string', minLength: 1 },
          phone_number_id: { type: 'string', minLength: 1 },
          pin_2fa: { type: 'string', pattern: '^[0-9]{6}$' },
        },
      },
    },
  }, async (request, reply) => {
    const { empresaId, user } = request;
    const { code, waba_id, phone_number_id, pin_2fa } = request.body;

    try {
      const data = await completeOnboarding({
        empresaId,
        usuarioId: user?.id || null,
        code,
        wabaId: waba_id,
        phoneNumberId: phone_number_id,
        pin2fa: pin_2fa,
      });
      return { success: true, data };
    } catch (error) {
      createLogger.error({ err: error, empresaId }, 'Signup Meta falhou');
      const code = error.code || 'META_SIGNUP_ERROR';
      const status = code === 'WABA_ALREADY_ONBOARDED' ? 409
        : code === 'INVALID_PIN' ? 400
        : code === 'REGISTER_FAILED' ? 422
        : 500;
      return reply.code(status).send({
        success: false,
        error: { code, message: error.message },
      });
    }
  });

  // ============================================================
  // GET /api/meta/conexoes — lista conexões da empresa
  // ============================================================
  fastify.get('/conexoes', {
    preHandler: [fastify.authenticate, fastify.addTenantFilter],
  }, async (request, reply) => {
    const { empresaId } = request;
    const result = await pool.query(
      `SELECT
         mpn.id, mpn.phone_number_id, mpn.display_phone_number, mpn.verified_name,
         mpn.quality_rating, mpn.messaging_limit_tier, mpn.registration_status,
         mpn.webhook_subscribed, mpn.registered_at, mpn.ativo,
         wba.id AS meta_waba_id, wba.waba_id, wba.nome AS waba_nome,
         wba.onboarding_status, wba.onboarded_at,
         u.nome AS onboarded_by
       FROM meta_phone_numbers mpn
       JOIN meta_business_accounts wba ON wba.id = mpn.meta_waba_id
       LEFT JOIN usuarios u ON u.id = wba.onboarded_by_usuario_id
       WHERE mpn.empresa_id = $1
       ORDER BY mpn.criado_em DESC`,
      [empresaId]
    );
    return { success: true, data: result.rows };
  });

  // ============================================================
  // GET /api/meta/conexoes/:id — detalhes de uma conexão
  // ============================================================
  fastify.get('/conexoes/:id', {
    preHandler: [fastify.authenticate, fastify.addTenantFilter],
    schema: {
      params: {
        type: 'object',
        required: ['id'],
        properties: { id: { type: 'string', format: 'uuid' } },
      },
    },
  }, async (request, reply) => {
    const { empresaId } = request;
    const { id } = request.params;
    const result = await pool.query(
      `SELECT mpn.*, wba.waba_id, wba.nome AS waba_nome, wba.currency, wba.timezone_id,
              wba.onboarding_status, wba.onboarded_at
       FROM meta_phone_numbers mpn
       JOIN meta_business_accounts wba ON wba.id = mpn.meta_waba_id
       WHERE mpn.id = $1 AND mpn.empresa_id = $2`,
      [id, empresaId]
    );
    if (result.rows.length === 0) {
      return reply.code(404).send({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Conexão não encontrada' },
      });
    }
    const row = result.rows[0];
    // Nunca expor token nem PIN
    delete row.access_token_encrypted;
    delete row.pin_2fa_encrypted;
    return { success: true, data: row };
  });

  // ============================================================
  // DELETE /api/meta/conexoes/:id — soft delete (marca inativo)
  // ============================================================
  fastify.delete('/conexoes/:id', {
    preHandler: [
      fastify.authenticate,
      fastify.addTenantFilter,
      fastify.requirePermission('whatsapp_numbers', 'write'),
    ],
    schema: {
      params: {
        type: 'object',
        required: ['id'],
        properties: { id: { type: 'string', format: 'uuid' } },
      },
    },
  }, async (request, reply) => {
    const { empresaId } = request;
    const { id } = request.params;
    const result = await pool.query(
      `UPDATE meta_phone_numbers SET ativo = false, atualizado_em = NOW()
       WHERE id = $1 AND empresa_id = $2 AND ativo = true
       RETURNING id`,
      [id, empresaId]
    );
    if (result.rows.length === 0) {
      return reply.code(404).send({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Conexão não encontrada ou já inativa' },
      });
    }
    return reply.code(204).send();
  });

  // ============================================================
  // GET /api/meta/consumo — resumo do ciclo corrente
  // ============================================================
  fastify.get('/consumo', {
    preHandler: [fastify.authenticate, fastify.addTenantFilter],
  }, async (request, reply) => {
    const { empresaId } = request;
    const resumo = await resumoConsumoAtual(empresaId);
    return { success: true, data: resumo };
  });

  // ============================================================
  // GET /api/meta/consumo/detalhado — tabela de conversas do ciclo
  // ============================================================
  fastify.get('/consumo/detalhado', {
    preHandler: [fastify.authenticate, fastify.addTenantFilter],
    schema: {
      querystring: {
        type: 'object',
        properties: {
          mes_ref: { type: 'string', pattern: '^\\d{4}-\\d{2}-01$' },
          category: { type: 'string' },
          page: { type: 'integer', minimum: 1, default: 1 },
          limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
        },
      },
    },
  }, async (request, reply) => {
    const { empresaId } = request;
    const { category, page = 1, limit = 50 } = request.query || {};
    const mesRef = request.query.mes_ref || new Date().toISOString().slice(0, 7) + '-01';
    const offset = (page - 1) * limit;

    const params = [empresaId, mesRef];
    let where = 'empresa_id = $1 AND ciclo_ref = $2';
    if (category) {
      params.push(category);
      where += ` AND category = $${params.length}`;
    }
    params.push(limit, offset);
    const result = await pool.query(
      `SELECT id, conversation_id, category, pricing_model, origin_type, billable,
              custo_usd, custo_brl, preco_cliente_brl, iniciada_em, expira_em
       FROM meta_conversas_consumo
       WHERE ${where}
       ORDER BY iniciada_em DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );
    return {
      success: true,
      data: result.rows,
      meta: { page, limit, mes_ref: mesRef },
    };
  });

  // ============================================================
  // GET /api/meta/faturas — lista faturas mensais da empresa
  // ============================================================
  fastify.get('/faturas', {
    preHandler: [fastify.authenticate, fastify.addTenantFilter],
  }, async (request, reply) => {
    const { empresaId } = request;
    const result = await pool.query(
      `SELECT * FROM meta_fatura_mensal WHERE empresa_id = $1 ORDER BY mes_ref DESC`,
      [empresaId]
    );
    return { success: true, data: result.rows };
  });

  // ============================================================
  // GET /api/meta/faturas/:mesRef — detalhe de fatura (recalc on demand)
  // ============================================================
  fastify.get('/faturas/:mesRef', {
    preHandler: [fastify.authenticate, fastify.addTenantFilter],
    schema: {
      params: {
        type: 'object',
        required: ['mesRef'],
        properties: { mesRef: { type: 'string', pattern: '^\\d{4}-\\d{2}-01$' } },
      },
    },
  }, async (request, reply) => {
    const { empresaId } = request;
    const fatura = await recalcularFaturaMensal({
      empresaId,
      mesRef: request.params.mesRef,
    });
    return { success: true, data: fatura };
  });

  // ============================================================
  // POST /api/meta/faturas/:mesRef/fechar — master fecha fatura
  // ============================================================
  fastify.post('/faturas/:mesRef/fechar', {
    preHandler: [fastify.authenticate, fastify.addTenantFilter],
    schema: {
      params: {
        type: 'object',
        required: ['mesRef'],
        properties: { mesRef: { type: 'string', pattern: '^\\d{4}-\\d{2}-01$' } },
      },
    },
  }, async (request, reply) => {
    const { user, empresaId } = request;
    if (user?.role !== 'master') {
      return reply.code(403).send({
        success: false,
        error: { code: 'FORBIDDEN', message: 'Apenas master pode fechar faturas' },
      });
    }
    await recalcularFaturaMensal({ empresaId, mesRef: request.params.mesRef });
    const result = await pool.query(
      `UPDATE meta_fatura_mensal SET status = 'fechada', fechada_em = NOW(), atualizado_em = NOW()
       WHERE empresa_id = $1 AND mes_ref = $2 AND status = 'aberta'
       RETURNING *`,
      [empresaId, request.params.mesRef]
    );
    if (result.rows.length === 0) {
      return reply.code(409).send({
        success: false,
        error: { code: 'ALREADY_CLOSED', message: 'Fatura já fechada ou inexistente' },
      });
    }
    return { success: true, data: result.rows[0] };
  });

  // ============================================================
  // GET /api/meta/precificacao — master visualiza configs globais + overrides
  // ============================================================
  fastify.get('/precificacao', {
    preHandler: [fastify.authenticate],
  }, async (request, reply) => {
    if (request.user?.role !== 'master') {
      return reply.code(403).send({
        success: false,
        error: { code: 'FORBIDDEN', message: 'Apenas master' },
      });
    }
    const result = await pool.query(
      `SELECT pc.*, e.nome AS empresa_nome
       FROM meta_precificacao_config pc
       LEFT JOIN empresas e ON e.id = pc.empresa_id
       ORDER BY pc.empresa_id NULLS FIRST, pc.vigencia_inicio DESC`
    );
    return { success: true, data: result.rows };
  });

  // ============================================================
  // GET /api/meta/precificacao/efetiva — config efetiva para empresa X
  // ============================================================
  fastify.get('/precificacao/efetiva', {
    preHandler: [fastify.authenticate, fastify.addTenantFilter],
  }, async (request, reply) => {
    const { empresaId } = request;
    const data = await getPrecificacaoEfetiva(empresaId);
    return { success: true, data };
  });

  // ============================================================
  // PUT /api/meta/precificacao — master cria/atualiza config
  //   Body: { empresa_id? (null = global), markup_percentual, taxa_cambio_fixa?,
  //           preco_marketing_brl?, preco_utility_brl?, preco_authentication_brl?, preco_service_brl? }
  // ============================================================
  fastify.put('/precificacao', {
    preHandler: [fastify.authenticate],
    schema: {
      body: {
        type: 'object',
        required: ['markup_percentual'],
        properties: {
          empresa_id: { type: ['string', 'null'], format: 'uuid' },
          markup_percentual: { type: 'number', minimum: 0, maximum: 1000 },
          taxa_cambio_fixa: { type: ['number', 'null'], minimum: 0 },
          preco_marketing_brl: { type: ['number', 'null'], minimum: 0 },
          preco_utility_brl: { type: ['number', 'null'], minimum: 0 },
          preco_authentication_brl: { type: ['number', 'null'], minimum: 0 },
          preco_service_brl: { type: ['number', 'null'], minimum: 0 },
        },
      },
    },
  }, async (request, reply) => {
    if (request.user?.role !== 'master') {
      return reply.code(403).send({
        success: false,
        error: { code: 'FORBIDDEN', message: 'Apenas master' },
      });
    }
    const b = request.body;
    const empresaId = b.empresa_id || null;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // Desativa a config ativa anterior (global ou da empresa)
      if (empresaId) {
        await client.query(
          `UPDATE meta_precificacao_config SET ativo = false, atualizado_em = NOW()
           WHERE empresa_id = $1 AND ativo = true`,
          [empresaId]
        );
      } else {
        await client.query(
          `UPDATE meta_precificacao_config SET ativo = false, atualizado_em = NOW()
           WHERE empresa_id IS NULL AND ativo = true`
        );
      }
      const insert = await client.query(
        `INSERT INTO meta_precificacao_config (
           empresa_id, markup_percentual, taxa_cambio_fixa,
           preco_marketing_brl, preco_utility_brl, preco_authentication_brl, preco_service_brl
         ) VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING *`,
        [
          empresaId,
          b.markup_percentual,
          b.taxa_cambio_fixa ?? null,
          b.preco_marketing_brl ?? null,
          b.preco_utility_brl ?? null,
          b.preco_authentication_brl ?? null,
          b.preco_service_brl ?? null,
        ]
      );
      await client.query('COMMIT');
      return { success: true, data: insert.rows[0] };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  });
}
