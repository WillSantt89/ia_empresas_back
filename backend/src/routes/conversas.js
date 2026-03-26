import { pool } from '../config/database.js';
import { logger } from '../config/logger.js';
import { isMembroDaFila, verificarCapacidadeOperador, calcularStatsFila } from '../services/fila-manager.js';
import { enviarMensagemWhatsApp } from '../services/chat-sender.js';
import { sendTextMessage, sendTemplateMessage, uploadMediaToMeta, sendMediaMessage } from '../services/whatsapp-sender.js';
import { bulkOperationsQueue } from '../queues/queues.js';
import { decrypt } from '../config/encryption.js';
import { saveMedia } from '../services/media-storage.js';
import { addToHistory, archiveConversation } from '../services/memory.js';
import { clearFlowState } from '../services/flow-engine.js';
import {
  emitConversaAtribuida, emitConversaAtualizada,
  emitNovaConversaNaFila, emitFilaStats, emitToUser,
  emitNovaMensagem,
} from '../services/websocket.js';
import { validarValorCampo } from './campos-personalizados.js';


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

  // Busca unificada — nome, telefone, ticket, CPF, email, conteúdo de mensagens
  fastify.get('/busca', {
    preHandler: [
      fastify.authenticate,
      fastify.addTenantFilter,
      fastify.requirePermission('conversas', 'read')
    ],
    schema: {
      querystring: {
        type: 'object',
        properties: {
          q: { type: 'string', minLength: 2 },
          page: { type: 'integer', minimum: 1, default: 1 },
          per_page: { type: 'integer', minimum: 1, maximum: 50, default: 20 }
        },
        required: ['q']
      }
    }
  }, async (request, reply) => {
    try {
      const { empresaId } = request;
      const { q, page, per_page } = request.query;
      const searchTerm = `%${q.trim()}%`;

      // 3 queries em paralelo
      const [conversasResult, contatosResult, mensagensResult] = await Promise.all([
        // 1. Conversas — por ticket, nome, whatsapp
        pool.query(`
          SELECT c.id, c.numero_ticket, c.contato_nome, c.contato_whatsapp, c.contato_id,
                 c.status, c.controlado_por, c.fila_id, c.operador_nome, c.prioridade,
                 c.criado_em, c.atualizado_em,
                 f.nome as fila_nome, f.cor as fila_cor
          FROM conversas c
          LEFT JOIN filas_atendimento f ON f.id = c.fila_id
          WHERE c.empresa_id = $1
            AND (
              c.contato_nome ILIKE $2
              OR c.contato_whatsapp ILIKE $2
              OR CAST(c.numero_ticket AS TEXT) ILIKE $2
            )
          ORDER BY c.atualizado_em DESC
          LIMIT $3 OFFSET $4
        `, [empresaId, searchTerm, per_page, (page - 1) * per_page]),

        // 2. Contatos — por nome, whatsapp, email, CPF
        pool.query(`
          SELECT ct.id, ct.nome, ct.whatsapp, ct.email,
                 ct.dados_json->>'cpf' as cpf,
                 (SELECT COUNT(*) FROM conversas c2 WHERE c2.contato_id = ct.id AND c2.status = 'ativo') as conversas_ativas
          FROM contatos ct
          WHERE ct.empresa_id = $1 AND ct.ativo = true
            AND (
              ct.nome ILIKE $2
              OR ct.whatsapp ILIKE $2
              OR ct.email ILIKE $2
              OR ct.dados_json->>'cpf' ILIKE $2
            )
          ORDER BY ct.nome
          LIMIT 10
        `, [empresaId, searchTerm]),

        // 3. Mensagens — conteúdo (últimos 30 dias)
        pool.query(`
          SELECT ml.id as mensagem_id, ml.conversa_id, ml.conteudo, ml.criado_em, ml.direcao,
                 c.numero_ticket, c.contato_nome, c.contato_whatsapp, c.status as conversa_status,
                 c.fila_id
          FROM mensagens_log ml
          JOIN conversas c ON c.id = ml.conversa_id
          WHERE ml.empresa_id = $1
            AND ml.criado_em >= NOW() - INTERVAL '30 days'
            AND ml.conteudo ILIKE $2
            AND ml.tipo_mensagem = 'text'
          ORDER BY ml.criado_em DESC
          LIMIT 15
        `, [empresaId, searchTerm])
      ]);

      return {
        success: true,
        data: {
          conversas: conversasResult.rows,
          contatos: contatosResult.rows,
          mensagens: mensagensResult.rows,
        }
      };
    } catch (error) {
      logger.error('Error in busca unificada:', error);
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
          a.nome as agente_nome,
          a.tipo as agente_tipo,
          a.modelo_llm as agente_modelo,
          ai.nome as agente_inicial_nome,
          u.nome as humano_nome_atual,
          u.email as humano_email,
          wn.numero_formatado as numero_whatsapp,
          wn.nome_exibicao as conexao_nome,
          wn.numero_formatado as conexao_numero,
          ct.id as contato_id_ref,
          ct.email as contato_email,
          ct.observacoes as contato_observacoes,
          ct.dados_json as contato_dados_json
        FROM conversas c
        LEFT JOIN inboxes i ON i.id = c.inbox_id
        LEFT JOIN agentes a ON a.id = c.agente_id
        LEFT JOIN agentes ai ON ai.id = c.agente_inicial_id
        LEFT JOIN usuarios u ON u.id = c.humano_id
        LEFT JOIN whatsapp_numbers wn ON wn.id = c.whatsapp_number_id
        LEFT JOIN contatos ct ON ct.id = c.contato_id
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
            tipo_mensagem,
            midia_url,
            midia_mime_type,
            midia_nome_arquivo,
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

      // Detalhes das conexões WhatsApp (multi-conexão)
      if (conversa.conexoes_whatsapp && conversa.conexoes_whatsapp.length > 0) {
        const wnIds = conversa.conexoes_whatsapp.map(c => c.wn_id).filter(Boolean);
        if (wnIds.length > 0) {
          const wnResult = await pool.query(
            `SELECT id, numero_formatado, nome_exibicao FROM whatsapp_numbers WHERE id = ANY($1::uuid[])`,
            [wnIds]
          );
          const wnMap = {};
          wnResult.rows.forEach(w => { wnMap[w.id] = w; });
          conversa.conexoes_whatsapp_detalhes = conversa.conexoes_whatsapp.map(c => ({
            ...c,
            ...(wnMap[c.wn_id] || {}),
            is_ativa: c.wn_id === (conversa.conexao_ativa_id || '')
          }));
        }
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
          cch.mensagem_retorno_ia
        FROM conversas c
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
          atualizado_em = NOW(),
          followup_count = 0,
          followup_ultimo_em = NULL
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
        ORDER BY ch.criado_em ASC
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

      const conversa = conversaResult.rows[0];

      // Verificar campos obrigatórios na resolução
      const camposObrigatorios = await client.query(
        `SELECT display_name, chave, contexto FROM campos_personalizados
         WHERE empresa_id = $1 AND obrigatorio_resolucao = true AND ativo = true`,
        [empresaId]
      );

      if (camposObrigatorios.rows.length > 0) {
        const conversaDados = conversa.dados_json || {};
        let contatoDados = {};
        if (conversa.contato_id) {
          const contatoRes = await client.query('SELECT dados_json FROM contatos WHERE id = $1', [conversa.contato_id]);
          if (contatoRes.rows.length > 0) contatoDados = contatoRes.rows[0].dados_json || {};
        }

        const faltantes = [];
        for (const campo of camposObrigatorios.rows) {
          const dados = campo.contexto === 'contato' ? contatoDados : conversaDados;
          const valor = dados[campo.chave];
          if (!valor || (typeof valor === 'string' && valor.trim() === '')) {
            faltantes.push({ display_name: campo.display_name, chave: campo.chave, contexto: campo.contexto });
          }
        }

        if (faltantes.length > 0) {
          await client.query('ROLLBACK');
          return reply.code(400).send({
            success: false,
            error: {
              code: 'CAMPOS_OBRIGATORIOS_FALTANTES',
              message: `Preencha os campos obrigatorios antes de finalizar: ${faltantes.map(f => f.display_name).join(', ')}`,
              details: { campos_faltantes: faltantes },
            }
          });
        }
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

      // Log no controle_historico
      const user = request.user;
      await client.query(`
        INSERT INTO controle_historico (conversa_id, empresa_id, acao, de_controlador, para_controlador, humano_id, humano_nome, motivo)
        VALUES ($1, $2, 'finalizado', $3, NULL, $4, $5, 'Finalizado via painel')
      `, [id, empresaId, conversa.controlado_por, user.id, user.nome || user.email]);

      await client.query('COMMIT');

      logger.info(`Conversa ${id} finalized`);

      // Arquivar histórico Redis (move para archive com 30d TTL, limpa conv ativa)
      const conversationKey = `whatsapp:${conversa.contato_whatsapp}`;
      archiveConversation(empresaId, conversationKey).catch(err => {
        logger.error('Failed to archive Redis history on finalize', { conversa_id: id, error: err.message });
      });

      // Limpar estado do chatbot para que próxima mensagem reinicie o fluxo
      clearFlowState(empresaId, conversa.contato_whatsapp).catch(err => {
        logger.error('Failed to clear chatbot flow state on finalize', { conversa_id: id, error: err.message });
      });

      // WebSocket: notificar fila
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
  // GET /:id/historico — Histórico de controle da conversa
  // ============================================
  fastify.get('/:id/historico', {
    preHandler: [
      fastify.authenticate,
      fastify.addTenantFilter,
      fastify.requirePermission('conversas', 'read')
    ]
  }, async (request, reply) => {
    const { id } = request.params;
    const { empresaId } = request;

    const result = await pool.query(`
      SELECT ch.id, ch.acao, ch.de_controlador, ch.para_controlador,
             ch.humano_id, ch.humano_nome, ch.motivo, ch.criado_em
      FROM controle_historico ch
      WHERE ch.conversa_id = $1 AND ch.empresa_id = $2
      ORDER BY ch.criado_em ASC
    `, [id, empresaId]);

    reply.send({ success: true, data: result.rows });
  });

  // ============================================
  // POST /:id/reabrir — Reabrir conversa finalizada/timeout
  // ============================================
  fastify.post('/:id/reabrir', {
    preHandler: [
      fastify.authenticate,
      fastify.addTenantFilter,
      fastify.requirePermission('conversas', 'write')
    ]
  }, async (request, reply) => {
    try {
      const { id } = request.params;
      const { empresaId, user } = request;

      // Buscar conversa finalizada ou timeout
      const conversaResult = await pool.query(
        `SELECT * FROM conversas WHERE id = $1 AND empresa_id = $2 AND status IN ('finalizado', 'timeout')`,
        [id, empresaId]
      );
      if (conversaResult.rows.length === 0) {
        return reply.code(404).send({
          success: false,
          error: { message: 'Conversa finalizada/timeout não encontrada' }
        });
      }

      const conversa = conversaResult.rows[0];

      // Reabrir: atribuída ao operador que clicou em reabrir
      const operadorId = user.id;
      const operadorNome = user.nome || user.email;

      await pool.query(`
        UPDATE conversas SET
          status = 'ativo',
          controlado_por = 'humano',
          operador_id = $1,
          operador_nome = $2,
          operador_atribuido_em = NOW(),
          humano_id = $1,
          humano_nome = $2,
          humano_assumiu_em = NOW(),
          snoozed_ate = NULL,
          atualizado_em = NOW()
        WHERE id = $3
      `, [operadorId, operadorNome, id]);

      // Registrar no histórico
      await pool.query(`
        INSERT INTO controle_historico (conversa_id, empresa_id, acao, de_controlador, para_controlador, humano_id, humano_nome, motivo)
        VALUES ($1, $2, 'reaberta', $3, 'humano', $4, $5, 'Reaberta via painel')
      `, [id, empresaId, conversa.controlado_por || conversa.status, operadorId, operadorNome]);

      // WebSocket
      emitConversaAtualizada(id, conversa.fila_id, {
        id,
        status: 'ativo',
        controlado_por: 'humano',
        operador_id: operadorId,
        operador_nome: operadorNome,
      });
      if (conversa.fila_id) {
        const stats = await calcularStatsFila(conversa.fila_id);
        emitFilaStats(conversa.fila_id, stats);
      }

      logger.info(`Conversa ${id} reaberta por ${user.nome || user.email}`);
      reply.send({ success: true, data: { message: 'Conversa reaberta com sucesso' } });
    } catch (error) {
      logger.error('Erro ao reabrir conversa:', { error: error.message, stack: error.stack, params: request.params });
      reply.code(500).send({ success: false, error: { message: 'Erro ao reabrir conversa', detail: error.message } });
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
    try {
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
           humano_assumiu_em = NOW(), humano_ultima_msg_em = NOW(), atualizado_em = NOW(),
           lida = true, lida_em = NOW(), lida_por = $1
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
    } catch (error) {
      logger.error('Erro ao atribuir conversa:', { error: error.message, stack: error.stack, params: request.params });
      reply.code(500).send({ success: false, error: { message: 'Erro ao atribuir conversa', detail: error.message } });
    }
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
    try {
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
           controlado_por = $1, atualizado_em = NOW(),
           lida = false, lida_em = NULL, lida_por = NULL,
           followup_count = 0, followup_ultimo_em = NULL
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
    } catch (error) {
      logger.error('Erro ao desatribuir conversa:', { error: error.message, stack: error.stack, params: request.params });
      reply.code(500).send({ success: false, error: { message: 'Erro ao desatribuir conversa', detail: error.message } });
    }
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
    try {
      const { id } = request.params;
      const { empresaId, user } = request;
      const { fila_id, motivo } = request.body || {};

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

      // Operador precisa pertencer a fila de ORIGEM (ou ser o atribuido) para transferir
      if (user.role === 'operador') {
        const conversaCheck = await pool.query(
          `SELECT fila_id, operador_id FROM conversas WHERE id = $1 AND empresa_id = $2`,
          [id, empresaId]
        );
        if (conversaCheck.rows.length > 0) {
          const conv = conversaCheck.rows[0];
          const isAtribuido = conv.operador_id === user.id;
          const isMembroOrigem = conv.fila_id ? await isMembroDaFila(user.id, conv.fila_id) : false;
          if (!isAtribuido && !isMembroOrigem) {
            return reply.code(403).send({ success: false, error: { message: 'Sem permissao para transferir esta conversa' } });
          }
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
           controlado_por = 'fila', atualizado_em = NOW(),
           lida = false, lida_em = NULL, lida_por = NULL
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
    } catch (error) {
      logger.error('Erro ao transferir conversa para fila:', { error: error.message, stack: error.stack, params: request.params, body: request.body });
      reply.code(500).send({ success: false, error: { message: 'Erro ao transferir conversa', detail: error.message } });
    }
  });

  // ============================================
  // POST /:id/transferir-operador — Transferir para outro operador
  // ============================================
  fastify.post('/:id/transferir-operador', {
    preHandler: [
      fastify.authenticate,
      fastify.addTenantFilter,
      fastify.requirePermission('conversas', 'write')
    ]
  }, async (request, reply) => {
    try {
      const { id } = request.params;
      const { empresaId, user } = request;
      const { operador_id, motivo } = request.body || {};

      if (!operador_id) {
        return reply.code(400).send({ success: false, error: { message: 'operador_id e obrigatorio' } });
      }

      if (operador_id === user.id) {
        return reply.code(400).send({ success: false, error: { message: 'Nao pode transferir para si mesmo' } });
      }

      // Buscar conversa ativa
      const conversaResult = await pool.query(
        `SELECT * FROM conversas WHERE id = $1 AND empresa_id = $2 AND status IN ('ativo', 'pendente')`,
        [id, empresaId]
      );
      if (conversaResult.rows.length === 0) {
        return reply.code(404).send({ success: false, error: { message: 'Conversa ativa nao encontrada' } });
      }
      const conversa = conversaResult.rows[0];

      // Operador so pode transferir se for o atribuido atual ou membro da fila
      if (user.role === 'operador') {
        const isAtribuido = conversa.operador_id === user.id;
        const isMembroOrigem = conversa.fila_id ? await isMembroDaFila(user.id, conversa.fila_id) : false;
        if (!isAtribuido && !isMembroOrigem) {
          return reply.code(403).send({ success: false, error: { message: 'Sem permissao para transferir esta conversa' } });
        }
      }

      // Validar operador destino existe e esta ativo na mesma empresa
      const destResult = await pool.query(
        `SELECT id, nome, role FROM usuarios WHERE id = $1 AND empresa_id = $2 AND ativo = true`,
        [operador_id, empresaId]
      );
      if (destResult.rows.length === 0) {
        return reply.code(404).send({ success: false, error: { message: 'Operador destino nao encontrado' } });
      }
      const destOperador = destResult.rows[0];

      // Se a conversa tem fila, verificar se operador destino e membro
      if (conversa.fila_id) {
        const isMembroDest = await isMembroDaFila(operador_id, conversa.fila_id);
        if (!isMembroDest) {
          return reply.code(400).send({ success: false, error: { message: `${destOperador.nome} nao pertence a fila desta conversa` } });
        }
      }

      // Verificar capacidade do operador destino
      const temCapacidade = await verificarCapacidadeOperador(operador_id);
      if (!temCapacidade) {
        return reply.code(400).send({ success: false, error: { message: `${destOperador.nome} atingiu o limite de conversas simultaneas` } });
      }

      // Transferir
      await pool.query(
        `UPDATE conversas SET
           operador_id = $1, operador_nome = $2, operador_atribuido_em = NOW(),
           controlado_por = 'humano', humano_id = $1, humano_nome = $2,
           humano_assumiu_em = NOW(), humano_ultima_msg_em = NOW(), atualizado_em = NOW(),
           lida = false, lida_em = NULL, lida_por = NULL
         WHERE id = $3`,
        [operador_id, destOperador.nome, id]
      );

      // Registrar historico
      await pool.query(
        `INSERT INTO controle_historico
           (conversa_id, empresa_id, acao, de_controlador, para_controlador, humano_id, humano_nome, motivo)
         VALUES ($1, $2, 'transferencia_operador', 'humano', 'humano', $3, $4, $5)`,
        [id, empresaId, operador_id, destOperador.nome, motivo || `Transferido de ${user.nome} para ${destOperador.nome}`]
      );

      // WebSocket: notificar operador anterior e novo
      const dados = { id, operador_id, operador_nome: destOperador.nome, controlado_por: 'humano' };
      emitConversaAtribuida(id, conversa.fila_id, operador_id, dados);
      // Notificar operador anterior que a conversa foi removida
      if (conversa.operador_id && conversa.operador_id !== operador_id) {
        emitToUser(conversa.operador_id, 'conversa:transferida', { conversa_id: id, para_operador: destOperador.nome });
      }
      if (conversa.fila_id) {
        const stats = await calcularStatsFila(conversa.fila_id);
        emitFilaStats(conversa.fila_id, stats);
      }

      logger.info(`Conversa ${id} transferida de ${user.nome} para ${destOperador.nome}`);
      reply.send({ success: true, data: { message: `Transferida para ${destOperador.nome}`, operador_nome: destOperador.nome } });
    } catch (error) {
      logger.error('Erro ao transferir conversa para operador:', { error: error.message, stack: error.stack, params: request.params, body: request.body });
      reply.code(500).send({ success: false, error: { message: 'Erro ao transferir conversa', detail: error.message } });
    }
  });

  // ============================================
  // POST /:id/marcar-lida — Marcar conversa como lida/não lida
  // ============================================
  fastify.post('/:id/marcar-lida', {
    preHandler: [
      fastify.authenticate,
      fastify.addTenantFilter,
      fastify.requirePermission('conversas', 'write')
    ]
  }, async (request, reply) => {
    try {
      const { id } = request.params;
      const { empresaId, user } = request;
      const { lida } = request.body || {};

      if (typeof lida !== 'boolean') {
        return reply.code(400).send({ success: false, error: { message: 'Campo lida (boolean) e obrigatorio' } });
      }

      const result = await pool.query(
        `UPDATE conversas SET lida = $1, lida_em = $2, lida_por = $3, atualizado_em = NOW()
         WHERE id = $4 AND empresa_id = $5 AND status IN ('ativo', 'pendente')
         RETURNING id, fila_id`,
        [lida, lida ? new Date() : null, lida ? user.id : null, id, empresaId]
      );

      if (result.rows.length === 0) {
        return reply.code(404).send({ success: false, error: { message: 'Conversa ativa nao encontrada' } });
      }

      // WebSocket notification
      emitConversaAtualizada(id, result.rows[0].fila_id, { id, lida });

      reply.send({ success: true, data: { lida } });
    } catch (error) {
      logger.error('Erro ao marcar conversa como lida:', { error: error.message });
      reply.code(500).send({ success: false, error: { message: 'Erro ao marcar lida', detail: error.message } });
    }
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
  // GET /:id/atributos — Obter definicoes + valores preenchidos
  // ============================================
  fastify.get('/:id/atributos', {
    preHandler: [
      fastify.authenticate,
      fastify.addTenantFilter,
      fastify.requirePermission('conversas', 'read'),
    ],
  }, async (request, reply) => {
    const { id } = request.params;
    const { empresaId } = request;

    // Buscar conversa
    const conv = await pool.query(
      `SELECT id, contato_id, dados_json FROM conversas WHERE id = $1 AND empresa_id = $2`,
      [id, empresaId]
    );
    if (conv.rows.length === 0) {
      return reply.status(404).send({ success: false, error: { message: 'Conversa nao encontrada' } });
    }

    const conversa = conv.rows[0];

    // Buscar dados do contato (se vinculado)
    let contatoDados = {};
    if (conversa.contato_id) {
      const contato = await pool.query(
        `SELECT dados_json FROM contatos WHERE id = $1`,
        [conversa.contato_id]
      );
      if (contato.rows.length > 0) {
        contatoDados = contato.rows[0].dados_json || {};
      }
    }

    // Buscar campos definidos
    const campos = await pool.query(
      `SELECT id, display_name, chave, tipo, contexto, descricao, opcoes, regex_pattern, regex_mensagem, valor_padrao, obrigatorio_resolucao, ordem
       FROM campos_personalizados WHERE empresa_id = $1 AND ativo = true ORDER BY contexto, ordem, display_name`,
      [empresaId]
    );

    const conversaDados = conversa.dados_json || {};

    // Montar resposta agrupada
    const resultado = {
      contato: campos.rows
        .filter(c => c.contexto === 'contato')
        .map(c => ({
          ...c,
          valor: contatoDados[c.chave] !== undefined ? contatoDados[c.chave] : (c.valor_padrao || ''),
        })),
      atendimento: campos.rows
        .filter(c => c.contexto === 'atendimento')
        .map(c => ({
          ...c,
          valor: conversaDados[c.chave] !== undefined ? conversaDados[c.chave] : (c.valor_padrao || ''),
        })),
    };

    reply.send({ success: true, data: resultado });
  });

  // ============================================
  // PUT /:id/atributos — Salvar atributos do atendimento
  // ============================================
  fastify.put('/:id/atributos', {
    preHandler: [
      fastify.authenticate,
      fastify.addTenantFilter,
      fastify.requirePermission('conversas', 'write'),
    ],
  }, async (request, reply) => {
    const { id } = request.params;
    const { empresaId } = request;
    const atributos = request.body;

    // Buscar conversa
    const conv = await pool.query(
      `SELECT id, dados_json FROM conversas WHERE id = $1 AND empresa_id = $2`,
      [id, empresaId]
    );
    if (conv.rows.length === 0) {
      return reply.status(404).send({ success: false, error: { message: 'Conversa nao encontrada' } });
    }

    // Buscar campos definidos para atendimento
    const camposResult = await pool.query(
      `SELECT * FROM campos_personalizados WHERE empresa_id = $1 AND contexto = 'atendimento' AND ativo = true`,
      [empresaId]
    );
    const camposMap = {};
    for (const c of camposResult.rows) {
      camposMap[c.chave] = c;
    }

    // Validar e montar dados
    const dadosAtuais = conv.rows[0].dados_json || {};
    const erros = [];

    for (const [chave, valor] of Object.entries(atributos)) {
      const campo = camposMap[chave];
      if (!campo) {
        dadosAtuais[chave] = valor;
        continue;
      }

      const validacao = validarValorCampo(campo, valor);
      if (!validacao.valido) {
        erros.push(validacao.erro);
        continue;
      }

      dadosAtuais[chave] = validacao.valor;
    }

    if (erros.length > 0) {
      return reply.status(400).send({
        success: false,
        error: { message: erros.join('; '), details: erros }
      });
    }

    // Salvar
    const result = await pool.query(
      `UPDATE conversas SET dados_json = $1, atualizado_em = NOW()
       WHERE id = $2 AND empresa_id = $3 RETURNING id, dados_json`,
      [JSON.stringify(dadosAtuais), id, empresaId]
    );

    logger.info(`Atributos atendimento atualizados`, { empresa_id: empresaId, conversa_id: id, chaves: Object.keys(atributos) });

    reply.send({ success: true, data: result.rows[0] });
  });

  // ============================================
  // PUT /:id/conexao-ativa — Operador escolhe conexão WhatsApp ativa
  // ============================================
  fastify.put('/:id/conexao-ativa', {
    preHandler: [
      fastify.authenticate,
      fastify.addTenantFilter,
      fastify.requirePermission('conversas', 'write')
    ],
    schema: {
      params: { type: 'object', properties: { id: { type: 'string', format: 'uuid' } }, required: ['id'] },
      body: { type: 'object', properties: { whatsapp_number_id: { type: 'string', format: 'uuid' } }, required: ['whatsapp_number_id'] }
    }
  }, async (request, reply) => {
    try {
      const { id } = request.params;
      const { whatsapp_number_id } = request.body;

      // Verificar conversa
      const conversaResult = await pool.query(
        `SELECT id, conexoes_whatsapp FROM conversas WHERE id = $1 AND empresa_id = $2`,
        [id, request.empresaId]
      );
      if (conversaResult.rows.length === 0) {
        return reply.code(404).send({ success: false, error: { message: 'Conversa nao encontrada' } });
      }

      // Verificar se o whatsapp_number_id pertence à empresa e está ativo
      const wnResult = await pool.query(
        `SELECT id, numero_formatado, nome_exibicao FROM whatsapp_numbers WHERE id = $1 AND empresa_id = $2 AND ativo = true`,
        [whatsapp_number_id, request.empresaId]
      );
      if (wnResult.rows.length === 0) {
        return reply.code(400).send({ success: false, error: { message: 'Numero WhatsApp nao encontrado ou inativo' } });
      }

      // Atualizar conexão ativa
      await pool.query(
        `UPDATE conversas SET conexao_ativa_id = $1, atualizado_em = NOW() WHERE id = $2`,
        [whatsapp_number_id, id]
      );

      logger.info(`Conexao ativa alterada para conversa ${id}: ${whatsapp_number_id} por ${request.user.nome}`);
      reply.send({ success: true, data: { conexao_ativa_id: whatsapp_number_id, numero_formatado: wnResult.rows[0].numero_formatado, nome_exibicao: wnResult.rows[0].nome_exibicao } });
    } catch (error) {
      logger.error('Erro ao alterar conexao ativa:', error);
      reply.code(500).send({ success: false, error: { message: 'Erro interno' } });
    }
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

    // Validar janela 24h do WhatsApp (null = cliente nunca respondeu)
    if (!conversa.ultima_msg_entrada_em) {
      return reply.code(403).send({
        success: false,
        error: { code: 'WINDOW_NOT_OPEN', message: 'Aguardando resposta do cliente. Envie um template para iniciar.' }
      });
    } else {
      const diffMs = Date.now() - new Date(conversa.ultima_msg_entrada_em).getTime();
      if (diffMs > 24 * 60 * 60 * 1000) {
        return reply.code(403).send({
          success: false,
          error: { code: 'WINDOW_EXPIRED', message: 'Janela de 24h expirada. Envie um template para reabrir.' }
        });
      }
    }

    // Operador so pode enviar se for membro da fila
    if (user.role === 'operador' && conversa.fila_id) {
      const isMembro = await isMembroDaFila(user.id, conversa.fila_id);
      if (!isMembro) {
        return reply.code(403).send({ success: false, error: { message: 'Sem acesso a esta conversa' } });
      }
    }

    // Registrar intervenção se admin/master/supervisor envia sem estar atribuído
    // Só registra se não houver intervencao_admin deste user nos últimos 5 minutos (evita spam)
    const isAtribuido = conversa.operador_id === user.id;
    if (!isAtribuido && ['master', 'admin', 'supervisor'].includes(user.role)) {
      pool.query(
        `INSERT INTO controle_historico (conversa_id, empresa_id, acao, de_controlador, para_controlador, humano_id, humano_nome, motivo)
         SELECT $1, $2, 'intervencao_admin', $3, $3, $4, $5, $6
         WHERE NOT EXISTS (
           SELECT 1 FROM controle_historico
           WHERE conversa_id = $1 AND acao = 'intervencao_admin' AND humano_id = $4
             AND criado_em > NOW() - INTERVAL '5 minutes'
         )`,
        [conversa_id, request.empresaId, conversa.controlado_por, user.id, user.nome || user.email, `${user.role} enviou mensagem sem estar atribuído`]
      ).catch(err => logger.error('Erro ao registrar intervencao_admin:', { error: err.message }));
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

  // POST /nota-privada — Nota privada (não envia ao WhatsApp)
  fastify.post('/nota-privada', {
    preHandler: [
      fastify.authenticate,
      fastify.addTenantFilter,
      fastify.requirePermission('conversas', 'write')
    ]
  }, async (request, reply) => {
    const { user } = request;
    const empresaId = request.empresaId || request.user.empresa_id;
    const { conversa_id, conteudo } = request.body;

    if (!conversa_id || !conteudo) {
      return reply.code(400).send({ success: false, error: { message: 'conversa_id e conteudo são obrigatórios' } });
    }

    // Verificar conversa existe
    const conversaResult = await pool.query(
      'SELECT id, fila_id FROM conversas WHERE id = $1 AND empresa_id = $2',
      [conversa_id, empresaId]
    );
    if (conversaResult.rows.length === 0) {
      return reply.code(404).send({ success: false, error: { message: 'Conversa não encontrada' } });
    }

    try {
      const result = await pool.query(`
        INSERT INTO mensagens_log (conversa_id, empresa_id, direcao, conteudo, remetente_tipo, remetente_id, remetente_nome, tipo_mensagem, criado_em)
        VALUES ($1, $2, 'saida', $3, 'nota_privada', $4, $5, 'text', NOW())
        RETURNING id, criado_em
      `, [conversa_id, empresaId, conteudo.trim(), user.id, user.nome || user.email]);

      const nota = result.rows[0];
      const fila_id = conversaResult.rows[0].fila_id;

      // Emitir WebSocket para operadores verem em tempo real
      emitNovaMensagem(conversa_id, fila_id, {
        id: nota.id,
        conversa_id,
        conteudo: conteudo.trim(),
        direcao: 'saida',
        remetente_tipo: 'nota_privada',
        remetente_nome: user.nome || user.email,
        tipo_mensagem: 'text',
        criado_em: nota.criado_em,
      });

      reply.send({ success: true, data: nota });
    } catch (error) {
      logger.error('Erro ao salvar nota privada:', error);
      reply.code(500).send({ success: false, error: { message: 'Erro ao salvar nota privada' } });
    }
  });

  // ============================================
  // POST /enviar-template — Operador envia template WhatsApp
  // ============================================
  fastify.post('/enviar-template', {
    preHandler: [
      fastify.authenticate,
      fastify.addTenantFilter,
      fastify.requirePermission('conversas', 'write')
    ]
  }, async (request, reply) => {
    const { user } = request;
    const { conversa_id, template_name, language_code = 'pt_BR', components = [], template_body } = request.body;

    if (!conversa_id || !template_name) {
      return reply.code(400).send({ success: false, error: { message: 'conversa_id e template_name sao obrigatorios' } });
    }

    // Verificar conversa
    const conversaResult = await pool.query(
      `SELECT c.*, ct.nome as contato_nome FROM conversas c
       LEFT JOIN contatos ct ON ct.empresa_id = c.empresa_id AND ct.whatsapp = c.contato_whatsapp
       WHERE c.id = $1 AND c.empresa_id = $2`,
      [conversa_id, request.empresaId]
    );
    if (conversaResult.rows.length === 0) {
      return reply.code(404).send({ success: false, error: { message: 'Conversa nao encontrada' } });
    }

    const conversa = conversaResult.rows[0];

    if (!conversa.contato_whatsapp) {
      return reply.code(400).send({ success: false, error: { message: 'Conversa sem contato WhatsApp' } });
    }

    // Operador so pode enviar se for membro da fila
    if (user.role === 'operador' && conversa.fila_id) {
      const isMembro = await isMembroDaFila(user.id, conversa.fila_id);
      if (!isMembro) {
        return reply.code(403).send({ success: false, error: { message: 'Sem acesso a esta conversa' } });
      }
    }

    // Buscar numero WhatsApp — conexao_ativa_id > whatsapp_number_id > fallback FIFO
    const wnIdEscolhido = conversa.conexao_ativa_id || conversa.whatsapp_number_id;
    const wnQuery = wnIdEscolhido
      ? `SELECT id, phone_number_id, token_graph_api FROM whatsapp_numbers WHERE id = $1 AND ativo = true`
      : `SELECT id, phone_number_id, token_graph_api FROM whatsapp_numbers WHERE empresa_id = $1 AND ativo = true ORDER BY criado_em ASC LIMIT 1`;
    const wnParam = wnIdEscolhido || conversa.empresa_id;
    const whatsappResult = await pool.query(wnQuery, [wnParam]);
    if (whatsappResult.rows.length === 0) {
      return reply.code(400).send({ success: false, error: { message: 'Nenhum numero WhatsApp ativo' } });
    }

    const whatsappNumber = whatsappResult.rows[0];
    const token = decrypt(whatsappNumber.token_graph_api);
    if (!token) {
      return reply.code(500).send({ success: false, error: { message: 'Token WhatsApp invalido' } });
    }

    try {
      // Montar texto do template para salvar no log
      const templateLabel = template_body
        ? `[Template: ${template_name}]\n${template_body}`
        : `[Template: ${template_name}]`;

      // Salvar em mensagens_log
      const msgResult = await pool.query(
        `INSERT INTO mensagens_log
           (conversa_id, empresa_id, direcao, conteudo, remetente_tipo, remetente_id, remetente_nome, status_entrega)
         VALUES ($1, $2, 'saida', $3, 'operador', $4, $5, 'sending')
         RETURNING *`,
        [conversa_id, conversa.empresa_id, templateLabel, user.id, user.nome]
      );

      const mensagem = msgResult.rows[0];

      // Enviar via Meta API
      const result = await sendTemplateMessage(
        whatsappNumber.phone_number_id,
        token,
        conversa.contato_whatsapp,
        template_name,
        language_code,
        components
      );

      if (result.success) {
        await pool.query(
          `UPDATE mensagens_log SET status_entrega = 'sent', whatsapp_message_id = $1 WHERE id = $2`,
          [result.wamid, mensagem.id]
        );
        mensagem.status_entrega = 'sent';
        mensagem.whatsapp_message_id = result.wamid;
      } else {
        await pool.query(
          `UPDATE mensagens_log SET status_entrega = 'failed', erro = $1 WHERE id = $2`,
          [result.error, mensagem.id]
        );
        mensagem.status_entrega = 'failed';
        return reply.code(502).send({ success: false, error: { message: result.error } });
      }

      // Atualizar conversa
      await pool.query(
        `UPDATE conversas SET atualizado_em = NOW() WHERE id = $1`,
        [conversa_id]
      );

      // Emitir WebSocket
      emitNovaMensagem(conversa_id, conversa.fila_id, {
        id: mensagem.id,
        conversa_id,
        conteudo: templateLabel,
        direcao: 'saida',
        remetente_tipo: 'operador',
        remetente_id: user.id,
        remetente_nome: user.nome,
        status_entrega: mensagem.status_entrega,
        criado_em: mensagem.criado_em,
      });

      reply.send({ success: true, data: mensagem });
    } catch (error) {
      logger.error('Erro enviando template:', error);
      reply.code(500).send({ success: false, error: { message: error.message } });
    }
  });

  // ============================================
  // POST /enviar-midia — Operador envia mídia WhatsApp
  // ============================================
  fastify.post('/enviar-midia', {
    preHandler: [
      fastify.authenticate,
      fastify.addTenantFilter,
      fastify.requirePermission('conversas', 'write')
    ]
  }, async (request, reply) => {
    const { user } = request;

    const data = await request.file();
    if (!data) {
      return reply.code(400).send({ success: false, error: { message: 'Arquivo obrigatorio' } });
    }

    const conversaId = data.fields?.conversa_id?.value;
    const caption = data.fields?.caption?.value || '';
    const forceMediaType = data.fields?.media_type?.value || null; // 'sticker' para forçar envio como figurinha

    if (!conversaId) {
      return reply.code(400).send({ success: false, error: { message: 'conversa_id obrigatorio' } });
    }

    // Verificar conversa
    const conversaResult = await pool.query(
      `SELECT * FROM conversas WHERE id = $1 AND empresa_id = $2`,
      [conversaId, request.empresaId]
    );
    if (conversaResult.rows.length === 0) {
      return reply.code(404).send({ success: false, error: { message: 'Conversa nao encontrada' } });
    }
    const conversa = conversaResult.rows[0];

    if (!conversa.contato_whatsapp) {
      return reply.code(400).send({ success: false, error: { message: 'Conversa sem contato WhatsApp' } });
    }

    // Validar janela 24h do WhatsApp (null = cliente nunca respondeu)
    if (!conversa.ultima_msg_entrada_em) {
      return reply.code(403).send({
        success: false,
        error: { code: 'WINDOW_NOT_OPEN', message: 'Aguardando resposta do cliente. Envie um template para iniciar.' }
      });
    } else {
      const diffMs = Date.now() - new Date(conversa.ultima_msg_entrada_em).getTime();
      if (diffMs > 24 * 60 * 60 * 1000) {
        return reply.code(403).send({
          success: false,
          error: { code: 'WINDOW_EXPIRED', message: 'Janela de 24h expirada. Envie um template para reabrir.' }
        });
      }
    }

    // Operador so pode enviar se for membro da fila
    if (user.role === 'operador' && conversa.fila_id) {
      const isMembro = await isMembroDaFila(user.id, conversa.fila_id);
      if (!isMembro) {
        return reply.code(403).send({ success: false, error: { message: 'Sem acesso a esta conversa' } });
      }
    }

    // Buscar numero WhatsApp — conexao_ativa_id > whatsapp_number_id > fallback FIFO
    const wnIdEscolhido2 = conversa.conexao_ativa_id || conversa.whatsapp_number_id;
    const wnQuery = wnIdEscolhido2
      ? `SELECT id, phone_number_id, token_graph_api FROM whatsapp_numbers WHERE id = $1 AND ativo = true`
      : `SELECT id, phone_number_id, token_graph_api FROM whatsapp_numbers WHERE empresa_id = $1 AND ativo = true ORDER BY criado_em ASC LIMIT 1`;
    const wnParam = wnIdEscolhido2 || conversa.empresa_id;
    const whatsappResult = await pool.query(wnQuery, [wnParam]);
    if (whatsappResult.rows.length === 0) {
      return reply.code(400).send({ success: false, error: { message: 'Nenhum numero WhatsApp ativo' } });
    }

    const whatsappNumber = whatsappResult.rows[0];
    const token = decrypt(whatsappNumber.token_graph_api);
    if (!token) {
      return reply.code(500).send({ success: false, error: { message: 'Token WhatsApp invalido' } });
    }

    try {
      const buffer = await data.toBuffer();
      const mimeType = data.mimetype;
      const fileName = data.filename;

      // Determinar tipo WhatsApp
      let mediaType = 'document';
      if (forceMediaType === 'sticker') mediaType = 'sticker';
      else if (mimeType.startsWith('image/')) mediaType = 'image';
      else if (mimeType.startsWith('audio/')) mediaType = 'audio';
      else if (mimeType.startsWith('video/')) mediaType = 'video';

      // 1. Salvar arquivo localmente
      const saved = await saveMedia(buffer, conversa.empresa_id, mimeType, fileName);

      // 2. Upload para Meta e obter media_id (necessário para áudio PTT)
      const uploadResult = await uploadMediaToMeta(
        whatsappNumber.phone_number_id, token, buffer, mimeType
      );
      if (!uploadResult.success) {
        return reply.code(502).send({ success: false, error: { message: `Falha ao enviar mídia para Meta: ${uploadResult.error}` } });
      }

      // 3. Salvar em mensagens_log
      const conteudo = caption || `[${mediaType}: ${fileName}]`;
      const msgResult = await pool.query(
        `INSERT INTO mensagens_log
           (conversa_id, empresa_id, direcao, conteudo, remetente_tipo, remetente_id, remetente_nome,
            tipo_mensagem, midia_url, midia_mime_type, midia_nome_arquivo, midia_tamanho_bytes, status_entrega)
         VALUES ($1, $2, 'saida', $3, 'operador', $4, $5, $6, $7, $8, $9, $10, 'sending')
         RETURNING *`,
        [conversaId, conversa.empresa_id, conteudo, user.id, user.nome,
         mediaType, saved.relativePath, mimeType, fileName, saved.sizeBytes]
      );
      const mensagem = msgResult.rows[0];

      // 4. Adicionar ao histórico Redis
      const conversationKey = `whatsapp:${conversa.contato_whatsapp}`;
      try {
        await addToHistory(conversa.empresa_id, conversationKey, 'model', conteudo);
      } catch {}

      // 5. Enviar via Meta API usando media_id (upload direto = áudio chega como PTT)
      const sendResult = await sendMediaMessage(
        whatsappNumber.phone_number_id, token, conversa.contato_whatsapp,
        mediaType, uploadResult.media_id, caption || undefined, fileName
      );

      if (sendResult.success) {
        await pool.query(
          `UPDATE mensagens_log SET status_entrega = 'sent', whatsapp_message_id = $1 WHERE id = $2`,
          [sendResult.wamid, mensagem.id]
        );
        mensagem.status_entrega = 'sent';
        mensagem.whatsapp_message_id = sendResult.wamid;
      } else {
        await pool.query(
          `UPDATE mensagens_log SET status_entrega = 'failed', erro = $1 WHERE id = $2`,
          [sendResult.error, mensagem.id]
        );
        mensagem.status_entrega = 'failed';
      }

      // 6. Atualizar conversa
      await pool.query(`UPDATE conversas SET atualizado_em = NOW() WHERE id = $1`, [conversaId]);

      // 7. Emitir WebSocket
      emitNovaMensagem(conversaId, conversa.fila_id, {
        id: mensagem.id,
        conversa_id: conversaId,
        conteudo,
        direcao: 'saida',
        remetente_tipo: 'operador',
        remetente_id: user.id,
        remetente_nome: user.nome,
        tipo_mensagem: mediaType,
        midia_url: saved.relativePath,
        midia_mime_type: mimeType,
        midia_nome_arquivo: fileName,
        status_entrega: mensagem.status_entrega,
        criado_em: mensagem.criado_em,
      });

      reply.send({ success: true, data: mensagem });
    } catch (error) {
      logger.error('Erro enviando midia:', error);
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

    // Operador: filtrar apenas filas dele + conexões dele
    if (user.role === 'operador') {
      paramCount++;
      where += ` AND (c.fila_id IN (SELECT fm.fila_id FROM fila_membros fm WHERE fm.usuario_id = $${paramCount}) OR c.operador_id = $${paramCount})`;
      where += ` AND (
        c.whatsapp_number_id IS NULL
        OR NOT EXISTS (SELECT 1 FROM whatsapp_number_membros wnm2 WHERE wnm2.whatsapp_number_id = c.whatsapp_number_id)
        OR c.whatsapp_number_id IN (SELECT wnm.whatsapp_number_id FROM whatsapp_number_membros wnm WHERE wnm.usuario_id = $${paramCount})
        OR c.operador_id = $${paramCount}
      )`;
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
  // Registrado como sub-plugin com prefix /bulk
  // para evitar conflito com rotas parametricas /:id
  // ============================================
  fastify.register(async function bulkRoutes(bulk) {
    const BULK_LIMIT = 500;

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
    bulk.post('/atribuir', {
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

      const opResult = await pool.query(`SELECT nome FROM usuarios WHERE id = $1`, [operadorId]);
      const operadorNome = opResult.rows[0]?.nome || 'Desconhecido';

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
    bulk.post('/desatribuir', {
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
    bulk.post('/transferir', {
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
    bulk.post('/devolver', {
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
             VALUES ($1, $2, 'humano_devolveu', $3, 'ia', $4, $5, 'Devolvido para IA em massa')`,
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

    // POST /bulk/finalizar — Finalizar conversas em massa (admin/master/supervisor)
    bulk.post('/finalizar', {
      preHandler: [
        fastify.authenticate,
        fastify.addTenantFilter,
        fastify.requirePermission('conversas', 'write')
      ]
    }, async (request, reply) => {
      const { conversa_ids } = request.body;
      if (!validateBulkIds(conversa_ids, reply)) return;

      const empresaId = request.empresaId || request.user.empresa_id;
      const { user } = request;

      if (!['master', 'admin', 'supervisor'].includes(user.role)) {
        return reply.status(403).send({ success: false, error: { message: 'Apenas admin, master ou supervisor' } });
      }

      // Lotes grandes → enfileirar no BullMQ
      if (conversa_ids.length > 50) {
        await bulkOperationsQueue.add('finalizar', {
          empresa_id: empresaId,
          operation: 'finalizar',
          data: { conversa_ids },
          user: { id: user.id, nome: user.nome || user.email },
        }, { jobId: `bulk-fin:${empresaId}:${Date.now()}` });

        return reply.send({
          success: true,
          data: { enfileirado: true, total: conversa_ids.length, message: 'Processando em background. Você será notificado quando concluir.' }
        });
      }

      const client = await pool.connect();
      const sucesso = [];
      const erros = [];

      try {
        await client.query('BEGIN');

        const conversasResult = await client.query(
          `SELECT id, fila_id, contato_whatsapp, controlado_por, status FROM conversas
           WHERE id = ANY($1) AND empresa_id = $2 AND status IN ('ativo', 'pendente')`,
          [conversa_ids, empresaId]
        );
        const conversasMap = new Map(conversasResult.rows.map(c => [c.id, c]));

        for (const cid of conversa_ids) {
          const conversa = conversasMap.get(cid);
          if (!conversa) { erros.push({ id: cid, motivo: 'Nao encontrada ou já finalizada' }); continue; }

          await client.query(
            `UPDATE conversas SET status = 'finalizado', atualizado_em = NOW() WHERE id = $1`,
            [cid]
          );

          await client.query(
            `UPDATE atendimentos SET status = 'finalizado', finalizado_em = NOW()
             WHERE conversa_id = $1 AND status = 'ativo'`,
            [cid]
          );

          await client.query(
            `INSERT INTO controle_historico
               (conversa_id, empresa_id, acao, de_controlador, para_controlador, humano_id, humano_nome, motivo)
             VALUES ($1, $2, 'finalizado', $3, NULL, $4, $5, 'Finalizado em massa via painel')`,
            [cid, empresaId, conversa.controlado_por, user.id, user.nome || user.email]
          );

          // Arquivar Redis
          if (conversa.contato_whatsapp) {
            const conversationKey = `whatsapp:${conversa.contato_whatsapp}`;
            archiveConversation(empresaId, conversationKey).catch(() => {});
          }

          sucesso.push(cid);
        }

        await client.query('COMMIT');

        const filasAfetadas = new Set();
        for (const cid of sucesso) {
          const conversa = conversasMap.get(cid);
          emitConversaAtualizada(cid, conversa.fila_id, { id: cid, status: 'finalizado' });
          if (conversa.fila_id) filasAfetadas.add(conversa.fila_id);
        }
        for (const filaId of filasAfetadas) {
          const stats = await calcularStatsFila(filaId);
          emitFilaStats(filaId, stats);
        }

        logger.info(`Bulk finalizar: ${sucesso.length} ok, ${erros.length} erros por ${user.email}`);
        reply.send({ success: true, data: { sucesso: sucesso.length, erros } });
      } catch (error) {
        await client.query('ROLLBACK');
        logger.error('Error bulk finalizar:', error);
        throw error;
      } finally {
        client.release();
      }
    });
  }, { prefix: '/bulk' });

  // GET /expirados — Tickets com janela 24h expirada
  fastify.get('/expirados', {
    preHandler: [
      fastify.authenticate,
      fastify.addTenantFilter,
      fastify.requirePermission('conversas', 'read')
    ],
    schema: {
      querystring: {
        type: 'object',
        properties: {
          fila_id: { type: 'string', format: 'uuid' },
          horas_min: { type: 'integer', minimum: 24, default: 24 },
          horas_max: { type: 'integer' },
          sem_resposta: { type: 'boolean' },
        }
      }
    }
  }, async (request, reply) => {
    const empresaId = request.empresaId;
    const { fila_id, horas_min = 24, horas_max, sem_resposta } = request.query;

    try {
      if (!empresaId) {
        return reply.code(400).send({ success: false, error: 'empresa_id não identificado' });
      }

      const horasMinInt = parseInt(horas_min) || 24;
      const horasMaxInt = horas_max ? parseInt(horas_max) : null;

      let query = `
        SELECT
          c.id, c.numero_ticket, c.contato_whatsapp, c.contato_nome,
          c.controlado_por, c.status, c.fila_id, c.agente_id,
          c.criado_em, c.atualizado_em, c.ultima_msg_entrada_em,
          c.whatsapp_number_id,
          f.nome as fila_nome,
          a.nome as agente_nome,
          wn.nome_exibicao as conexao_nome, wn.phone_number_id as conexao_phone,
          EXTRACT(EPOCH FROM (NOW() - COALESCE(c.ultima_msg_entrada_em, c.criado_em))) / 3600 as horas_expirado,
          (SELECT COUNT(*) FROM mensagens_log ml WHERE ml.conversa_id = c.id AND ml.direcao = 'entrada') as total_msgs_cliente,
          (SELECT COUNT(*) FROM mensagens_log ml WHERE ml.conversa_id = c.id AND ml.direcao = 'saida') as total_msgs_saida
        FROM conversas c
        LEFT JOIN filas_atendimento f ON f.id = c.fila_id
        LEFT JOIN agentes a ON a.id = c.agente_id
        LEFT JOIN whatsapp_numbers wn ON wn.id = c.whatsapp_number_id
        WHERE c.empresa_id = $1
          AND c.status = 'ativo'
          AND COALESCE(c.ultima_msg_entrada_em, c.criado_em) < NOW() - make_interval(hours => $2)
      `;
      const params = [empresaId, horasMinInt];

      if (horasMaxInt) {
        params.push(horasMaxInt);
        query += ` AND COALESCE(c.ultima_msg_entrada_em, c.criado_em) > NOW() - make_interval(hours => $${params.length})`;
      }

      if (fila_id) {
        params.push(fila_id);
        query += ` AND c.fila_id = $${params.length}`;
      }

      query += ` ORDER BY c.ultima_msg_entrada_em ASC`;

      const result = await pool.query(query, params);

      let rows = result.rows;

      // Filtro client-side: sem_resposta (só 1 msg de entrada)
      if (sem_resposta === true || sem_resposta === 'true') {
        rows = rows.filter(r => parseInt(r.total_msgs_cliente) <= 1);
      }

      // Stats por fila
      const statsPorFila = {};
      for (const row of rows) {
        const filaKey = row.fila_id || 'sem_fila';
        if (!statsPorFila[filaKey]) {
          statsPorFila[filaKey] = { fila_id: row.fila_id, fila_nome: row.fila_nome || 'Sem fila', total: 0, sem_resposta: 0 };
        }
        statsPorFila[filaKey].total++;
        if (parseInt(row.total_msgs_cliente) <= 1) {
          statsPorFila[filaKey].sem_resposta++;
        }
      }

      return {
        success: true,
        data: rows,
        stats: {
          total: rows.length,
          por_fila: Object.values(statsPorFila),
          sem_resposta: rows.filter(r => parseInt(r.total_msgs_cliente) <= 1).length,
          com_interacao: rows.filter(r => parseInt(r.total_msgs_cliente) > 1).length,
        }
      };
    } catch (error) {
      logger.error('Error listing expired tickets:', error);
      throw error;
    }
  });

  // POST /expirados/template-lote — Fechar tickets + enviar template em lote
  fastify.post('/expirados/template-lote', {
    preHandler: [
      fastify.authenticate,
      fastify.addTenantFilter,
      fastify.requirePermission('conversas', 'write')
    ],
    schema: {
      body: {
        type: 'object',
        required: ['conversa_ids', 'template_name', 'whatsapp_number_id'],
        properties: {
          conversa_ids: { type: 'array', items: { type: 'string', format: 'uuid' }, minItems: 1, maxItems: 500 },
          template_name: { type: 'string' },
          whatsapp_number_id: { type: 'string', format: 'uuid' },
          language_code: { type: 'string', default: 'pt_BR' },
        }
      }
    }
  }, async (request, reply) => {
    const empresaId = request.empresaId;
    const { user } = request;
    const { conversa_ids, template_name, whatsapp_number_id, language_code = 'pt_BR' } = request.body;

    if (!['master', 'admin', 'supervisor'].includes(user.role)) {
      return reply.status(403).send({ success: false, error: { message: 'Sem permissão' } });
    }

    // Lotes grandes → enfileirar
    if (conversa_ids.length > 50) {
      await bulkOperationsQueue.add('template', {
        empresa_id: empresaId,
        operation: 'template',
        data: { conversa_ids, template_name, whatsapp_number_id, language_code },
        user: { id: user.id, nome: user.nome || user.email },
      }, { jobId: `bulk-tpl:${empresaId}:${Date.now()}` });

      return reply.send({
        success: true,
        data: { enfileirado: true, total: conversa_ids.length, message: 'Processando em background. Você será notificado quando concluir.' }
      });
    }

    try {
      // Buscar conexão WhatsApp selecionada
      const wnResult = await pool.query(
        'SELECT phone_number_id, token_graph_api FROM whatsapp_numbers WHERE id = $1 AND empresa_id = $2 AND ativo = true',
        [whatsapp_number_id, empresaId]
      );
      if (wnResult.rows.length === 0) {
        return reply.code(404).send({ success: false, error: 'Conexão WhatsApp não encontrada' });
      }
      const { phone_number_id, token_graph_api } = wnResult.rows[0];
      const graphToken = decrypt(token_graph_api);

      // Buscar conversas ativas
      const conversasResult = await pool.query(`
        SELECT c.id, c.contato_whatsapp, c.fila_id, c.controlado_por
        FROM conversas c
        WHERE c.id = ANY($1) AND c.empresa_id = $2 AND c.status = 'ativo'
      `, [conversa_ids, empresaId]);

      const fechados = [];
      const enviados = [];
      const erros = [];

      for (const conversa of conversasResult.rows) {
        try {
          // 1. Fechar ticket
          await pool.query(
            `UPDATE conversas SET status = 'finalizado', atualizado_em = NOW() WHERE id = $1`,
            [conversa.id]
          );
          await pool.query(
            `UPDATE atendimentos SET status = 'finalizado', finalizado_em = NOW() WHERE conversa_id = $1 AND status = 'ativo'`,
            [conversa.id]
          );
          await pool.query(
            `INSERT INTO controle_historico (conversa_id, empresa_id, acao, de_controlador, para_controlador, humano_id, humano_nome, motivo)
             VALUES ($1, $2, 'finalizado', $3, NULL, $4, $5, 'Fechado para disparo de template em lote')`,
            [conversa.id, empresaId, conversa.controlado_por, user.id, user.nome || user.email]
          );

          // Arquivar Redis + limpar chatbot
          if (conversa.contato_whatsapp) {
            const conversationKey = `whatsapp:${conversa.contato_whatsapp}`;
            archiveConversation(empresaId, conversationKey).catch(() => {});
            clearFlowState(empresaId, conversa.contato_whatsapp).catch(() => {});
          }

          emitConversaAtualizada(conversa.id, conversa.fila_id, { id: conversa.id, status: 'finalizado' });
          fechados.push(conversa.id);

          // 2. Enviar template
          const result = await sendTemplateMessage(
            phone_number_id, graphToken,
            conversa.contato_whatsapp, template_name, language_code
          );

          if (result.wamid) {
            enviados.push({ id: conversa.id, phone: conversa.contato_whatsapp });
          } else {
            erros.push({ phone: conversa.contato_whatsapp, motivo: result.error || 'Falha no envio do template' });
          }
        } catch (err) {
          erros.push({ phone: conversa.contato_whatsapp, motivo: err.message });
        }
      }

      // Atualizar stats das filas afetadas
      const filasAfetadas = new Set(conversasResult.rows.map(c => c.fila_id).filter(Boolean));
      for (const filaId of filasAfetadas) {
        calcularStatsFila(filaId).then(s => emitFilaStats(filaId, s)).catch(() => {});
      }

      logger.info(`Template lote: ${fechados.length} fechados, ${enviados.length} templates enviados, ${erros.length} erros — por ${user.email}`);
      return {
        success: true,
        data: {
          fechados: fechados.length,
          enviados: enviados.length,
          erros,
          template: template_name,
        }
      };
    } catch (error) {
      logger.error('Error sending bulk template:', error);
      throw error;
    }
  });

  // POST /expirados/transferir-lote — Transferir fila em lote
  fastify.post('/expirados/transferir-lote', {
    preHandler: [
      fastify.authenticate,
      fastify.addTenantFilter,
      fastify.requirePermission('conversas', 'write')
    ],
    schema: {
      body: {
        type: 'object',
        required: ['conversa_ids', 'fila_destino_id'],
        properties: {
          conversa_ids: { type: 'array', items: { type: 'string', format: 'uuid' }, minItems: 1 },
          fila_destino_id: { type: 'string', format: 'uuid' },
        }
      }
    }
  }, async (request, reply) => {
    const empresaId = request.empresaId;
    const { user } = request;
    const { conversa_ids, fila_destino_id } = request.body;

    if (!['master', 'admin', 'supervisor'].includes(user.role)) {
      return reply.status(403).send({ success: false, error: { message: 'Sem permissão' } });
    }

    try {
      const result = await pool.query(
        `UPDATE conversas SET fila_id = $1, controlado_por = 'fila', atualizado_em = NOW()
         WHERE id = ANY($2) AND empresa_id = $3 AND status = 'ativo'
         RETURNING id, fila_id`,
        [fila_destino_id, conversa_ids, empresaId]
      );

      // Emit stats
      const stats = await calcularStatsFila(fila_destino_id);
      emitFilaStats(fila_destino_id, stats);

      logger.info(`Transferência lote: ${result.rowCount} tickets para fila ${fila_destino_id} por ${user.email}`);
      return { success: true, data: { transferidos: result.rowCount } };
    } catch (error) {
      logger.error('Error bulk transfer:', error);
      throw error;
    }
  });

  // GET /janela-aberta — Conversas ativas com janela 24h aberta
  fastify.get('/janela-aberta', {
    preHandler: [
      fastify.authenticate,
      fastify.addTenantFilter,
      fastify.requirePermission('conversas', 'read')
    ],
    schema: {
      querystring: {
        type: 'object',
        properties: {
          fila_id: { type: 'string', format: 'uuid' },
          atribuicao: { type: 'string', enum: ['todos', 'atribuidos', 'nao_atribuidos'] },
          whatsapp_number_id: { type: 'string', format: 'uuid' },
        }
      }
    }
  }, async (request, reply) => {
    const empresaId = request.empresaId || request.user.empresa_id;
    const { fila_id, atribuicao, whatsapp_number_id } = request.query;

    try {
      if (!empresaId) {
        return reply.code(400).send({ success: false, error: 'empresa_id não identificado' });
      }

      let query = `
        SELECT
          c.id, c.numero_ticket, c.contato_whatsapp, c.contato_nome,
          c.fila_id, c.agente_id, c.whatsapp_number_id, c.operador_id, c.operador_nome,
          c.ultima_msg_entrada_em,
          f.nome as fila_nome,
          a.nome as agente_nome,
          wn.nome_exibicao as conexao_nome,
          EXTRACT(EPOCH FROM (NOW() - c.ultima_msg_entrada_em)) / 3600 as horas_desde_ultima,
          (SELECT COUNT(*) FROM mensagens_log ml WHERE ml.conversa_id = c.id AND ml.direcao = 'entrada') as total_msgs_cliente,
          (SELECT COUNT(*) FROM mensagens_log ml WHERE ml.conversa_id = c.id AND ml.direcao = 'saida') as total_msgs_saida
        FROM conversas c
        LEFT JOIN filas_atendimento f ON f.id = c.fila_id
        LEFT JOIN agentes a ON a.id = c.agente_id
        LEFT JOIN whatsapp_numbers wn ON wn.id = c.whatsapp_number_id
        WHERE c.empresa_id = $1
          AND c.status = 'ativo'
          AND c.ultima_msg_entrada_em IS NOT NULL
          AND c.ultima_msg_entrada_em > NOW() - INTERVAL '24 hours'
      `;
      const params = [empresaId];

      if (fila_id) {
        params.push(fila_id);
        query += ` AND c.fila_id = $${params.length}`;
      }

      if (atribuicao === 'atribuidos') {
        query += ` AND c.operador_id IS NOT NULL`;
      } else if (atribuicao === 'nao_atribuidos') {
        query += ` AND c.operador_id IS NULL`;
      }

      if (whatsapp_number_id) {
        params.push(whatsapp_number_id);
        query += ` AND c.whatsapp_number_id = $${params.length}`;
      }

      query += ` ORDER BY c.ultima_msg_entrada_em DESC`;

      const result = await pool.query(query, params);
      const rows = result.rows;

      // Stats por fila
      const statsPorFila = {};
      for (const row of rows) {
        const key = row.fila_id || 'sem_fila';
        if (!statsPorFila[key]) {
          statsPorFila[key] = { fila_id: row.fila_id, fila_nome: row.fila_nome || 'Sem fila', total: 0 };
        }
        statsPorFila[key].total++;
      }

      // Stats por conexão
      const statsPorConexao = {};
      for (const row of rows) {
        const key = row.whatsapp_number_id || 'sem_conexao';
        if (!statsPorConexao[key]) {
          statsPorConexao[key] = { whatsapp_number_id: row.whatsapp_number_id, conexao_nome: row.conexao_nome || 'Sem conexão', total: 0 };
        }
        statsPorConexao[key].total++;
      }

      return {
        success: true,
        data: rows,
        stats: {
          total: rows.length,
          por_fila: Object.values(statsPorFila),
          por_conexao: Object.values(statsPorConexao),
          atribuidos: rows.filter(r => r.operador_id).length,
          nao_atribuidos: rows.filter(r => !r.operador_id).length,
        }
      };
    } catch (error) {
      logger.error('Error listing janela-aberta:', error);
      throw error;
    }
  });

  // POST /mensagem-lote — Enviar mensagem livre em lote (usa conexão de cada conversa)
  fastify.post('/mensagem-lote', {
    preHandler: [
      fastify.authenticate,
      fastify.addTenantFilter,
      fastify.requirePermission('conversas', 'write')
    ],
    schema: {
      body: {
        type: 'object',
        required: ['conversa_ids', 'mensagem'],
        properties: {
          conversa_ids: { type: 'array', items: { type: 'string', format: 'uuid' }, minItems: 1 },
          mensagem: { type: 'string', minLength: 1, maxLength: 5000 },
        }
      }
    }
  }, async (request, reply) => {
    const empresaId = request.empresaId || request.user.empresa_id;
    const { user } = request;
    const { conversa_ids, mensagem } = request.body;

    if (!['master', 'admin', 'supervisor'].includes(user.role)) {
      return reply.status(403).send({ success: false, error: { message: 'Sem permissão' } });
    }

    if (!empresaId) {
      return reply.code(400).send({ success: false, error: 'empresa_id não identificado' });
    }

    // Lotes grandes → enfileirar
    if (conversa_ids.length > 50) {
      await bulkOperationsQueue.add('mensagem', {
        empresa_id: empresaId,
        operation: 'mensagem',
        data: { conversa_ids, mensagem },
        user: { id: user.id, nome: user.nome || user.email },
      }, { jobId: `bulk-msg:${empresaId}:${Date.now()}` });

      return reply.send({
        success: true,
        data: { enfileirado: true, total: conversa_ids.length, message: 'Processando em background. Você será notificado quando concluir.' }
      });
    }

    logger.info(`Mensagem lote: ${conversa_ids.length} conversas, empresa ${empresaId}, user ${user.email}`);

    try {
      // Buscar conversas ativas com janela aberta + dados da conexão WhatsApp
      const conversasResult = await pool.query(`
        SELECT c.id, c.contato_whatsapp, c.fila_id, c.ultima_msg_entrada_em,
               c.whatsapp_number_id, wn.phone_number_id, wn.token_graph_api
        FROM conversas c
        JOIN whatsapp_numbers wn ON wn.id = c.whatsapp_number_id AND wn.ativo = true
        WHERE c.id = ANY($1) AND c.empresa_id = $2 AND c.status = 'ativo'
          AND c.ultima_msg_entrada_em > NOW() - INTERVAL '24 hours'
          AND c.whatsapp_number_id IS NOT NULL
      `, [conversa_ids, empresaId]);

      logger.info(`Mensagem lote: ${conversasResult.rows.length} conversas encontradas de ${conversa_ids.length} enviadas`);

      const enviados = [];
      const erros = [];

      // Cache de tokens descriptografados por conexão
      const tokenCache = {};

      for (const conversa of conversasResult.rows) {
        try {
          // Cache do token para não descriptografar repetidamente
          if (!tokenCache[conversa.whatsapp_number_id]) {
            tokenCache[conversa.whatsapp_number_id] = {
              phone_number_id: conversa.phone_number_id,
              graphToken: decrypt(conversa.token_graph_api),
            };
          }
          const { phone_number_id, graphToken } = tokenCache[conversa.whatsapp_number_id];

          const result = await sendTextMessage(phone_number_id, graphToken, conversa.contato_whatsapp, mensagem);

          if (result.wamid) {
            const logResult = await pool.query(`
              INSERT INTO mensagens_log (conversa_id, empresa_id, direcao, conteudo, remetente_tipo, remetente_nome, tipo_mensagem, whatsapp_message_id, criado_em)
              VALUES ($1, $2, 'saida', $3, 'mensagem_lote', $4, 'text', $5, NOW())
              RETURNING id, criado_em
            `, [conversa.id, empresaId, mensagem, user.nome || user.email, result.wamid]);

            // Emitir WebSocket para aparecer no chat
            if (logResult.rows[0]) {
              emitNovaMensagem(conversa.id, conversa.fila_id, {
                id: logResult.rows[0].id,
                conversa_id: conversa.id,
                conteudo: mensagem,
                direcao: 'saida',
                remetente_tipo: 'mensagem_lote',
                remetente_nome: user.nome || user.email,
                tipo_mensagem: 'text',
                criado_em: logResult.rows[0].criado_em,
              });
            }

            enviados.push({ id: conversa.id, phone: conversa.contato_whatsapp });
          } else {
            erros.push({ phone: conversa.contato_whatsapp, motivo: result.error || 'Falha no envio' });
          }
        } catch (err) {
          erros.push({ phone: conversa.contato_whatsapp, motivo: err.message });
        }
      }

      const ignorados = conversa_ids.length - conversasResult.rows.length;

      logger.info(`Mensagem lote: ${enviados.length} enviados, ${erros.length} erros, ${ignorados} ignorados (janela expirada) — por ${user.email}`);
      return {
        success: true,
        data: {
          enviados: enviados.length,
          erros,
          ignorados,
        }
      };
    } catch (error) {
      logger.error('Error sending bulk message:', error);
      throw error;
    }
  });
}