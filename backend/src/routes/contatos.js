import { logger } from '../config/logger.js';
import { pool } from '../config/database.js';
import { decrypt } from '../config/encryption.js';
import { checkPermission } from '../middleware/permission.js';
import { emitNovaConversaNaFila, emitNovaMensagem } from '../services/websocket.js';
import { sendTemplateMessage } from '../services/whatsapp-sender.js';

const createLogger = logger.child({ module: 'contatos-routes' });

const contatosRoutes = async (fastify) => {
  /**
   * GET /api/contatos
   * Listar contatos (paginado, com busca)
   */
  fastify.get('/', {
    preHandler: [fastify.authenticate],
    schema: {
      querystring: {
        type: 'object',
        properties: {
          page: { type: 'integer', minimum: 1, default: 1 },
          limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
          search: { type: 'string' },
          ativo: { type: 'boolean' }
        }
      }
    }
  }, async (request, reply) => {
    const { empresa_id } = request.user;
    const { page, limit, search, ativo } = request.query;
    const offset = (page - 1) * limit;

    try {
      let query = `
        SELECT
          ct.id,
          ct.whatsapp,
          ct.nome,
          ct.email,
          ct.observacoes,
          ct.dados_json,
          ct.ativo,
          ct.criado_em,
          ct.atualizado_em,
          COUNT(c.id) FILTER (WHERE c.status = 'ativo') as conversas_ativas,
          COUNT(c.id) as conversas_total,
          MAX(c.atualizado_em) as ultima_conversa_em
        FROM contatos ct
        LEFT JOIN conversas c ON c.contato_id = ct.id
        WHERE ct.empresa_id = $1
      `;

      const params = [empresa_id];
      let paramIndex = 2;

      if (search) {
        query += ` AND (ct.nome ILIKE $${paramIndex} OR ct.whatsapp ILIKE $${paramIndex} OR ct.email ILIKE $${paramIndex})`;
        params.push(`%${search}%`);
        paramIndex++;
      }

      if (ativo !== undefined) {
        query += ` AND ct.ativo = $${paramIndex}`;
        params.push(ativo);
        paramIndex++;
      }

      // Count total
      const countQuery = `
        SELECT COUNT(DISTINCT ct.id) as total
        FROM contatos ct
        WHERE ct.empresa_id = $1
        ${search ? ` AND (ct.nome ILIKE $2 OR ct.whatsapp ILIKE $2 OR ct.email ILIKE $2)` : ''}
        ${ativo !== undefined ? ` AND ct.ativo = $${search ? 3 : 2}` : ''}
      `;
      const countParams = [empresa_id];
      if (search) countParams.push(`%${search}%`);
      if (ativo !== undefined) countParams.push(ativo);

      const countResult = await pool.query(countQuery, countParams);
      const total = parseInt(countResult.rows[0].total) || 0;

      // Add group by and pagination
      query += ` GROUP BY ct.id ORDER BY ct.criado_em DESC LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
      params.push(limit, offset);

      const result = await pool.query(query, params);

      return {
        success: true,
        data: {
          contatos: result.rows,
          pagination: {
            page,
            limit,
            total,
            pages: Math.ceil(total / limit)
          }
        }
      };
    } catch (error) {
      createLogger.error('Failed to list contatos', { empresa_id, error: error.message });
      throw error;
    }
  });

  /**
   * GET /api/contatos/:id
   * Detalhes do contato + conversas
   */
  fastify.get('/:id', {
    preHandler: [fastify.authenticate],
    schema: {
      params: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' }
        }
      }
    }
  }, async (request, reply) => {
    const { empresa_id } = request.user;
    const { id } = request.params;

    try {
      const contatoResult = await pool.query(`
        SELECT
          ct.*,
          COUNT(c.id) FILTER (WHERE c.status = 'ativo') as conversas_ativas,
          COUNT(c.id) as conversas_total
        FROM contatos ct
        LEFT JOIN conversas c ON c.contato_id = ct.id
        WHERE ct.id = $1 AND ct.empresa_id = $2
        GROUP BY ct.id
      `, [id, empresa_id]);

      if (contatoResult.rows.length === 0) {
        return reply.code(404).send({
          success: false,
          error: {
            code: 'CONTATO_NOT_FOUND',
            message: 'Contato não encontrado'
          }
        });
      }

      // Buscar conversas do contato
      const conversasResult = await pool.query(`
        SELECT
          c.id,
          c.status,
          c.controlado_por,
          c.contato_whatsapp,
          c.criado_em,
          c.atualizado_em,
          a.nome as agente_nome,
          (SELECT COUNT(*) FROM mensagens_log WHERE conversa_id = c.id) as total_mensagens
        FROM conversas c
        LEFT JOIN agentes a ON a.id = c.agente_id
        WHERE c.contato_id = $1 AND c.empresa_id = $2
        ORDER BY c.criado_em DESC
        LIMIT 20
      `, [id, empresa_id]);

      return {
        success: true,
        data: {
          contato: contatoResult.rows[0],
          conversas: conversasResult.rows
        }
      };
    } catch (error) {
      createLogger.error('Failed to get contato', { empresa_id, contato_id: id, error: error.message });
      throw error;
    }
  });

  /**
   * GET /api/contatos/:id/conversas
   * Histórico de conversas do contato (paginado)
   */
  fastify.get('/:id/conversas', {
    preHandler: [fastify.authenticate],
    schema: {
      params: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' }
        }
      },
      querystring: {
        type: 'object',
        properties: {
          page: { type: 'integer', minimum: 1, default: 1 },
          per_page: { type: 'integer', minimum: 1, maximum: 50, default: 10 },
          exclude: { type: 'string', format: 'uuid' }
        }
      }
    }
  }, async (request, reply) => {
    const { empresa_id } = request.user;
    const { id } = request.params;
    const { page, per_page, exclude } = request.query;
    const offset = (page - 1) * per_page;

    try {
      // Verificar se contato pertence à empresa
      const contatoCheck = await pool.query(
        'SELECT id FROM contatos WHERE id = $1 AND empresa_id = $2',
        [id, empresa_id]
      );
      if (contatoCheck.rows.length === 0) {
        return reply.code(404).send({
          success: false,
          error: { code: 'CONTATO_NOT_FOUND', message: 'Contato não encontrado' }
        });
      }

      let query = `
        SELECT
          c.id, c.numero_ticket, c.status, c.controlado_por,
          c.criado_em, c.atualizado_em,
          a.nome as agente_nome,
          (SELECT COUNT(*) FROM mensagens_log WHERE conversa_id = c.id) as total_mensagens
        FROM conversas c
        LEFT JOIN agentes a ON a.id = c.agente_id
        WHERE c.contato_id = $1 AND c.empresa_id = $2
      `;
      const params = [id, empresa_id];
      let paramIndex = 3;

      if (exclude) {
        query += ` AND c.id != $${paramIndex}`;
        params.push(exclude);
        paramIndex++;
      }

      // Count total
      const countResult = await pool.query(
        `SELECT COUNT(*) as total FROM conversas WHERE contato_id = $1 AND empresa_id = $2${exclude ? ` AND id != $3` : ''}`,
        exclude ? [id, empresa_id, exclude] : [id, empresa_id]
      );
      const total = parseInt(countResult.rows[0].total) || 0;

      query += ` ORDER BY c.criado_em DESC LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
      params.push(per_page, offset);

      const result = await pool.query(query, params);

      return {
        success: true,
        data: {
          conversas: result.rows,
          pagination: { page, per_page, total, pages: Math.ceil(total / per_page) }
        }
      };
    } catch (error) {
      createLogger.error('Failed to list contato conversas', { empresa_id, contato_id: id, error: error.message });
      throw error;
    }
  });

  /**
   * POST /api/contatos
   * Criar contato
   */
  fastify.post('/', {
    preHandler: [fastify.authenticate],
    schema: {
      body: {
        type: 'object',
        properties: {
          whatsapp: { type: 'string', minLength: 1, maxLength: 20 },
          nome: { type: 'string', maxLength: 255 },
          email: { type: 'string', maxLength: 255 },
          observacoes: { type: 'string' },
          dados_json: { type: 'object' }
        },
        required: ['whatsapp']
      }
    }
  }, async (request, reply) => {
    const { empresa_id } = request.user;
    let { whatsapp, nome, email, observacoes, dados_json } = request.body;

    // Normalizar: remover caracteres não numéricos
    whatsapp = whatsapp.replace(/\D/g, '');

    // Forçar prefixo 55
    if (!whatsapp.startsWith('55')) {
      return reply.code(400).send({
        success: false,
        error: { code: 'INVALID_PHONE', message: 'O número deve começar com 55 (DDI Brasil)' }
      });
    }

    if (whatsapp.length < 12 || whatsapp.length > 13) {
      return reply.code(400).send({
        success: false,
        error: { code: 'INVALID_PHONE', message: 'Número inválido. Formato esperado: 55 + DDD + número (12-13 dígitos)' }
      });
    }

    try {
      // Verificar duplicidade
      const existing = await pool.query(
        'SELECT id FROM contatos WHERE empresa_id = $1 AND whatsapp = $2',
        [empresa_id, whatsapp]
      );

      if (existing.rows.length > 0) {
        return reply.code(409).send({
          success: false,
          error: {
            code: 'CONTATO_EXISTS',
            message: 'Já existe um contato com este WhatsApp'
          }
        });
      }

      const result = await pool.query(`
        INSERT INTO contatos (empresa_id, whatsapp, nome, email, observacoes, dados_json)
        VALUES ($1, $2, $3, $4, $5, $6)
        RETURNING *
      `, [empresa_id, whatsapp, nome || null, email || null, observacoes || null, JSON.stringify(dados_json || {})]);

      createLogger.info('Contato created', { empresa_id, contato_id: result.rows[0].id });

      return {
        success: true,
        data: {
          contato: result.rows[0]
        }
      };
    } catch (error) {
      createLogger.error('Failed to create contato', { empresa_id, error: error.message });
      throw error;
    }
  });

  /**
   * POST /api/contatos/:id/iniciar-conversa
   * Iniciar conversa a partir de um contato (retorna existente ativa ou cria nova)
   */
  fastify.post('/:id/iniciar-conversa', {
    preHandler: [fastify.authenticate],
    schema: {
      params: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' }
        }
      },
      body: {
        type: 'object',
        properties: {
          whatsapp_number_id: { type: 'string', format: 'uuid', nullable: true },
          template_name: { type: 'string' },
          language_code: { type: 'string' }
        }
      }
    }
  }, async (request, reply) => {
    const { empresa_id, id: userId, nome: userName, role } = request.user;
    const { id } = request.params;
    const { whatsapp_number_id, template_name, language_code = 'pt_BR' } = request.body || {};

    try {
      // 1. Buscar contato
      const contatoResult = await pool.query(
        'SELECT * FROM contatos WHERE id = $1 AND empresa_id = $2 AND ativo = true',
        [id, empresa_id]
      );
      if (contatoResult.rows.length === 0) {
        return reply.code(404).send({
          success: false,
          error: { code: 'CONTATO_NOT_FOUND', message: 'Contato não encontrado' }
        });
      }
      const contato = contatoResult.rows[0];

      // 2. Verificar se já existe conversa ativa para este contato
      const conversaExistente = await pool.query(
        `SELECT id FROM conversas WHERE contato_id = $1 AND empresa_id = $2 AND status = 'ativo'
         ORDER BY criado_em DESC LIMIT 1`,
        [id, empresa_id]
      );
      if (conversaExistente.rows.length > 0) {
        return {
          success: true,
          data: {
            conversa_id: conversaExistente.rows[0].id,
            existente: true,
            message: 'Conversa ativa já existe para este contato'
          }
        };
      }

      // 2b. Validar whatsapp_number_id se fornecido
      let validatedWnId = null;
      if (whatsapp_number_id) {
        const wnCheck = await pool.query(
          `SELECT id FROM whatsapp_numbers WHERE id = $1 AND empresa_id = $2 AND ativo = true`,
          [whatsapp_number_id, empresa_id]
        );
        if (wnCheck.rows.length === 0) {
          return reply.code(400).send({
            success: false,
            error: { message: 'Número WhatsApp não encontrado ou inativo' }
          });
        }
        validatedWnId = whatsapp_number_id;
      }

      // 3. Buscar fila default
      const filaResult = await pool.query(
        `SELECT id FROM filas_atendimento WHERE empresa_id = $1 AND ativo = true ORDER BY criado_em ASC LIMIT 1`,
        [empresa_id]
      );
      const defaultFilaId = filaResult.rows[0]?.id || null;

      // 4. Gerar ticket
      const { rows: [{ get_next_ticket_number: numero_ticket }] } = await pool.query(
        `SELECT get_next_ticket_number($1)`, [empresa_id]
      );

      // 5. Criar conversa — controlado_por 'humano' atribuída ao operador que iniciou
      const insertResult = await pool.query(`
        INSERT INTO conversas (
          empresa_id, contato_whatsapp, contato_nome, contato_id,
          status, controlado_por, operador_id, operador_nome,
          fila_id, fila_entrada_em, numero_ticket,
          dados_json, whatsapp_number_id
        )
        VALUES ($1, $2, $3, $4, 'ativo', 'humano', $5, $6, $7, NOW(), $8, $9, $10)
        RETURNING id
      `, [
        empresa_id,
        contato.whatsapp,
        contato.nome || null,
        id,
        userId,
        userName,
        defaultFilaId,
        numero_ticket,
        JSON.stringify({ source: 'manual', initiated_by: userName }),
        validatedWnId
      ]);

      const conversaId = insertResult.rows[0].id;

      // 6. Registrar no controle_historico
      await pool.query(`
        INSERT INTO controle_historico (conversa_id, empresa_id, acao, de_controlador, para_controlador, usuario_id, usuario_nome)
        VALUES ($1, $2, 'criada_manual', NULL, 'humano', $3, $4)
      `, [conversaId, empresa_id, userId, userName]);

      // 7. Se template_name fornecido, enviar template via WhatsApp
      let templateEnviado = false;
      if (template_name && validatedWnId) {
        const wnResult = await pool.query(
          `SELECT phone_number_id, token_graph_api FROM whatsapp_numbers WHERE id = $1`,
          [validatedWnId]
        );
        if (wnResult.rows.length > 0) {
          const wn = wnResult.rows[0];
          const token = decrypt(wn.token_graph_api);
          if (token) {
            try {
              const templateLabel = `[Template: ${template_name}]`;
              const msgResult = await pool.query(
                `INSERT INTO mensagens_log
                   (conversa_id, empresa_id, direcao, conteudo, remetente_tipo, remetente_id, remetente_nome, status_entrega)
                 VALUES ($1, $2, 'saida', $3, 'operador', $4, $5, 'sending')
                 RETURNING *`,
                [conversaId, empresa_id, templateLabel, userId, userName]
              );
              const mensagem = msgResult.rows[0];

              const result = await sendTemplateMessage(
                wn.phone_number_id, token, contato.whatsapp, template_name, language_code, []
              );

              if (result.success) {
                await pool.query(
                  `UPDATE mensagens_log SET status_entrega = 'sent', whatsapp_message_id = $1 WHERE id = $2`,
                  [result.wamid, mensagem.id]
                );
                mensagem.status_entrega = 'sent';
                templateEnviado = true;
              } else {
                await pool.query(
                  `UPDATE mensagens_log SET status_entrega = 'failed', erro = $1 WHERE id = $2`,
                  [result.error, mensagem.id]
                );
              }

              emitNovaMensagem(conversaId, defaultFilaId, {
                id: mensagem.id,
                conversa_id: conversaId,
                conteudo: templateLabel,
                direcao: 'saida',
                remetente_tipo: 'operador',
                remetente_id: userId,
                remetente_nome: userName,
                status_entrega: mensagem.status_entrega,
                criado_em: mensagem.criado_em,
              });
            } catch (err) {
              createLogger.error('Erro enviando template ao iniciar conversa', { error: err.message });
            }
          }
        }
      }

      // 8. Emitir WebSocket
      if (defaultFilaId) {
        emitNovaConversaNaFila(defaultFilaId, {
          id: conversaId,
          contato_whatsapp: contato.whatsapp,
          contato_nome: contato.nome,
          status: 'ativo',
          controlado_por: 'humano',
          operador_id: userId,
          operador_nome: userName,
          fila_id: defaultFilaId,
          numero_ticket,
        });
      }

      createLogger.info('Conversa initiated from contato', {
        empresa_id,
        contato_id: id,
        conversa_id: conversaId,
        by: userName,
        template: template_name || null,
      });

      return {
        success: true,
        data: {
          conversa_id: conversaId,
          existente: false,
          template_enviado: templateEnviado,
          message: 'Conversa criada com sucesso'
        }
      };
    } catch (error) {
      createLogger.error('Failed to initiate conversa from contato', {
        empresa_id,
        contato_id: id,
        error: error.message,
        stack: error.stack,
      });
      return reply.code(500).send({
        success: false,
        error: { message: error.message || 'Erro interno ao criar conversa' }
      });
    }
  });

  /**
   * PUT /api/contatos/:id
   * Atualizar contato
   */
  fastify.put('/:id', {
    preHandler: [fastify.authenticate],
    schema: {
      params: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' }
        }
      },
      body: {
        type: 'object',
        properties: {
          nome: { type: 'string', maxLength: 255 },
          email: { type: 'string', maxLength: 255 },
          observacoes: { type: 'string' },
          dados_json: { type: 'object' }
        }
      }
    }
  }, async (request, reply) => {
    const { empresa_id } = request.user;
    const { id } = request.params;
    const { nome, email, observacoes, dados_json } = request.body;

    try {
      const fields = [];
      const values = [];
      let index = 1;

      if (nome !== undefined) {
        fields.push(`nome = $${index}`);
        values.push(nome);
        index++;
      }
      if (email !== undefined) {
        fields.push(`email = $${index}`);
        values.push(email);
        index++;
      }
      if (observacoes !== undefined) {
        fields.push(`observacoes = $${index}`);
        values.push(observacoes);
        index++;
      }
      if (dados_json !== undefined) {
        fields.push(`dados_json = $${index}`);
        values.push(JSON.stringify(dados_json));
        index++;
      }

      if (fields.length === 0) {
        return { success: true, data: { message: 'Nenhum campo para atualizar' } };
      }

      values.push(id, empresa_id);
      const result = await pool.query(`
        UPDATE contatos
        SET ${fields.join(', ')}, atualizado_em = NOW()
        WHERE id = $${index} AND empresa_id = $${index + 1}
        RETURNING *
      `, values);

      if (result.rows.length === 0) {
        return reply.code(404).send({
          success: false,
          error: {
            code: 'CONTATO_NOT_FOUND',
            message: 'Contato não encontrado'
          }
        });
      }

      createLogger.info('Contato updated', { empresa_id, contato_id: id });

      return {
        success: true,
        data: {
          contato: result.rows[0]
        }
      };
    } catch (error) {
      createLogger.error('Failed to update contato', { empresa_id, contato_id: id, error: error.message });
      throw error;
    }
  });

  /**
   * DELETE /api/contatos/:id
   * Soft-delete (ativo=false) — só master/admin
   */
  fastify.delete('/:id', {
    preHandler: [fastify.authenticate, checkPermission(['master', 'admin'])],
    schema: {
      params: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' }
        }
      }
    }
  }, async (request, reply) => {
    const { empresa_id } = request.user;
    const { id } = request.params;

    try {
      const result = await pool.query(`
        UPDATE contatos
        SET ativo = false, atualizado_em = NOW()
        WHERE id = $1 AND empresa_id = $2
        RETURNING id, whatsapp, nome
      `, [id, empresa_id]);

      if (result.rows.length === 0) {
        return reply.code(404).send({
          success: false,
          error: {
            code: 'CONTATO_NOT_FOUND',
            message: 'Contato não encontrado'
          }
        });
      }

      createLogger.info('Contato deactivated', { empresa_id, contato_id: id });

      return {
        success: true,
        data: {
          message: 'Contato desativado com sucesso',
          contato: result.rows[0]
        }
      };
    } catch (error) {
      createLogger.error('Failed to delete contato', { empresa_id, contato_id: id, error: error.message });
      throw error;
    }
  });
};

export default contatosRoutes;
