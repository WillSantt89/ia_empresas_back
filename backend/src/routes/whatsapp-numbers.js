import { pool } from '../config/database.js';
import { logger } from '../config/logger.js';

export default async function whatsappNumbersRoutes(fastify, opts) {
  // Listar números WhatsApp
  fastify.get('/', {
    preHandler: [
      fastify.authenticate,
      fastify.addTenantFilter,
      fastify.requirePermission('whatsapp_numbers', 'read'),
      fastify.checkLimit('numero_whatsapp')
    ],
    schema: {
      querystring: {
        type: 'object',
        properties: {
          ativo: { type: 'boolean' },
          inbox_id: { type: 'string', format: 'uuid' }
        }
      }
    }
  }, async (request, reply) => {
    try {
      const { empresaId } = request;
      const { ativo, inbox_id } = request.query;

      let query = `
        SELECT
          wn.*,
          (wn.whatsapp_app_secret IS NOT NULL) as has_app_secret,
          i.nome as inbox_nome,
                    COUNT(DISTINCT c.id) as total_conversas,
          COUNT(DISTINCT c.id) FILTER (WHERE c.status = 'ativo') as conversas_ativas
        FROM whatsapp_numbers wn
        LEFT JOIN inboxes i ON i.id = wn.inbox_id
        LEFT JOIN conversas c ON c.inbox_id = i.id
        WHERE wn.empresa_id = $1
      `;

      const params = [empresaId];
      const conditions = [];

      if (typeof ativo === 'boolean') {
        params.push(ativo);
        conditions.push(`wn.ativo = $${params.length}`);
      }

      if (inbox_id) {
        params.push(inbox_id);
        conditions.push(`wn.inbox_id = $${params.length}`);
      }

      if (conditions.length > 0) {
        query += ` AND ${conditions.join(' AND ')}`;
      }

      query += ' GROUP BY wn.id, i.nome ORDER BY wn.nome_exibicao';

      const result = await pool.query(query, params);

      // Buscar limites da assinatura
      const limiteResult = await pool.query(`
        SELECT
          ai.quantidade as limite_contratado,
          ai.preco_unitario as preco_por_numero
        FROM assinatura_itens ai
        JOIN assinaturas a ON a.id = ai.assinatura_id
        JOIN itens_cobraveis ic ON ic.id = ai.item_cobravel_id
        WHERE a.empresa_id = $1
          AND ic.slug = 'numero_whatsapp'
          AND ai.ativo = true
          AND a.status = 'ativa'
        LIMIT 1
      `, [empresaId]);

      const limite = limiteResult.rows[0] || { limite_contratado: 0, preco_por_numero: 0 };

      return {
        success: true,
        data: {
          data: result.rows,
          meta: {
            total: result.rows.length,
            limite_contratado: limite.limite_contratado,
            preco_por_numero: parseFloat(limite.preco_por_numero || 0),
            numeros_disponiveis: Math.max(0, limite.limite_contratado - result.rows.length)
          }
        }
      };
    } catch (error) {
      logger.error('Error listing WhatsApp numbers:', error);
      throw error;
    }
  });

  // Criar número WhatsApp
  fastify.post('/', {
    preHandler: [
      fastify.authenticate,
      fastify.addTenantFilter,
      fastify.requirePermission('whatsapp_numbers', 'write'),
      fastify.checkLimit('numero_whatsapp')
    ],
    schema: {
      body: {
        type: 'object',
        required: ['phone_number_id', 'token_graph_api'],
        properties: {
          nome_exibicao: { type: 'string', minLength: 1, maxLength: 100 },
          phone_number_id: { type: 'string' },
          waba_id: { type: 'string' },
          token_graph_api: { type: 'string' },
          numero_formatado: { type: 'string' },
          inbox_id: { type: 'string', format: 'uuid' },
          whatsapp_app_secret: { type: 'string' }
        }
      }
    }
  }, async (request, reply) => {
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      const {
        nome_exibicao,
        phone_number_id,
        waba_id,
        token_graph_api,
        numero_formatado,
        inbox_id,
        whatsapp_app_secret
      } = request.body;
      const { empresaId } = request;

      // Verificar se phone_number_id já existe
      const exists = await client.query(
        'SELECT id FROM whatsapp_numbers WHERE phone_number_id = $1',
        [phone_number_id]
      );

      if (exists.rows.length > 0) {
        return reply.code(409).send({
          success: false,
          error: {
            code: 'NUMBER_EXISTS',
            message: 'Este número WhatsApp já está cadastrado'
          }
        });
      }

      // Validar inbox se fornecida
      if (inbox_id) {
        const inboxExists = await client.query(
          'SELECT id FROM inboxes WHERE id = $1 AND empresa_id = $2 AND ativo = true',
          [inbox_id, empresaId]
        );

        if (inboxExists.rows.length === 0) {
          return reply.code(400).send({
            success: false,
            error: {
              code: 'INBOX_NOT_FOUND',
              message: 'Inbox não encontrada ou inativa'
            }
          });
        }
      }

      // Encriptar token e app secret
      const encryptedToken = await fastify.encrypt(token_graph_api);
      const encryptedAppSecret = whatsapp_app_secret ? await fastify.encrypt(whatsapp_app_secret) : null;

      // Criar número
      const result = await client.query(`
        INSERT INTO whatsapp_numbers (
          id, empresa_id, inbox_id, nome_exibicao,
          phone_number_id, waba_id, token_graph_api,
          numero_formatado, whatsapp_app_secret, ativo, criado_em
        )
        VALUES (
          gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, true, NOW()
        )
        RETURNING id, empresa_id, inbox_id, nome_exibicao,
          phone_number_id, waba_id, numero_formatado, ativo, criado_em,
          (whatsapp_app_secret IS NOT NULL) as has_app_secret
      `, [
        empresaId,
        inbox_id,
        nome_exibicao || `WhatsApp ${phone_number_id}`,
        phone_number_id,
        waba_id,
        encryptedToken,
        numero_formatado,
        encryptedAppSecret
      ]);

      await client.query('COMMIT');

      logger.info(`WhatsApp number created: ${result.rows[0].id} - ${phone_number_id}`);

      reply.code(201).send({
        success: true,
        data: result.rows[0]
      });
    } catch (error) {
      await client.query('ROLLBACK');
      logger.error('Error creating WhatsApp number:', error);
      throw error;
    } finally {
      client.release();
    }
  });

  // Obter detalhes de um número
  fastify.get('/:id', {
    preHandler: [
      fastify.authenticate,
      fastify.addTenantFilter,
      fastify.requirePermission('whatsapp_numbers', 'read')
    ],
    schema: {
      params: {
        type: 'object',
        required: ['id'],
        properties: {
          id: { type: 'string', format: 'uuid' }
        }
      }
    }
  }, async (request, reply) => {
    try {
      const { id } = request.params;
      const { empresaId } = request;

      const result = await pool.query(`
        SELECT
          wn.id, wn.empresa_id, wn.inbox_id, wn.nome_exibicao,
          wn.phone_number_id, wn.waba_id, wn.numero_formatado,
          wn.ativo, wn.criado_em,
          wn.verified_name, wn.display_phone_number, wn.quality_rating,
          wn.name_status, wn.messaging_limit_tier, wn.platform_type,
          wn.account_mode, wn.verificacao_status, wn.verificacao_erro,
          wn.ultima_verificacao,
          (wn.whatsapp_app_secret IS NOT NULL) as has_app_secret,
          i.nome as inbox_nome,
                    a.nome as agente_nome,
          COUNT(DISTINCT c.id) as total_conversas_mes
        FROM whatsapp_numbers wn
        LEFT JOIN inboxes i ON i.id = wn.inbox_id
        LEFT JOIN agentes a ON a.id = i.agente_id
        LEFT JOIN conversas c ON c.inbox_id = i.id
          AND c.criado_em >= DATE_TRUNC('month', CURRENT_DATE)
        WHERE wn.id = $1 AND wn.empresa_id = $2
        GROUP BY wn.id, i.nome, a.nome
      `, [id, empresaId]);

      if (result.rows.length === 0) {
        return reply.code(404).send({
          success: false,
          error: {
            code: 'NUMBER_NOT_FOUND',
            message: 'Número WhatsApp não encontrado'
          }
        });
      }

      const number = result.rows[0];

      // Estatísticas adicionais
      const statsResult = await pool.query(`
        SELECT
          COUNT(DISTINCT c.id) FILTER (WHERE c.status = 'ativo') as conversas_ativas,
          COUNT(DISTINCT c.id) FILTER (WHERE c.criado_em >= CURRENT_DATE) as conversas_hoje,
          COUNT(DISTINCT ml.id) FILTER (WHERE ml.criado_em >= CURRENT_DATE) as mensagens_hoje
        FROM conversas c
        LEFT JOIN mensagens_log ml ON ml.conversa_id = c.id
        WHERE c.inbox_id = $1
      `, [number.inbox_id]);

      number.estatisticas = statsResult.rows[0];

      return {
        success: true,
        data: number
      };
    } catch (error) {
      logger.error('Error getting WhatsApp number details:', error);
      throw error;
    }
  });

  // Atualizar número WhatsApp
  fastify.put('/:id', {
    preHandler: [
      fastify.authenticate,
      fastify.addTenantFilter,
      fastify.requirePermission('whatsapp_numbers', 'write')
    ],
    schema: {
      params: {
        type: 'object',
        required: ['id'],
        properties: {
          id: { type: 'string', format: 'uuid' }
        }
      },
      body: {
        type: 'object',
        properties: {
          nome_exibicao: { type: 'string', minLength: 1, maxLength: 100 },
          waba_id: { type: 'string' },
          token_graph_api: { type: 'string' },
          numero_formatado: { type: 'string' },
          inbox_id: { type: ['string', 'null'], format: 'uuid' },
          ativo: { type: 'boolean' },
          whatsapp_app_secret: { type: 'string' }
        }
      }
    }
  }, async (request, reply) => {
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      const { id } = request.params;
      const updates = request.body;
      const { empresaId } = request;

      // Verificar se número existe
      const numberResult = await client.query(
        'SELECT * FROM whatsapp_numbers WHERE id = $1 AND empresa_id = $2',
        [id, empresaId]
      );

      if (numberResult.rows.length === 0) {
        return reply.code(404).send({
          success: false,
          error: {
            code: 'NUMBER_NOT_FOUND',
            message: 'Número WhatsApp não encontrado'
          }
        });
      }

      // Validar inbox se fornecida
      if ('inbox_id' in updates && updates.inbox_id) {
        const inboxExists = await client.query(
          'SELECT id FROM inboxes WHERE id = $1 AND empresa_id = $2 AND ativo = true',
          [updates.inbox_id, empresaId]
        );

        if (inboxExists.rows.length === 0) {
          return reply.code(400).send({
            success: false,
            error: {
              code: 'INBOX_NOT_FOUND',
              message: 'Inbox não encontrada ou inativa'
            }
          });
        }
      }

      // Montar query de update
      const fields = [];
      const values = [];
      let paramCount = 1;

      for (const [key, value] of Object.entries(updates)) {
        if (key === 'token_graph_api' || key === 'whatsapp_app_secret') {
          // Encriptar campo sensível
          fields.push(`${key} = $${paramCount}`);
          values.push(await fastify.encrypt(value));
        } else {
          fields.push(`${key} = $${paramCount}`);
          values.push(value);
        }
        paramCount++;
      }

      if (fields.length === 0) {
        return reply.code(400).send({
          success: false,
          error: {
            code: 'NO_UPDATES',
            message: 'Nenhum campo para atualizar'
          }
        });
      }

      values.push(id);

      const updateQuery = `
        UPDATE whatsapp_numbers
        SET ${fields.join(', ')}
        WHERE id = $${paramCount}
        RETURNING id, empresa_id, inbox_id, nome_exibicao,
          phone_number_id, waba_id, numero_formatado, ativo, criado_em
      `;

      const result = await client.query(updateQuery, values);

      // Se está desativando, verificar se há conversas ativas
      if (updates.ativo === false) {
        const conversasCount = await client.query(`
          SELECT COUNT(*)
          FROM conversas c
          JOIN inboxes i ON i.id = c.inbox_id
          WHERE i.id = $1 AND c.status = 'ativo'
        `, [numberResult.rows[0].inbox_id]);

        if (parseInt(conversasCount.rows[0].count) > 0) {
          await client.query('ROLLBACK');
          return reply.code(400).send({
            success: false,
            error: {
              code: 'NUMBER_HAS_ACTIVE_CONVERSATIONS',
              message: `Não é possível desativar o número. ${conversasCount.rows[0].count} conversa(s) ativa(s)`
            }
          });
        }
      }

      await client.query('COMMIT');

      logger.info(`WhatsApp number updated: ${id}`);

      return {
        success: true,
        data: result.rows[0]
      };
    } catch (error) {
      await client.query('ROLLBACK');
      logger.error('Error updating WhatsApp number:', error);
      throw error;
    } finally {
      client.release();
    }
  });

  // Deletar número WhatsApp
  fastify.delete('/:id', {
    preHandler: [
      fastify.authenticate,
      fastify.addTenantFilter,
      fastify.requirePermission('whatsapp_numbers', 'write')
    ],
    schema: {
      params: {
        type: 'object',
        required: ['id'],
        properties: {
          id: { type: 'string', format: 'uuid' }
        }
      }
    }
  }, async (request, reply) => {
    try {
      const { id } = request.params;
      const { empresaId } = request;

      // Soft delete
      const result = await pool.query(`
        UPDATE whatsapp_numbers
        SET ativo = false
        WHERE id = $1 AND empresa_id = $2 AND ativo = true
        RETURNING id
      `, [id, empresaId]);

      if (result.rows.length === 0) {
        return reply.code(404).send({
          success: false,
          error: {
            code: 'NUMBER_NOT_FOUND',
            message: 'Número WhatsApp não encontrado ou já inativo'
          }
        });
      }

      logger.info(`WhatsApp number deactivated: ${id}`);

      reply.code(204).send();
    } catch (error) {
      logger.error('Error deleting WhatsApp number:', error);
      throw error;
    }
  });

  // Testar/verificar conexão do número via Meta Graph API
  fastify.post('/:id/testar', {
    preHandler: [
      fastify.authenticate,
      fastify.addTenantFilter,
      fastify.requirePermission('whatsapp_numbers', 'write')
    ],
    schema: {
      params: {
        type: 'object',
        required: ['id'],
        properties: {
          id: { type: 'string', format: 'uuid' }
        }
      }
    }
  }, async (request, reply) => {
    try {
      const { id } = request.params;
      const { empresaId } = request;

      // Buscar número com token
      const numberResult = await pool.query(`
        SELECT
          wn.*,
          i.nome as inbox_nome
        FROM whatsapp_numbers wn
        LEFT JOIN inboxes i ON i.id = wn.inbox_id
        WHERE wn.id = $1 AND wn.empresa_id = $2
      `, [id, empresaId]);

      if (numberResult.rows.length === 0) {
        return reply.code(404).send({
          success: false,
          error: {
            code: 'NUMBER_NOT_FOUND',
            message: 'Número WhatsApp não encontrado'
          }
        });
      }

      const number = numberResult.rows[0];
      const token = await fastify.decrypt(number.token_graph_api);

      logger.info(`WhatsApp number verification requested: ${id} (phone_number_id: ${number.phone_number_id})`);

      // Chamar Meta Graph API
      const metaFields = 'verified_name,display_phone_number,quality_rating,name_status,messaging_limit_tier,platform_type,account_mode';
      const metaUrl = `https://graph.facebook.com/v21.0/${number.phone_number_id}?fields=${metaFields}`;

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);

      let metaResponse;
      try {
        metaResponse = await fetch(metaUrl, {
          method: 'GET',
          headers: { 'Authorization': `Bearer ${token}` },
          signal: controller.signal
        });
      } finally {
        clearTimeout(timeout);
      }

      const metaData = await metaResponse.json();

      if (!metaResponse.ok) {
        // Meta retornou erro — salvar no banco
        const erroMsg = metaData?.error?.message || `Erro HTTP ${metaResponse.status}`;
        logger.warn(`Meta API error for ${number.phone_number_id}: ${erroMsg}`);

        await pool.query(`
          UPDATE whatsapp_numbers
          SET verificacao_status = 'erro',
              verificacao_erro = $1,
              ultima_verificacao = NOW()
          WHERE id = $2
        `, [erroMsg, id]);

        return {
          success: false,
          data: {
            status: 'erro',
            verificacao_status: 'erro',
            verificacao_erro: erroMsg,
            ultima_verificacao: new Date().toISOString(),
            message: erroMsg
          }
        };
      }

      // Sucesso — salvar dados da Meta no banco
      await pool.query(`
        UPDATE whatsapp_numbers
        SET verified_name = $1,
            display_phone_number = $2,
            quality_rating = $3,
            name_status = $4,
            messaging_limit_tier = $5,
            platform_type = $6,
            account_mode = $7,
            verificacao_status = 'conectado',
            verificacao_erro = NULL,
            ultima_verificacao = NOW()
        WHERE id = $8
      `, [
        metaData.verified_name || null,
        metaData.display_phone_number || null,
        metaData.quality_rating || null,
        metaData.name_status || null,
        metaData.messaging_limit_tier || null,
        metaData.platform_type || null,
        metaData.account_mode || null,
        id
      ]);

      logger.info(`WhatsApp number verified successfully: ${id} - ${metaData.verified_name || number.phone_number_id}`);

      return {
        success: true,
        data: {
          status: 'conectado',
          verified_name: metaData.verified_name,
          display_phone_number: metaData.display_phone_number,
          quality_rating: metaData.quality_rating,
          name_status: metaData.name_status,
          messaging_limit_tier: metaData.messaging_limit_tier,
          platform_type: metaData.platform_type,
          account_mode: metaData.account_mode,
          verificacao_status: 'conectado',
          ultima_verificacao: new Date().toISOString(),
          message: 'Número verificado com sucesso na Meta'
        }
      };
    } catch (error) {
      logger.error('Error verifying WhatsApp number:', error);

      // Salvar erro no banco
      const erroMsg = error.name === 'AbortError'
        ? 'Timeout: Meta API não respondeu em 10 segundos'
        : (error.message || 'Erro desconhecido ao verificar conexão');

      try {
        const { id } = request.params;
        await pool.query(`
          UPDATE whatsapp_numbers
          SET verificacao_status = 'erro',
              verificacao_erro = $1,
              ultima_verificacao = NOW()
          WHERE id = $2
        `, [erroMsg, id]);
      } catch (dbError) {
        logger.error('Error saving verification failure:', dbError);
      }

      return {
        success: false,
        data: {
          status: 'erro',
          verificacao_status: 'erro',
          verificacao_erro: erroMsg,
          ultima_verificacao: new Date().toISOString(),
          message: erroMsg
        }
      };
    }
  });
}