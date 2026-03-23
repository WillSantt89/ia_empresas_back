import { pool } from '../config/database.js';
import { logger } from '../config/logger.js';

const DEFAULT_RETRIES = [
  { numero: 1, intervalo_minutos: 5, tipo: 'fixo', mensagem_fixa: 'Oi! Ainda está por aí? 😊' },
  { numero: 2, intervalo_minutos: 15, tipo: 'fixo', mensagem_fixa: 'Estou aqui caso precise de ajuda!' },
  { numero: 3, intervalo_minutos: 30, tipo: 'ia', mensagem_fixa: null },
];

const retrySchema = {
  type: 'array',
  minItems: 1,
  maxItems: 5,
  items: {
    type: 'object',
    required: ['numero', 'intervalo_minutos', 'tipo'],
    properties: {
      numero: { type: 'integer', minimum: 1, maximum: 5 },
      intervalo_minutos: { type: 'integer', minimum: 1, maximum: 1440 },
      tipo: { type: 'string', enum: ['fixo', 'ia'] },
      mensagem_fixa: { type: ['string', 'null'], maxLength: 1000 },
    }
  }
};

function validateRetries(retries, reply) {
  if (!retries) return true;
  const soma = retries.reduce((acc, r) => acc + r.intervalo_minutos, 0);
  if (soma > 1440) {
    reply.code(400).send({ success: false, error: { message: 'Soma dos intervalos não pode ultrapassar 24h (1440 min)' } });
    return false;
  }
  for (const retry of retries) {
    if (retry.tipo === 'fixo' && (!retry.mensagem_fixa || retry.mensagem_fixa.trim() === '')) {
      reply.code(400).send({ success: false, error: { message: `Retry #${retry.numero}: mensagem fixa é obrigatória para tipo "fixo"` } });
      return false;
    }
  }
  return true;
}

const configFollowupRoutes = async (fastify) => {

  // GET /api/config-followup — Listar todas as configs da empresa
  fastify.get('/', {
    preHandler: [
      fastify.authenticate,
      fastify.addTenantFilter,
      fastify.requirePermission('configuracoes', 'read')
    ]
  }, async (request, reply) => {
    try {
      const { empresaId } = request;

      const result = await pool.query(`
        SELECT cf.*, f.nome as fila_nome
        FROM config_followup cf
        LEFT JOIN filas_atendimento f ON f.id = cf.fila_id
        WHERE cf.empresa_id = $1
        ORDER BY cf.fila_id IS NULL DESC, f.nome ASC
      `, [empresaId]);

      // Se não tem nenhuma config, retornar padrão
      if (result.rows.length === 0) {
        return reply.send({
          success: true,
          data: [{
            id: null,
            nome: 'Padrão (todas as filas)',
            fila_id: null,
            fila_nome: null,
            ativo: false,
            retries: DEFAULT_RETRIES,
            horario_inicio: '08:00',
            horario_fim: '18:00',
            dias_semana: [1, 2, 3, 4, 5],
            mensagem_encerramento: 'Como não recebemos sua resposta, vou encerrar nosso atendimento por aqui. Caso precise, é só nos chamar novamente! 😊',
          }]
        });
      }

      return reply.send({ success: true, data: result.rows });
    } catch (error) {
      logger.error('Erro ao buscar config followup:', { error: error.message });
      return reply.code(500).send({ success: false, error: { message: 'Erro ao buscar configuração' } });
    }
  });

  // GET /api/config-followup/:id — Buscar config específica
  fastify.get('/:id', {
    preHandler: [
      fastify.authenticate,
      fastify.addTenantFilter,
      fastify.requirePermission('configuracoes', 'read')
    ]
  }, async (request, reply) => {
    try {
      const { empresaId } = request;
      const { id } = request.params;

      const result = await pool.query(
        `SELECT cf.*, f.nome as fila_nome FROM config_followup cf LEFT JOIN filas_atendimento f ON f.id = cf.fila_id WHERE cf.id = $1 AND cf.empresa_id = $2`,
        [id, empresaId]
      );

      if (result.rows.length === 0) {
        return reply.code(404).send({ success: false, error: { message: 'Configuração não encontrada' } });
      }

      return reply.send({ success: true, data: result.rows[0] });
    } catch (error) {
      logger.error('Erro ao buscar config followup:', { error: error.message });
      return reply.code(500).send({ success: false, error: { message: 'Erro interno' } });
    }
  });

  // POST /api/config-followup — Criar nova config (por fila ou padrão)
  fastify.post('/', {
    preHandler: [
      fastify.authenticate,
      fastify.addTenantFilter,
      fastify.requirePermission('configuracoes', 'write')
    ],
    schema: {
      body: {
        type: 'object',
        required: ['nome'],
        properties: {
          nome: { type: 'string', minLength: 1, maxLength: 100 },
          fila_id: { type: ['string', 'null'], format: 'uuid' },
          ativo: { type: 'boolean' },
          retries: retrySchema,
          horario_inicio: { type: 'string', pattern: '^\\d{2}:\\d{2}(:\\d{2})?$' },
          horario_fim: { type: 'string', pattern: '^\\d{2}:\\d{2}(:\\d{2})?$' },
          dias_semana: { type: 'array', minItems: 1, maxItems: 7, items: { type: 'integer', minimum: 0, maximum: 6 } },
          mensagem_encerramento: { type: 'string', maxLength: 1000 },
        }
      }
    }
  }, async (request, reply) => {
    try {
      const { empresaId } = request;
      const { nome, fila_id, ativo, retries, mensagem_encerramento, dias_semana } = request.body;
      const horario_inicio = request.body.horario_inicio ? request.body.horario_inicio.slice(0, 5) : '08:00';
      const horario_fim = request.body.horario_fim ? request.body.horario_fim.slice(0, 5) : '18:00';

      if (!validateRetries(retries, reply)) return;

      const result = await pool.query(`
        INSERT INTO config_followup (empresa_id, nome, fila_id, ativo, retries, horario_inicio, horario_fim, dias_semana, mensagem_encerramento)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        RETURNING *
      `, [
        empresaId, nome, fila_id || null, ativo ?? false,
        JSON.stringify(retries || DEFAULT_RETRIES),
        horario_inicio, horario_fim,
        dias_semana || [1, 2, 3, 4, 5],
        mensagem_encerramento || 'Como não recebemos sua resposta, vou encerrar nosso atendimento por aqui. Caso precise, é só nos chamar novamente! 😊',
      ]);

      logger.info({ empresaId, fila_id, nome }, 'Config followup criada');
      return reply.code(201).send({ success: true, data: result.rows[0] });
    } catch (error) {
      if (error.code === '23505') {
        return reply.code(409).send({ success: false, error: { message: 'Já existe uma configuração para esta fila' } });
      }
      logger.error('Erro ao criar config followup:', { error: error.message });
      return reply.code(500).send({ success: false, error: { message: 'Erro ao criar configuração' } });
    }
  });

  // PUT /api/config-followup/:id — Atualizar config existente
  fastify.put('/:id', {
    preHandler: [
      fastify.authenticate,
      fastify.addTenantFilter,
      fastify.requirePermission('configuracoes', 'write')
    ],
    schema: {
      body: {
        type: 'object',
        properties: {
          nome: { type: 'string', minLength: 1, maxLength: 100 },
          ativo: { type: 'boolean' },
          retries: retrySchema,
          horario_inicio: { type: 'string', pattern: '^\\d{2}:\\d{2}(:\\d{2})?$' },
          horario_fim: { type: 'string', pattern: '^\\d{2}:\\d{2}(:\\d{2})?$' },
          dias_semana: { type: 'array', minItems: 1, maxItems: 7, items: { type: 'integer', minimum: 0, maximum: 6 } },
          mensagem_encerramento: { type: 'string', maxLength: 1000 },
        }
      }
    }
  }, async (request, reply) => {
    try {
      const { empresaId } = request;
      const { id } = request.params;
      const { nome, ativo, retries, dias_semana, mensagem_encerramento } = request.body;
      const horario_inicio = request.body.horario_inicio ? request.body.horario_inicio.slice(0, 5) : null;
      const horario_fim = request.body.horario_fim ? request.body.horario_fim.slice(0, 5) : null;

      if (!validateRetries(retries, reply)) return;

      const result = await pool.query(`
        UPDATE config_followup SET
          nome = COALESCE($3, nome),
          ativo = COALESCE($4, ativo),
          retries = COALESCE($5, retries),
          horario_inicio = COALESCE($6, horario_inicio),
          horario_fim = COALESCE($7, horario_fim),
          dias_semana = COALESCE($8, dias_semana),
          mensagem_encerramento = COALESCE($9, mensagem_encerramento),
          atualizado_em = NOW()
        WHERE id = $1 AND empresa_id = $2
        RETURNING *
      `, [
        id, empresaId, nome || null, ativo ?? null,
        retries ? JSON.stringify(retries) : null,
        horario_inicio, horario_fim,
        dias_semana || null, mensagem_encerramento || null,
      ]);

      if (result.rows.length === 0) {
        return reply.code(404).send({ success: false, error: { message: 'Configuração não encontrada' } });
      }

      logger.info({ empresaId, id }, 'Config followup atualizada');
      return reply.send({ success: true, data: result.rows[0] });
    } catch (error) {
      logger.error('Erro ao atualizar config followup:', { error: error.message });
      return reply.code(500).send({ success: false, error: { message: 'Erro ao atualizar configuração' } });
    }
  });

  // PUT /api/config-followup (sem ID) — Compatibilidade: upsert padrão
  fastify.put('/padrao', {
    preHandler: [
      fastify.authenticate,
      fastify.addTenantFilter,
      fastify.requirePermission('configuracoes', 'write')
    ],
    schema: {
      body: {
        type: 'object',
        properties: {
          ativo: { type: 'boolean' },
          retries: retrySchema,
          horario_inicio: { type: 'string', pattern: '^\\d{2}:\\d{2}(:\\d{2})?$' },
          horario_fim: { type: 'string', pattern: '^\\d{2}:\\d{2}(:\\d{2})?$' },
          dias_semana: { type: 'array', minItems: 1, maxItems: 7, items: { type: 'integer', minimum: 0, maximum: 6 } },
          mensagem_encerramento: { type: 'string', maxLength: 1000 },
        }
      }
    }
  }, async (request, reply) => {
    try {
      const { empresaId } = request;
      const { ativo, retries, dias_semana, mensagem_encerramento } = request.body;
      const horario_inicio = request.body.horario_inicio ? request.body.horario_inicio.slice(0, 5) : null;
      const horario_fim = request.body.horario_fim ? request.body.horario_fim.slice(0, 5) : null;

      if (!validateRetries(retries, reply)) return;

      const result = await pool.query(`
        INSERT INTO config_followup (empresa_id, nome, fila_id, ativo, retries, horario_inicio, horario_fim, dias_semana, mensagem_encerramento, atualizado_em)
        VALUES ($1, 'Padrão (todas as filas)', NULL, $2, $3, $4, $5, $6, $7, NOW())
        ON CONFLICT (empresa_id, COALESCE(fila_id, '00000000-0000-0000-0000-000000000000'))
        DO UPDATE SET
          ativo = COALESCE($2, config_followup.ativo),
          retries = COALESCE($3, config_followup.retries),
          horario_inicio = COALESCE($4, config_followup.horario_inicio),
          horario_fim = COALESCE($5, config_followup.horario_fim),
          dias_semana = COALESCE($6, config_followup.dias_semana),
          mensagem_encerramento = COALESCE($7, config_followup.mensagem_encerramento),
          atualizado_em = NOW()
        RETURNING *
      `, [
        empresaId, ativo ?? null,
        retries ? JSON.stringify(retries) : null,
        horario_inicio, horario_fim,
        dias_semana || null, mensagem_encerramento || null,
      ]);

      logger.info({ empresaId, ativo }, 'Config followup padrão atualizada');
      return reply.send({ success: true, data: result.rows[0] });
    } catch (error) {
      logger.error('Erro ao atualizar config followup padrão:', { error: error.message });
      return reply.code(500).send({ success: false, error: { message: 'Erro ao atualizar configuração' } });
    }
  });

  // DELETE /api/config-followup/:id — Excluir config (não permite excluir padrão)
  fastify.delete('/:id', {
    preHandler: [
      fastify.authenticate,
      fastify.addTenantFilter,
      fastify.requirePermission('configuracoes', 'write')
    ]
  }, async (request, reply) => {
    try {
      const { empresaId } = request;
      const { id } = request.params;

      // Verificar se é a padrão
      const check = await pool.query('SELECT fila_id FROM config_followup WHERE id = $1 AND empresa_id = $2', [id, empresaId]);
      if (check.rows.length === 0) {
        return reply.code(404).send({ success: false, error: { message: 'Configuração não encontrada' } });
      }
      if (check.rows[0].fila_id === null) {
        return reply.code(400).send({ success: false, error: { message: 'Não é possível excluir a configuração padrão. Desative-a.' } });
      }

      await pool.query('DELETE FROM config_followup WHERE id = $1 AND empresa_id = $2', [id, empresaId]);
      logger.info({ empresaId, id }, 'Config followup excluída');
      return reply.send({ success: true });
    } catch (error) {
      logger.error('Erro ao excluir config followup:', { error: error.message });
      return reply.code(500).send({ success: false, error: { message: 'Erro ao excluir' } });
    }
  });
};

export default configFollowupRoutes;
