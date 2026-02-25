import { pool } from '../config/database.js';
import { logger } from '../config/logger.js';

export default async function conversasRoutes(fastify, opts) {
  // Listar conversas
  fastify.get('/', {
    preHandler: [
      fastify.authenticate,
      fastify.addTenantFilter,
      fastify.requirePermission('conversas', 'read')
    ],
    schema: {
      querystring: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: ['ativo', 'finalizado', 'timeout'] },
          controlado_por: { type: 'string', enum: ['ia', 'humano'] },
          agente_id: { type: 'string', format: 'uuid' },
          inbox_id: { type: 'string', format: 'uuid' },
          data_inicio: { type: 'string', format: 'date' },
          data_fim: { type: 'string', format: 'date' },
          page: { type: 'integer', minimum: 1, default: 1 },
          per_page: { type: 'integer', minimum: 1, maximum: 100, default: 20 }
        }
      }
    }
  }, async (request, reply) => {
    try {
      const { empresaId } = request;
      const {
        status, controlado_por, agente_id, inbox_id,
        data_inicio, data_fim, page, per_page
      } = request.query;
      const offset = (page - 1) * per_page;

      let query = `
        SELECT
          c.*,
          i.nome as inbox_nome,
          i.inbox_id_chatwoot,
          a.nome as agente_nome,
          a.tipo as agente_tipo,
          u.nome as humano_nome_atual,
          (SELECT COUNT(*) FROM mensagens_log WHERE conversa_id = c.id) as total_mensagens,
          (SELECT MAX(criado_em) FROM mensagens_log WHERE conversa_id = c.id) as ultima_mensagem_em
        FROM conversas c
        LEFT JOIN inboxes i ON i.id = c.inbox_id
        LEFT JOIN agentes a ON a.id = c.agente_id
        LEFT JOIN usuarios u ON u.id = c.humano_id
        WHERE c.empresa_id = $1
      `;

      const params = [empresaId];
      const conditions = [];

      if (status) {
        params.push(status);
        conditions.push(`c.status = $${params.length}`);
      }

      if (controlado_por) {
        params.push(controlado_por);
        conditions.push(`c.controlado_por = $${params.length}`);
      }

      if (agente_id) {
        params.push(agente_id);
        conditions.push(`c.agente_id = $${params.length}`);
      }

      if (inbox_id) {
        params.push(inbox_id);
        conditions.push(`c.inbox_id = $${params.length}`);
      }

      if (data_inicio) {
        params.push(data_inicio);
        conditions.push(`c.criado_em >= $${params.length}`);
      }

      if (data_fim) {
        params.push(data_fim);
        conditions.push(`c.criado_em <= $${params.length} + INTERVAL '1 day'`);
      }

      if (conditions.length > 0) {
        query += ` AND ${conditions.join(' AND ')}`;
      }

      // Query para contagem total
      const countQuery = query.replace(
        /SELECT[\s\S]+?FROM/,
        'SELECT COUNT(DISTINCT c.id) FROM'
      ).replace(/LEFT JOIN usuarios[\s\S]+?WHERE/, 'WHERE');

      const totalResult = await pool.query(countQuery, params);
      const total = parseInt(totalResult.rows[0].count);

      // Adicionar ordenação e paginação
      query += ' ORDER BY c.atualizado_em DESC LIMIT $' + (params.length + 1) + ' OFFSET $' + (params.length + 2);
      params.push(per_page, offset);

      const result = await pool.query(query, params);

      return {
        success: true,
        data: result.rows,
        meta: {
          total,
          page,
          per_page,
          total_pages: Math.ceil(total / per_page)
        }
      };
    } catch (error) {
      logger.error('Error listing conversas:', error);
      throw error;
    }
  });

  // Obter detalhes de uma conversa
  fastify.get('/:id', {
    preHandler: [
      fastify.authenticate,
      fastify.addTenantFilter,
      fastify.requirePermission('conversas', 'read')
    ],
    schema: {
      params: {
        type: 'object',
        required: ['id'],
        properties: {
          id: { type: 'string', format: 'uuid' }
        }
      },
      querystring: {
        type: 'object',
        properties: {
          include_messages: { type: 'boolean', default: true },
          messages_limit: { type: 'integer', minimum: 1, maximum: 100, default: 50 }
        }
      }
    }
  }, async (request, reply) => {
    try {
      const { id } = request.params;
      const { include_messages, messages_limit } = request.query;
      const { empresaId } = request;

      // Buscar conversa
      const conversaResult = await pool.query(`
        SELECT
          c.*,
          i.nome as inbox_nome,
          i.inbox_id_chatwoot,
          a.nome as agente_nome,
          a.tipo as agente_tipo,
          a.modelo_llm as agente_modelo,
          ai.nome as agente_inicial_nome,
          u.nome as humano_nome_atual,
          u.email as humano_email,
          wn.numero_formatado as numero_whatsapp,
          e.chatwoot_url
        FROM conversas c
        LEFT JOIN inboxes i ON i.id = c.inbox_id
        LEFT JOIN agentes a ON a.id = c.agente_id
        LEFT JOIN agentes ai ON ai.id = c.agente_inicial_id
        LEFT JOIN usuarios u ON u.id = c.humano_id
        LEFT JOIN whatsapp_numbers wn ON wn.inbox_id = i.id AND wn.ativo = true
        JOIN empresas e ON e.id = c.empresa_id
        WHERE c.id = $1 AND c.empresa_id = $2
      `, [id, empresaId]);

      if (conversaResult.rows.length === 0) {
        return reply.code(404).send({
          success: false,
          error: {
            code: 'CONVERSA_NOT_FOUND',
            message: 'Conversa não encontrada'
          }
        });
      }

      const conversa = conversaResult.rows[0];

      // Estatísticas da conversa
      const statsResult = await pool.query(`
        SELECT
          COUNT(*) as total_mensagens,
          COUNT(*) FILTER (WHERE direcao = 'entrada') as mensagens_cliente,
          COUNT(*) FILTER (WHERE direcao = 'saida') as mensagens_agente,
          SUM(tokens_input) as total_tokens_input,
          SUM(tokens_output) as total_tokens_output,
          COUNT(DISTINCT tools_invocadas_json) FILTER (WHERE tools_invocadas_json IS NOT NULL) as total_tools_usadas,
          AVG(latencia_ms) as latencia_media,
          MIN(criado_em) as primeira_mensagem,
          MAX(criado_em) as ultima_mensagem
        FROM mensagens_log
        WHERE conversa_id = $1
      `, [id]);

      conversa.estatisticas = statsResult.rows[0];

      // Mensagens recentes
      if (include_messages) {
        const messagesResult = await pool.query(`
          SELECT
            id,
            direcao,
            conteudo,
            tokens_input,
            tokens_output,
            tools_invocadas_json,
            modelo_usado,
            latencia_ms,
            erro,
            criado_em
          FROM mensagens_log
          WHERE conversa_id = $1
          ORDER BY criado_em DESC
          LIMIT $2
        `, [id, messages_limit]);

        conversa.mensagens_recentes = messagesResult.rows.reverse();
      }

      // Histórico de agentes
      if (conversa.historico_agentes_json && conversa.historico_agentes_json.length > 0) {
        const agenteIds = conversa.historico_agentes_json.map(h => h.agente_id);
        const agentesResult = await pool.query(
          'SELECT id, nome, tipo FROM agentes WHERE id = ANY($1)',
          [agenteIds]
        );

        const agentesMap = {};
        agentesResult.rows.forEach(a => {
          agentesMap[a.id] = a;
        });

        conversa.historico_agentes_detalhado = conversa.historico_agentes_json.map(h => ({
          ...h,
          agente_nome: agentesMap[h.agente_id]?.nome,
          agente_tipo: agentesMap[h.agente_id]?.tipo
        }));
      }

      return {
        success: true,
        data: conversa
      };
    } catch (error) {
      logger.error('Error getting conversa details:', error);
      throw error;
    }
  });

  // Assumir controle da conversa (admin força humano)
  fastify.post('/:id/assumir', {
    preHandler: [
      fastify.authenticate,
      fastify.addTenantFilter,
      fastify.requirePermission('conversas', 'write')
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
          motivo: { type: 'string', maxLength: 100 }
        }
      }
    }
  }, async (request, reply) => {
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      const { id } = request.params;
      const { motivo } = request.body;
      const { empresaId } = request;
      const userId = request.user.id;
      const userName = request.user.nome;

      // Buscar conversa
      const conversaResult = await client.query(
        'SELECT * FROM conversas WHERE id = $1 AND empresa_id = $2 AND status = $3',
        [id, empresaId, 'ativo']
      );

      if (conversaResult.rows.length === 0) {
        return reply.code(404).send({
          success: false,
          error: {
            code: 'CONVERSA_NOT_FOUND',
            message: 'Conversa ativa não encontrada'
          }
        });
      }

      const conversa = conversaResult.rows[0];

      if (conversa.controlado_por === 'humano') {
        return reply.code(400).send({
          success: false,
          error: {
            code: 'ALREADY_HUMAN_CONTROLLED',
            message: 'Conversa já está sendo controlada por humano'
          }
        });
      }

      // Atualizar conversa
      await client.query(`
        UPDATE conversas
        SET
          controlado_por = 'humano',
          humano_id = $1,
          humano_nome = $2,
          humano_assumiu_em = NOW(),
          humano_ultima_msg_em = NOW(),
          atualizado_em = NOW()
        WHERE id = $3
      `, [userId, userName, id]);

      // Registrar no histórico
      await client.query(`
        INSERT INTO controle_historico (
          id, conversa_id, empresa_id, acao,
          de_controlador, para_controlador,
          humano_id, humano_nome, motivo, criado_em
        )
        VALUES (
          gen_random_uuid(), $1, $2, 'admin_forcou',
          'ia', 'humano', $3, $4, $5, NOW()
        )
      `, [id, empresaId, userId, userName, motivo || 'Assumido manualmente pelo admin']);

      // Criar notificação
      await client.query(`
        INSERT INTO notificacoes (
          id, empresa_id, tipo, titulo, mensagem,
          severidade, lida, criado_em
        )
        VALUES (
          gen_random_uuid(), $1, 'conversa_assumida',
          'Conversa assumida',
          $2,
          'info', false, NOW()
        )
      `, [empresaId, `${userName} assumiu a conversa ${conversa.conversation_id_chatwoot}`]);

      await client.query('COMMIT');

      logger.info(`Conversa ${id} assumed by ${userName}`);

      return {
        success: true,
        data: {
          message: 'Conversa assumida com sucesso',
          controlado_por: 'humano',
          humano_nome: userName
        }
      };
    } catch (error) {
      await client.query('ROLLBACK');
      logger.error('Error assuming conversa:', error);
      throw error;
    } finally {
      client.release();
    }
  });

  // Devolver controle da conversa para IA
  fastify.post('/:id/devolver', {
    preHandler: [
      fastify.authenticate,
      fastify.addTenantFilter,
      fastify.requirePermission('conversas', 'write')
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
          motivo: { type: 'string', maxLength: 100 },
          enviar_mensagem_retorno: { type: 'boolean', default: true }
        }
      }
    }
  }, async (request, reply) => {
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      const { id } = request.params;
      const { motivo, enviar_mensagem_retorno } = request.body;
      const { empresaId } = request;
      const userId = request.user.id;

      // Buscar conversa com config
      const conversaResult = await client.query(`
        SELECT
          c.*,
          cch.mensagem_retorno_ia,
          e.chatwoot_url,
          e.chatwoot_api_token,
          e.chatwoot_account_id
        FROM conversas c
        JOIN empresas e ON e.id = c.empresa_id
        LEFT JOIN config_controle_humano cch ON cch.empresa_id = c.empresa_id
        WHERE c.id = $1 AND c.empresa_id = $2 AND c.status = $3
      `, [id, empresaId, 'ativo']);

      if (conversaResult.rows.length === 0) {
        return reply.code(404).send({
          success: false,
          error: {
            code: 'CONVERSA_NOT_FOUND',
            message: 'Conversa ativa não encontrada'
          }
        });
      }

      const conversa = conversaResult.rows[0];

      if (conversa.controlado_por === 'ia') {
        return reply.code(400).send({
          success: false,
          error: {
            code: 'ALREADY_IA_CONTROLLED',
            message: 'Conversa já está sendo controlada pela IA'
          }
        });
      }

      // Atualizar conversa
      await client.query(`
        UPDATE conversas
        SET
          controlado_por = 'ia',
          humano_devolveu_em = NOW(),
          atualizado_em = NOW()
        WHERE id = $1
      `, [id]);

      // Registrar no histórico
      await client.query(`
        INSERT INTO controle_historico (
          id, conversa_id, empresa_id, acao,
          de_controlador, para_controlador,
          humano_id, humano_nome, motivo, criado_em
        )
        VALUES (
          gen_random_uuid(), $1, $2, 'admin_forcou',
          'humano', 'ia', $3, $4, $5, NOW()
        )
      `, [id, empresaId, conversa.humano_id, conversa.humano_nome, motivo || 'Devolvido manualmente pelo admin']);

      // Enviar mensagem de retorno se configurado
      if (enviar_mensagem_retorno && conversa.mensagem_retorno_ia && conversa.chatwoot_url) {
        try {
          const chatwootService = await import('../services/chatwoot.js');
          await chatwootService.default.sendMessage(
            conversa,
            conversa.conversation_id_chatwoot,
            conversa.mensagem_retorno_ia
          );
        } catch (error) {
          logger.error('Failed to send return message:', error);
        }
      }

      await client.query('COMMIT');

      logger.info(`Conversa ${id} returned to IA`);

      return {
        success: true,
        data: {
          message: 'Conversa devolvida para IA com sucesso',
          controlado_por: 'ia',
          mensagem_enviada: enviar_mensagem_retorno && !!conversa.mensagem_retorno_ia
        }
      };
    } catch (error) {
      await client.query('ROLLBACK');
      logger.error('Error returning conversa:', error);
      throw error;
    } finally {
      client.release();
    }
  });

  // Obter histórico de controle
  fastify.get('/:id/historico-controle', {
    preHandler: [
      fastify.authenticate,
      fastify.addTenantFilter,
      fastify.requirePermission('conversas', 'read')
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

      // Verificar se conversa existe
      const conversaExists = await pool.query(
        'SELECT id FROM conversas WHERE id = $1 AND empresa_id = $2',
        [id, empresaId]
      );

      if (conversaExists.rows.length === 0) {
        return reply.code(404).send({
          success: false,
          error: {
            code: 'CONVERSA_NOT_FOUND',
            message: 'Conversa não encontrada'
          }
        });
      }

      // Buscar histórico
      const result = await pool.query(`
        SELECT
          ch.*,
          u.nome as humano_executou_nome,
          u.email as humano_executou_email
        FROM controle_historico ch
        LEFT JOIN usuarios u ON u.id = ch.humano_id
        WHERE ch.conversa_id = $1
        ORDER BY ch.criado_em DESC
      `, [id]);

      return {
        success: true,
        data: result.rows
      };
    } catch (error) {
      logger.error('Error getting controle historico:', error);
      throw error;
    }
  });

  // Finalizar conversa
  fastify.post('/:id/finalizar', {
    preHandler: [
      fastify.authenticate,
      fastify.addTenantFilter,
      fastify.requirePermission('conversas', 'write')
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
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      const { id } = request.params;
      const { empresaId } = request;

      // Verificar se conversa existe e está ativa
      const conversaResult = await client.query(
        'SELECT * FROM conversas WHERE id = $1 AND empresa_id = $2 AND status = $3',
        [id, empresaId, 'ativo']
      );

      if (conversaResult.rows.length === 0) {
        return reply.code(404).send({
          success: false,
          error: {
            code: 'CONVERSA_NOT_FOUND',
            message: 'Conversa ativa não encontrada'
          }
        });
      }

      // Finalizar conversa
      await client.query(`
        UPDATE conversas
        SET
          status = 'finalizado',
          atualizado_em = NOW()
        WHERE id = $1
      `, [id]);

      // Finalizar atendimento ativo se houver
      await client.query(`
        UPDATE atendimentos
        SET
          status = 'finalizado',
          finalizado_em = NOW()
        WHERE conversa_id = $1 AND status = 'ativo'
      `, [id]);

      await client.query('COMMIT');

      logger.info(`Conversa ${id} finalized`);

      return {
        success: true,
        data: {
          message: 'Conversa finalizada com sucesso'
        }
      };
    } catch (error) {
      await client.query('ROLLBACK');
      logger.error('Error finalizing conversa:', error);
      throw error;
    } finally {
      client.release();
    }
  });
}