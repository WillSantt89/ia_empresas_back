import { logger } from '../config/logger.js';
import { pool } from '../config/database.js';
import { checkPermission } from '../middleware/permission.js';

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
    const { whatsapp, nome, email, observacoes, dados_json } = request.body;

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
