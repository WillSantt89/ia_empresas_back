import { pool } from '../config/database.js';
import { logger } from '../config/logger.js';
import { isMembroDaFila, verificarCapacidadeOperador, calcularStatsFila } from '../services/fila-manager.js';
import { enviarMensagemWhatsApp } from '../services/chat-sender.js';
import {
  emitConversaAtribuida, emitConversaAtualizada,
  emitNovaConversaNaFila, emitFilaStats, emitToUser,
} from '../services/websocket.js';

// Imports legados (manter durante transicao)
let getConversationMessages, syncChatwootHistory;
try {
  const chatwootModule = await import('../services/chatwoot.js');
  getConversationMessages = chatwootModule.getConversationMessages;
  const memoryModule = await import('../services/memory.js');
  syncChatwootHistory = memoryModule.syncChatwootHistory;
} catch (e) {
  // Chatwoot pode nao estar disponivel
}

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

      // Query para contagem total - construída separadamente para evitar problemas com subqueries
      let countQuery = `SELECT COUNT(*) as count FROM conversas c WHERE c.empresa_id = $1`;
      if (conditions.length > 0) {
        countQuery += ` AND ${conditions.join(' AND ')}`;
      }

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
            remetente_tipo,
            remetente_id,
            remetente_nome,
            status_entrega,
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

      // Atualizar conversa (sincronizar humano_id + operador_id)
      await client.query(`
        UPDATE conversas
        SET
          controlado_por = 'humano',
          humano_id = $1,
          humano_nome = $2,
          operador_id = $1,
          operador_nome = $2,
          operador_atribuido_em = NOW(),
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
          $3, 'humano', $4, $5, $6, NOW()
        )
      `, [id, empresaId, conversa.controlado_por, userId, userName, motivo || 'Assumido manualmente pelo admin']);

      await client.query('COMMIT');

      // Emitir WebSocket
      const dados = { id, operador_id: userId, operador_nome: userName, controlado_por: 'humano' };
      emitConversaAtribuida(id, conversa.fila_id, userId, dados);
      if (conversa.fila_id) {
        const stats = await calcularStatsFila(conversa.fila_id);
        emitFilaStats(conversa.fila_id, stats);
      }

      logger.info(`Conversa ${id} assumed by ${userName}`);

      return {
        success: true,
        data: {
          message: 'Conversa assumida com sucesso',
          controlado_por: 'humano',
          operador_id: userId,
          operador_nome: userName
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

      // Sync Chatwoot messages to Redis before IA resumes (non-blocking)
      if (conversa.chatwoot_url && conversa.chatwoot_api_token && conversa.chatwoot_account_id && conversa.conversation_id_chatwoot && conversa.humano_assumiu_em) {
        try {
          const chatwootMessages = await getConversationMessages({
            baseUrl: conversa.chatwoot_url,
            accountId: conversa.chatwoot_account_id,
            apiKey: conversa.chatwoot_api_token,
            conversationId: conversa.conversation_id_chatwoot,
            after: conversa.humano_assumiu_em
          });

          const conversationKey = conversa.contato_whatsapp ? `whatsapp:${conversa.contato_whatsapp}` : null;
          if (conversationKey && chatwootMessages.length > 0) {
            const synced = await syncChatwootHistory(conversa.empresa_id, conversationKey, chatwootMessages);
            logger.info(`Synced ${synced} Chatwoot messages for conversation ${id}`);
          }
        } catch (syncError) {
          logger.error(`Failed to sync Chatwoot messages for conversation ${id} (non-blocking):`, syncError);
        }
      }

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

      // WebSocket: notificar fila
      const conversa = conversaResult.rows[0];
      emitConversaAtualizada(id, conversa.fila_id, { id, status: 'finalizado' });
      if (conversa.fila_id) {
        const stats = await calcularStatsFila(conversa.fila_id);
        emitFilaStats(conversa.fila_id, stats);
      }

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

  // ============================================
  // POST /:id/atribuir — Atribuir conversa a operador
  // ============================================
  fastify.post('/:id/atribuir', {
    preHandler: [
      fastify.authenticate,
      fastify.addTenantFilter,
      fastify.requirePermission('conversas', 'write')
    ]
  }, async (request, reply) => {
    const { id } = request.params;
    const { empresaId, user } = request;
    const operadorId = request.body?.operador_id || user.id;

    // Buscar conversa
    const conversaResult = await pool.query(
      `SELECT * FROM conversas WHERE id = $1 AND empresa_id = $2 AND status IN ('ativo', 'pendente')`,
      [id, empresaId]
    );
    if (conversaResult.rows.length === 0) {
      return reply.code(404).send({ success: false, error: { message: 'Conversa ativa nao encontrada' } });
    }
    const conversa = conversaResult.rows[0];

    // Operador so pode atribuir a si mesmo e se for membro da fila
    if (user.role === 'operador') {
      if (operadorId !== user.id) {
        return reply.code(403).send({ success: false, error: { message: 'Operador so pode atribuir a si mesmo' } });
      }
      if (conversa.fila_id) {
        const isMembro = await isMembroDaFila(user.id, conversa.fila_id);
        if (!isMembro) {
          return reply.code(403).send({ success: false, error: { message: 'Voce nao pertence a esta fila' } });
        }
      }
    }

    // Verificar capacidade do operador
    const temCapacidade = await verificarCapacidadeOperador(operadorId);
    if (!temCapacidade) {
      return reply.code(400).send({ success: false, error: { message: 'Operador atingiu limite de conversas simultaneas' } });
    }

    // Buscar nome do operador
    const opResult = await pool.query(`SELECT nome FROM usuarios WHERE id = $1`, [operadorId]);
    const operadorNome = opResult.rows[0]?.nome || 'Desconhecido';

    // Atualizar conversa
    await pool.query(
      `UPDATE conversas SET
         operador_id = $1, operador_nome = $2, operador_atribuido_em = NOW(),
         controlado_por = 'humano', humano_id = $1, humano_nome = $2,
         humano_assumiu_em = NOW(), humano_ultima_msg_em = NOW(), atualizado_em = NOW()
       WHERE id = $3`,
      [operadorId, operadorNome, id]
    );

    // Registrar historico
    await pool.query(
      `INSERT INTO controle_historico
         (conversa_id, empresa_id, acao, de_controlador, para_controlador, humano_id, humano_nome, motivo)
       VALUES ($1, $2, 'operador_assumiu', $3, 'humano', $4, $5, $6)`,
      [id, empresaId, conversa.controlado_por, operadorId, operadorNome, 'Atribuido via painel']
    );

    // WebSocket
    const dados = { id, operador_id: operadorId, operador_nome: operadorNome, controlado_por: 'humano' };
    emitConversaAtribuida(id, conversa.fila_id, operadorId, dados);
    if (conversa.fila_id) {
      const stats = await calcularStatsFila(conversa.fila_id);
      emitFilaStats(conversa.fila_id, stats);
    }

    logger.info(`Conversa ${id} atribuida a ${operadorNome}`);
    reply.send({ success: true, data: { message: 'Conversa atribuida com sucesso', operador_nome: operadorNome } });
  });

  // ============================================
  // POST /:id/desatribuir — Remover atribuicao
  // ============================================
  fastify.post('/:id/desatribuir', {
    preHandler: [
      fastify.authenticate,
      fastify.addTenantFilter,
      fastify.requirePermission('conversas', 'write')
    ]
  }, async (request, reply) => {
    const { id } = request.params;
    const { empresaId } = request;

    const conversaResult = await pool.query(
      `SELECT * FROM conversas WHERE id = $1 AND empresa_id = $2 AND status IN ('ativo', 'pendente')`,
      [id, empresaId]
    );
    if (conversaResult.rows.length === 0) {
      return reply.code(404).send({ success: false, error: { message: 'Conversa nao encontrada' } });
    }
    const conversa = conversaResult.rows[0];

    // Voltar pra fila se tem fila, senao pra IA
    const novoControlador = conversa.fila_id ? 'fila' : 'ia';

    await pool.query(
      `UPDATE conversas SET
         operador_id = NULL, operador_nome = NULL,
         controlado_por = $1, atualizado_em = NOW()
       WHERE id = $2`,
      [novoControlador, id]
    );

    await pool.query(
      `INSERT INTO controle_historico
         (conversa_id, empresa_id, acao, de_controlador, para_controlador, humano_id, humano_nome, motivo)
       VALUES ($1, $2, 'desatribuido', 'humano', $3, $4, $5, $6)`,
      [id, empresaId, novoControlador, conversa.operador_id, conversa.operador_nome, 'Desatribuido via painel']
    );

    emitConversaAtualizada(id, conversa.fila_id, { id, operador_id: null, controlado_por: novoControlador });
    if (conversa.fila_id) {
      const stats = await calcularStatsFila(conversa.fila_id);
      emitFilaStats(conversa.fila_id, stats);
    }

    reply.send({ success: true, data: { message: 'Conversa desatribuida', controlado_por: novoControlador } });
  });

  // ============================================
  // POST /:id/transferir-fila — Transferir para outra fila
  // ============================================
  fastify.post('/:id/transferir-fila', {
    preHandler: [
      fastify.authenticate,
      fastify.addTenantFilter,
      fastify.requirePermission('conversas', 'write')
    ]
  }, async (request, reply) => {
    const { id } = request.params;
    const { empresaId, user } = request;
    const { fila_id, motivo } = request.body;

    if (!fila_id) {
      return reply.code(400).send({ success: false, error: { message: 'fila_id e obrigatorio' } });
    }

    // Verificar fila destino existe
    const filaResult = await pool.query(
      `SELECT * FROM filas_atendimento WHERE id = $1 AND empresa_id = $2 AND ativo = true`,
      [fila_id, empresaId]
    );
    if (filaResult.rows.length === 0) {
      return reply.code(404).send({ success: false, error: { message: 'Fila destino nao encontrada' } });
    }

    // Operador so pode transferir para fila que pertence
    if (user.role === 'operador') {
      const isMembro = await isMembroDaFila(user.id, fila_id);
      if (!isMembro) {
        return reply.code(403).send({ success: false, error: { message: 'Voce nao pertence a fila destino' } });
      }
    }

    const conversaResult = await pool.query(
      `SELECT * FROM conversas WHERE id = $1 AND empresa_id = $2 AND status IN ('ativo', 'pendente')`,
      [id, empresaId]
    );
    if (conversaResult.rows.length === 0) {
      return reply.code(404).send({ success: false, error: { message: 'Conversa nao encontrada' } });
    }
    const conversa = conversaResult.rows[0];
    const filaAntigaId = conversa.fila_id;

    // Transferir
    await pool.query(
      `UPDATE conversas SET
         fila_id = $1, fila_entrada_em = NOW(),
         operador_id = NULL, operador_nome = NULL,
         controlado_por = 'fila', atualizado_em = NOW()
       WHERE id = $2`,
      [fila_id, id]
    );

    await pool.query(
      `INSERT INTO controle_historico
         (conversa_id, empresa_id, acao, de_controlador, para_controlador, humano_id, humano_nome, motivo)
       VALUES ($1, $2, 'transferencia_fila', $3, 'fila', $4, $5, $6)`,
      [id, empresaId, conversa.controlado_por, user.id, user.nome, motivo || 'Transferido para outra fila']
    );

    // WebSocket: notificar fila antiga e nova
    if (filaAntigaId) {
      emitConversaAtualizada(id, filaAntigaId, { id, removida: true });
      const statsAntiga = await calcularStatsFila(filaAntigaId);
      emitFilaStats(filaAntigaId, statsAntiga);
    }
    emitNovaConversaNaFila(fila_id, { id, contato_whatsapp: conversa.contato_whatsapp, contato_nome: conversa.contato_nome });
    const statsNova = await calcularStatsFila(fila_id);
    emitFilaStats(fila_id, statsNova);

    logger.info(`Conversa ${id} transferida para fila ${filaResult.rows[0].nome}`);
    reply.send({ success: true, data: { message: `Transferida para ${filaResult.rows[0].nome}` } });
  });

  // ============================================
  // POST /:id/prioridade — Alterar prioridade
  // ============================================
  fastify.post('/:id/prioridade', {
    preHandler: [
      fastify.authenticate,
      fastify.addTenantFilter,
      fastify.requirePermission('conversas', 'write')
    ]
  }, async (request, reply) => {
    const { id } = request.params;
    const { empresaId } = request;
    const { prioridade } = request.body;

    const validas = ['none', 'low', 'medium', 'high', 'urgent'];
    if (!validas.includes(prioridade)) {
      return reply.code(400).send({ success: false, error: { message: `Prioridade invalida. Use: ${validas.join(', ')}` } });
    }

    const result = await pool.query(
      `UPDATE conversas SET prioridade = $1, atualizado_em = NOW()
       WHERE id = $2 AND empresa_id = $3 RETURNING fila_id`,
      [prioridade, id, empresaId]
    );

    if (result.rows.length === 0) {
      return reply.code(404).send({ success: false, error: { message: 'Conversa nao encontrada' } });
    }

    emitConversaAtualizada(id, result.rows[0].fila_id, { id, prioridade });
    reply.send({ success: true, data: { prioridade } });
  });

  // ============================================
  // POST /:id/snooze — Adiar conversa
  // ============================================
  fastify.post('/:id/snooze', {
    preHandler: [
      fastify.authenticate,
      fastify.addTenantFilter,
      fastify.requirePermission('conversas', 'write')
    ]
  }, async (request, reply) => {
    const { id } = request.params;
    const { empresaId } = request;
    const { ate } = request.body;

    if (!ate) {
      return reply.code(400).send({ success: false, error: { message: 'Campo "ate" (data/hora) e obrigatorio' } });
    }

    const result = await pool.query(
      `UPDATE conversas SET status = 'snoozed', snoozed_ate = $1, atualizado_em = NOW()
       WHERE id = $2 AND empresa_id = $3 AND status IN ('ativo', 'pendente')
       RETURNING fila_id`,
      [ate, id, empresaId]
    );

    if (result.rows.length === 0) {
      return reply.code(404).send({ success: false, error: { message: 'Conversa nao encontrada' } });
    }

    emitConversaAtualizada(id, result.rows[0].fila_id, { id, status: 'snoozed', snoozed_ate: ate });
    reply.send({ success: true, data: { status: 'snoozed', snoozed_ate: ate } });
  });

  // ============================================
  // POST /:id/unsnooze — Reativar conversa
  // ============================================
  fastify.post('/:id/unsnooze', {
    preHandler: [
      fastify.authenticate,
      fastify.addTenantFilter,
      fastify.requirePermission('conversas', 'write')
    ]
  }, async (request, reply) => {
    const { id } = request.params;
    const { empresaId } = request;

    const result = await pool.query(
      `UPDATE conversas SET status = 'ativo', snoozed_ate = NULL, atualizado_em = NOW()
       WHERE id = $1 AND empresa_id = $2 AND status = 'snoozed'
       RETURNING fila_id`,
      [id, empresaId]
    );

    if (result.rows.length === 0) {
      return reply.code(404).send({ success: false, error: { message: 'Conversa snoozed nao encontrada' } });
    }

    emitConversaAtualizada(id, result.rows[0].fila_id, { id, status: 'ativo' });
    reply.send({ success: true, data: { status: 'ativo' } });
  });

  // ============================================
  // GET /:id/labels — Labels da conversa
  // ============================================
  fastify.get('/:id/labels', {
    preHandler: [
      fastify.authenticate,
      fastify.addTenantFilter,
      fastify.requirePermission('conversas', 'read')
    ]
  }, async (request, reply) => {
    const { id } = request.params;

    const result = await pool.query(
      `SELECT l.* FROM labels l
       JOIN conversa_labels cl ON cl.label_id = l.id
       WHERE cl.conversa_id = $1 AND l.ativo = true
       ORDER BY l.nome`,
      [id]
    );

    reply.send({ success: true, data: result.rows });
  });

  // ============================================
  // POST /:id/labels — Definir labels (sobrescreve)
  // ============================================
  fastify.post('/:id/labels', {
    preHandler: [
      fastify.authenticate,
      fastify.addTenantFilter,
      fastify.requirePermission('conversas', 'write')
    ]
  }, async (request, reply) => {
    const { id } = request.params;
    const { label_ids } = request.body;

    if (!Array.isArray(label_ids)) {
      return reply.code(400).send({ success: false, error: { message: 'label_ids deve ser um array' } });
    }

    // Remover labels atuais
    await pool.query(`DELETE FROM conversa_labels WHERE conversa_id = $1`, [id]);

    // Adicionar novas
    for (const labelId of label_ids) {
      await pool.query(
        `INSERT INTO conversa_labels (conversa_id, label_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [id, labelId]
      );
    }

    // Retornar labels atualizadas
    const result = await pool.query(
      `SELECT l.* FROM labels l
       JOIN conversa_labels cl ON cl.label_id = l.id
       WHERE cl.conversa_id = $1 AND l.ativo = true`,
      [id]
    );

    reply.send({ success: true, data: result.rows });
  });

  // ============================================
  // GET /:id/notas — Notas internas
  // ============================================
  fastify.get('/:id/notas', {
    preHandler: [
      fastify.authenticate,
      fastify.addTenantFilter,
      fastify.requirePermission('conversas', 'read')
    ]
  }, async (request, reply) => {
    const { id } = request.params;

    const result = await pool.query(
      `SELECT * FROM notas_internas WHERE conversa_id = $1 ORDER BY criado_em DESC`,
      [id]
    );

    reply.send({ success: true, data: result.rows });
  });

  // ============================================
  // POST /:id/notas — Criar nota interna
  // ============================================
  fastify.post('/:id/notas', {
    preHandler: [
      fastify.authenticate,
      fastify.addTenantFilter,
      fastify.requirePermission('conversas', 'write')
    ]
  }, async (request, reply) => {
    const { id } = request.params;
    const { user } = request;
    const { conteudo } = request.body;

    if (!conteudo || conteudo.trim().length === 0) {
      return reply.code(400).send({ success: false, error: { message: 'Conteudo e obrigatorio' } });
    }

    const result = await pool.query(
      `INSERT INTO notas_internas (conversa_id, usuario_id, usuario_nome, conteudo) VALUES ($1, $2, $3, $4) RETURNING *`,
      [id, user.id, user.nome, conteudo.trim()]
    );

    reply.status(201).send({ success: true, data: result.rows[0] });
  });

  // ============================================
  // POST /api/chat/enviar — Operador envia mensagem
  // ============================================
  fastify.post('/enviar-mensagem', {
    preHandler: [
      fastify.authenticate,
      fastify.addTenantFilter,
      fastify.requirePermission('conversas', 'write')
    ]
  }, async (request, reply) => {
    const { user } = request;
    const { conversa_id, conteudo } = request.body;

    if (!conversa_id || !conteudo) {
      return reply.code(400).send({ success: false, error: { message: 'conversa_id e conteudo sao obrigatorios' } });
    }

    // Verificar que operador tem acesso
    const conversaResult = await pool.query(
      `SELECT * FROM conversas WHERE id = $1 AND empresa_id = $2`,
      [conversa_id, request.empresaId]
    );
    if (conversaResult.rows.length === 0) {
      return reply.code(404).send({ success: false, error: { message: 'Conversa nao encontrada' } });
    }

    const conversa = conversaResult.rows[0];

    // Operador so pode enviar se for membro da fila
    if (user.role === 'operador' && conversa.fila_id) {
      const isMembro = await isMembroDaFila(user.id, conversa.fila_id);
      if (!isMembro) {
        return reply.code(403).send({ success: false, error: { message: 'Sem acesso a esta conversa' } });
      }
    }

    try {
      const mensagem = await enviarMensagemWhatsApp(conversa_id, conteudo.trim(), {
        id: user.id,
        nome: user.nome,
      });

      reply.send({ success: true, data: mensagem });
    } catch (error) {
      logger.error('Erro enviando mensagem:', error);
      reply.code(500).send({ success: false, error: { message: error.message } });
    }
  });

  // ============================================
  // PATCH /disponibilidade — Alterar disponibilidade
  // (registrada aqui para aproveitar o authenticate)
  // ============================================

  // ============================================
  // POST /filtro — Filtro avancado
  // ============================================
  fastify.post('/filtro', {
    preHandler: [
      fastify.authenticate,
      fastify.addTenantFilter,
      fastify.requirePermission('conversas', 'read')
    ]
  }, async (request, reply) => {
    const { empresaId, user } = request;
    const { filtros = [], ordenar_por = 'criado_em', ordem = 'desc', pagina = 1, por_pagina = 50 } = request.body;

    let where = `c.empresa_id = $1`;
    const params = [empresaId];
    let paramCount = 1;

    // Operador: filtrar apenas filas dele
    if (user.role === 'operador') {
      paramCount++;
      where += ` AND (c.fila_id IN (SELECT fm.fila_id FROM fila_membros fm WHERE fm.usuario_id = $${paramCount}) OR c.operador_id = $${paramCount})`;
      params.push(user.id);
    }

    // Aplicar filtros
    for (const f of filtros) {
      paramCount++;
      switch (f.campo) {
        case 'status':
          where += ` AND c.status = $${paramCount}`;
          params.push(f.valor);
          break;
        case 'controlado_por':
          where += ` AND c.controlado_por = $${paramCount}`;
          params.push(f.valor);
          break;
        case 'prioridade':
          where += ` AND c.prioridade = $${paramCount}`;
          params.push(f.valor);
          break;
        case 'fila_id':
          where += ` AND c.fila_id = $${paramCount}`;
          params.push(f.valor);
          break;
        case 'operador_id':
          where += ` AND c.operador_id = $${paramCount}`;
          params.push(f.valor);
          break;
        case 'agente_id':
          where += ` AND c.agente_id = $${paramCount}`;
          params.push(f.valor);
          break;
        case 'labels':
          where += ` AND EXISTS (SELECT 1 FROM conversa_labels cl JOIN labels l ON cl.label_id = l.id WHERE cl.conversa_id = c.id AND l.nome = $${paramCount})`;
          params.push(f.valor);
          break;
        case 'criado_em':
          if (f.operador === 'maior_que') {
            where += ` AND c.criado_em >= $${paramCount}`;
          } else {
            where += ` AND c.criado_em <= $${paramCount}`;
          }
          params.push(f.valor);
          break;
        case 'contato_whatsapp':
          where += ` AND c.contato_whatsapp LIKE $${paramCount}`;
          params.push(`%${f.valor}%`);
          break;
        case 'contato_nome':
          where += ` AND c.contato_nome ILIKE $${paramCount}`;
          params.push(`%${f.valor}%`);
          break;
        default:
          paramCount--;
          break;
      }
    }

    const offset = (parseInt(pagina) - 1) * parseInt(por_pagina);

    // Count
    const countResult = await pool.query(`SELECT COUNT(*) as total FROM conversas c WHERE ${where}`, params);

    // Ordenacao segura
    const colunasPermitidas = ['criado_em', 'atualizado_em', 'prioridade', 'status'];
    const col = colunasPermitidas.includes(ordenar_por) ? ordenar_por : 'criado_em';
    const dir = ordem === 'asc' ? 'ASC' : 'DESC';

    const result = await pool.query(
      `SELECT c.*, a.nome as agente_nome,
              (SELECT COUNT(*) FROM mensagens_log m WHERE m.conversa_id = c.id) as total_mensagens,
              (SELECT conteudo FROM mensagens_log m WHERE m.conversa_id = c.id ORDER BY m.criado_em DESC LIMIT 1) as ultima_mensagem
       FROM conversas c
       LEFT JOIN agentes a ON c.agente_id = a.id
       WHERE ${where}
       ORDER BY c.${col} ${dir}
       LIMIT $${paramCount + 1} OFFSET $${paramCount + 2}`,
      [...params, parseInt(por_pagina), offset]
    );

    reply.send({
      success: true,
      data: result.rows,
      meta: {
        total: parseInt(countResult.rows[0].total),
        pagina: parseInt(pagina),
        por_pagina: parseInt(por_pagina),
        total_paginas: Math.ceil(parseInt(countResult.rows[0].total) / parseInt(por_pagina)),
      },
    });
  });

  // ============================================
  // BULK ACTIONS — Ações em massa (max 25)
  // ============================================
  const BULK_LIMIT = 25;

  function validateBulkIds(conversa_ids, reply) {
    if (!Array.isArray(conversa_ids) || conversa_ids.length === 0) {
      reply.code(400).send({ success: false, error: { message: 'conversa_ids deve ser um array nao vazio' } });
      return false;
    }
    if (conversa_ids.length > BULK_LIMIT) {
      reply.code(400).send({ success: false, error: { message: `Maximo ${BULK_LIMIT} conversas por vez` } });
      return false;
    }
    return true;
  }

  // POST /bulk/atribuir
  fastify.post('/bulk/atribuir', {
    preHandler: [
      fastify.authenticate,
      fastify.addTenantFilter,
      fastify.requirePermission('conversas', 'write')
    ]
  }, async (request, reply) => {
    const { conversa_ids } = request.body;
    if (!validateBulkIds(conversa_ids, reply)) return;

    const { empresaId, user } = request;
    const operadorId = request.body.operador_id || user.id;

    // Buscar nome do operador
    const opResult = await pool.query(`SELECT nome FROM usuarios WHERE id = $1`, [operadorId]);
    const operadorNome = opResult.rows[0]?.nome || 'Desconhecido';

    // Verificar capacidade
    const temCapacidade = await verificarCapacidadeOperador(operadorId);
    if (!temCapacidade) {
      return reply.code(400).send({ success: false, error: { message: 'Operador atingiu limite de conversas simultaneas' } });
    }

    const client = await pool.connect();
    const sucesso = [];
    const erros = [];

    try {
      await client.query('BEGIN');

      const conversasResult = await client.query(
        `SELECT id, fila_id, controlado_por FROM conversas
         WHERE id = ANY($1) AND empresa_id = $2 AND status IN ('ativo', 'pendente')`,
        [conversa_ids, empresaId]
      );
      const conversasMap = new Map(conversasResult.rows.map(c => [c.id, c]));

      for (const cid of conversa_ids) {
        const conversa = conversasMap.get(cid);
        if (!conversa) { erros.push({ id: cid, motivo: 'Nao encontrada ou inativa' }); continue; }

        await client.query(
          `UPDATE conversas SET
             operador_id = $1, operador_nome = $2, operador_atribuido_em = NOW(),
             controlado_por = 'humano', humano_id = $1, humano_nome = $2,
             humano_assumiu_em = NOW(), humano_ultima_msg_em = NOW(), atualizado_em = NOW()
           WHERE id = $3`,
          [operadorId, operadorNome, cid]
        );

        await client.query(
          `INSERT INTO controle_historico
             (conversa_id, empresa_id, acao, de_controlador, para_controlador, humano_id, humano_nome, motivo)
           VALUES ($1, $2, 'operador_assumiu', $3, 'humano', $4, $5, 'Atribuido em massa')`,
          [cid, empresaId, conversa.controlado_por, operadorId, operadorNome]
        );

        sucesso.push(cid);
      }

      await client.query('COMMIT');

      // WebSocket (fora da transação)
      const filasAfetadas = new Set();
      for (const cid of sucesso) {
        const conversa = conversasMap.get(cid);
        emitConversaAtribuida(cid, conversa.fila_id, operadorId, { id: cid, operador_id: operadorId, operador_nome: operadorNome, controlado_por: 'humano' });
        if (conversa.fila_id) filasAfetadas.add(conversa.fila_id);
      }
      for (const filaId of filasAfetadas) {
        const stats = await calcularStatsFila(filaId);
        emitFilaStats(filaId, stats);
      }

      logger.info(`Bulk atribuir: ${sucesso.length} ok, ${erros.length} erros`);
      reply.send({ success: true, data: { sucesso: sucesso.length, erros } });
    } catch (error) {
      await client.query('ROLLBACK');
      logger.error('Error bulk atribuir:', error);
      throw error;
    } finally {
      client.release();
    }
  });

  // POST /bulk/desatribuir
  fastify.post('/bulk/desatribuir', {
    preHandler: [
      fastify.authenticate,
      fastify.addTenantFilter,
      fastify.requirePermission('conversas', 'write')
    ]
  }, async (request, reply) => {
    const { conversa_ids } = request.body;
    if (!validateBulkIds(conversa_ids, reply)) return;

    const { empresaId, user } = request;
    const client = await pool.connect();
    const sucesso = [];
    const erros = [];

    try {
      await client.query('BEGIN');

      const conversasResult = await client.query(
        `SELECT id, fila_id, operador_id, operador_nome, controlado_por FROM conversas
         WHERE id = ANY($1) AND empresa_id = $2 AND status IN ('ativo', 'pendente')`,
        [conversa_ids, empresaId]
      );
      const conversasMap = new Map(conversasResult.rows.map(c => [c.id, c]));

      for (const cid of conversa_ids) {
        const conversa = conversasMap.get(cid);
        if (!conversa) { erros.push({ id: cid, motivo: 'Nao encontrada ou inativa' }); continue; }

        const novoControlador = conversa.fila_id ? 'fila' : 'ia';

        await client.query(
          `UPDATE conversas SET
             operador_id = NULL, operador_nome = NULL,
             controlado_por = $1, atualizado_em = NOW()
           WHERE id = $2`,
          [novoControlador, cid]
        );

        await client.query(
          `INSERT INTO controle_historico
             (conversa_id, empresa_id, acao, de_controlador, para_controlador, humano_id, humano_nome, motivo)
           VALUES ($1, $2, 'desatribuido', 'humano', $3, $4, $5, 'Desatribuido em massa')`,
          [cid, empresaId, novoControlador, conversa.operador_id, conversa.operador_nome]
        );

        sucesso.push(cid);
      }

      await client.query('COMMIT');

      const filasAfetadas = new Set();
      for (const cid of sucesso) {
        const conversa = conversasMap.get(cid);
        const novoControlador = conversa.fila_id ? 'fila' : 'ia';
        emitConversaAtualizada(cid, conversa.fila_id, { id: cid, operador_id: null, controlado_por: novoControlador });
        if (conversa.fila_id) filasAfetadas.add(conversa.fila_id);
      }
      for (const filaId of filasAfetadas) {
        const stats = await calcularStatsFila(filaId);
        emitFilaStats(filaId, stats);
      }

      logger.info(`Bulk desatribuir: ${sucesso.length} ok, ${erros.length} erros`);
      reply.send({ success: true, data: { sucesso: sucesso.length, erros } });
    } catch (error) {
      await client.query('ROLLBACK');
      logger.error('Error bulk desatribuir:', error);
      throw error;
    } finally {
      client.release();
    }
  });

  // POST /bulk/transferir
  fastify.post('/bulk/transferir', {
    preHandler: [
      fastify.authenticate,
      fastify.addTenantFilter,
      fastify.requirePermission('conversas', 'write')
    ]
  }, async (request, reply) => {
    const { conversa_ids, fila_id } = request.body;
    if (!validateBulkIds(conversa_ids, reply)) return;

    if (!fila_id) {
      return reply.code(400).send({ success: false, error: { message: 'fila_id e obrigatorio' } });
    }

    const { empresaId, user } = request;

    // Verificar fila destino
    const filaResult = await pool.query(
      `SELECT * FROM filas_atendimento WHERE id = $1 AND empresa_id = $2 AND ativo = true`,
      [fila_id, empresaId]
    );
    if (filaResult.rows.length === 0) {
      return reply.code(404).send({ success: false, error: { message: 'Fila destino nao encontrada' } });
    }
    const filaNome = filaResult.rows[0].nome;

    const client = await pool.connect();
    const sucesso = [];
    const erros = [];

    try {
      await client.query('BEGIN');

      const conversasResult = await client.query(
        `SELECT id, fila_id, controlado_por, contato_whatsapp, contato_nome FROM conversas
         WHERE id = ANY($1) AND empresa_id = $2 AND status IN ('ativo', 'pendente')`,
        [conversa_ids, empresaId]
      );
      const conversasMap = new Map(conversasResult.rows.map(c => [c.id, c]));

      for (const cid of conversa_ids) {
        const conversa = conversasMap.get(cid);
        if (!conversa) { erros.push({ id: cid, motivo: 'Nao encontrada ou inativa' }); continue; }

        await client.query(
          `UPDATE conversas SET
             fila_id = $1, fila_entrada_em = NOW(),
             operador_id = NULL, operador_nome = NULL,
             controlado_por = 'fila', atualizado_em = NOW()
           WHERE id = $2`,
          [fila_id, cid]
        );

        await client.query(
          `INSERT INTO controle_historico
             (conversa_id, empresa_id, acao, de_controlador, para_controlador, humano_id, humano_nome, motivo)
           VALUES ($1, $2, 'transferencia_fila', $3, 'fila', $4, $5, 'Transferido em massa')`,
          [cid, empresaId, conversa.controlado_por, user.id, user.nome]
        );

        sucesso.push(cid);
      }

      await client.query('COMMIT');

      // WebSocket
      const filasAntigas = new Set();
      for (const cid of sucesso) {
        const conversa = conversasMap.get(cid);
        if (conversa.fila_id && conversa.fila_id !== fila_id) {
          emitConversaAtualizada(cid, conversa.fila_id, { id: cid, removida: true });
          filasAntigas.add(conversa.fila_id);
        }
        emitNovaConversaNaFila(fila_id, { id: cid, contato_whatsapp: conversa.contato_whatsapp, contato_nome: conversa.contato_nome });
      }
      for (const filaId of filasAntigas) {
        const stats = await calcularStatsFila(filaId);
        emitFilaStats(filaId, stats);
      }
      const statsNova = await calcularStatsFila(fila_id);
      emitFilaStats(fila_id, statsNova);

      logger.info(`Bulk transferir: ${sucesso.length} ok para fila ${filaNome}, ${erros.length} erros`);
      reply.send({ success: true, data: { sucesso: sucesso.length, erros } });
    } catch (error) {
      await client.query('ROLLBACK');
      logger.error('Error bulk transferir:', error);
      throw error;
    } finally {
      client.release();
    }
  });

  // POST /bulk/devolver — Devolver para IA em massa
  fastify.post('/bulk/devolver', {
    preHandler: [
      fastify.authenticate,
      fastify.addTenantFilter,
      fastify.requirePermission('conversas', 'write')
    ]
  }, async (request, reply) => {
    const { conversa_ids } = request.body;
    if (!validateBulkIds(conversa_ids, reply)) return;

    const { empresaId, user } = request;
    const client = await pool.connect();
    const sucesso = [];
    const erros = [];

    try {
      await client.query('BEGIN');

      const conversasResult = await client.query(
        `SELECT id, fila_id, operador_id, operador_nome, controlado_por FROM conversas
         WHERE id = ANY($1) AND empresa_id = $2 AND status IN ('ativo', 'pendente')`,
        [conversa_ids, empresaId]
      );
      const conversasMap = new Map(conversasResult.rows.map(c => [c.id, c]));

      for (const cid of conversa_ids) {
        const conversa = conversasMap.get(cid);
        if (!conversa) { erros.push({ id: cid, motivo: 'Nao encontrada ou inativa' }); continue; }

        await client.query(
          `UPDATE conversas SET
             operador_id = NULL, operador_nome = NULL,
             controlado_por = 'ia', humano_id = NULL, humano_nome = NULL,
             atualizado_em = NOW()
           WHERE id = $1`,
          [cid]
        );

        await client.query(
          `INSERT INTO controle_historico
             (conversa_id, empresa_id, acao, de_controlador, para_controlador, humano_id, humano_nome, motivo)
           VALUES ($1, $2, 'devolvido_ia', $3, 'ia', $4, $5, 'Devolvido para IA em massa')`,
          [cid, empresaId, conversa.controlado_por, user.id, user.nome]
        );

        sucesso.push(cid);
      }

      await client.query('COMMIT');

      const filasAfetadas = new Set();
      for (const cid of sucesso) {
        const conversa = conversasMap.get(cid);
        emitConversaAtualizada(cid, conversa.fila_id, { id: cid, operador_id: null, controlado_por: 'ia' });
        if (conversa.fila_id) filasAfetadas.add(conversa.fila_id);
      }
      for (const filaId of filasAfetadas) {
        const stats = await calcularStatsFila(filaId);
        emitFilaStats(filaId, stats);
      }

      logger.info(`Bulk devolver IA: ${sucesso.length} ok, ${erros.length} erros`);
      reply.send({ success: true, data: { sucesso: sucesso.length, erros } });
    } catch (error) {
      await client.query('ROLLBACK');
      logger.error('Error bulk devolver:', error);
      throw error;
    } finally {
      client.release();
    }
  });
}