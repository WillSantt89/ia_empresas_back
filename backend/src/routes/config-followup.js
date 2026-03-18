import { pool } from '../config/database.js';
import { logger } from '../config/logger.js';

const configFollowupRoutes = async (fastify) => {

  // GET /api/config-followup — Buscar config da empresa
  fastify.get('/', {
    preHandler: [
      fastify.authenticate,
      fastify.addTenantFilter,
      fastify.requirePermission('configuracoes', 'read')
    ]
  }, async (request, reply) => {
    try {
      const { empresaId } = request;

      const result = await pool.query(
        'SELECT * FROM config_followup WHERE empresa_id = $1',
        [empresaId]
      );

      if (result.rows.length === 0) {
        // Retornar config padrão (não salva)
        return reply.send({
          success: true,
          data: {
            ativo: false,
            retries: [
              { numero: 1, intervalo_minutos: 5, tipo: 'fixo', mensagem_fixa: 'Oi! Ainda está por aí? 😊' },
              { numero: 2, intervalo_minutos: 15, tipo: 'fixo', mensagem_fixa: 'Estou aqui caso precise de ajuda!' },
              { numero: 3, intervalo_minutos: 30, tipo: 'ia', mensagem_fixa: null },
            ],
            horario_inicio: '08:00',
            horario_fim: '18:00',
            dias_semana: [1, 2, 3, 4, 5],
            mensagem_encerramento: 'Como não recebemos sua resposta, vou encerrar nosso atendimento por aqui. Caso precise, é só nos chamar novamente! 😊',
          }
        });
      }

      return reply.send({ success: true, data: result.rows[0] });
    } catch (error) {
      logger.error('Erro ao buscar config followup:', { error: error.message });
      return reply.code(500).send({ success: false, error: { message: 'Erro ao buscar configuração' } });
    }
  });

  // PUT /api/config-followup — Atualizar config
  fastify.put('/', {
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
          retries: {
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
          },
          horario_inicio: { type: 'string', pattern: '^\\d{2}:\\d{2}$' },
          horario_fim: { type: 'string', pattern: '^\\d{2}:\\d{2}$' },
          dias_semana: {
            type: 'array',
            minItems: 1,
            maxItems: 7,
            items: { type: 'integer', minimum: 0, maximum: 6 }
          },
          mensagem_encerramento: { type: 'string', maxLength: 1000 },
        }
      }
    }
  }, async (request, reply) => {
    try {
      const { empresaId } = request;
      const { ativo, retries, horario_inicio, horario_fim, dias_semana, mensagem_encerramento } = request.body;

      // Validar: soma dos intervalos <= 1440 min (24h)
      if (retries) {
        const somaIntervalos = retries.reduce((acc, r) => acc + r.intervalo_minutos, 0);
        if (somaIntervalos > 1440) {
          return reply.code(400).send({
            success: false,
            error: { message: 'A soma dos intervalos não pode ultrapassar 24 horas (1440 minutos)' }
          });
        }

        // Validar: retries do tipo 'fixo' devem ter mensagem_fixa preenchida
        for (const retry of retries) {
          if (retry.tipo === 'fixo' && (!retry.mensagem_fixa || retry.mensagem_fixa.trim() === '')) {
            return reply.code(400).send({
              success: false,
              error: { message: `Retry #${retry.numero}: mensagem fixa é obrigatória quando tipo é "fixo"` }
            });
          }
        }
      }

      const result = await pool.query(`
        INSERT INTO config_followup (empresa_id, ativo, retries, horario_inicio, horario_fim, dias_semana, mensagem_encerramento, atualizado_em)
        VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
        ON CONFLICT (empresa_id) DO UPDATE SET
          ativo = COALESCE($2, config_followup.ativo),
          retries = COALESCE($3, config_followup.retries),
          horario_inicio = COALESCE($4, config_followup.horario_inicio),
          horario_fim = COALESCE($5, config_followup.horario_fim),
          dias_semana = COALESCE($6, config_followup.dias_semana),
          mensagem_encerramento = COALESCE($7, config_followup.mensagem_encerramento),
          atualizado_em = NOW()
        RETURNING *
      `, [
        empresaId,
        ativo ?? null,
        retries ? JSON.stringify(retries) : null,
        horario_inicio ?? null,
        horario_fim ?? null,
        dias_semana ?? null,
        mensagem_encerramento ?? null,
      ]);

      logger.info({ empresaId, ativo }, 'Config followup atualizada');

      return reply.send({ success: true, data: result.rows[0] });
    } catch (error) {
      logger.error('Erro ao atualizar config followup:', { error: error.message });
      return reply.code(500).send({ success: false, error: { message: 'Erro ao atualizar configuração' } });
    }
  });
};

export default configFollowupRoutes;
