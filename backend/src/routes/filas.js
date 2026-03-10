import { pool } from '../config/database.js';
import { logger } from '../config/logger.js';
import {
  getFilasDoUsuario,
  isMembroDaFila,
  calcularStatsFilas,
  calcularStatsFila,
} from '../services/fila-manager.js';

export default async function filasRoutes(fastify) {
  // ============================================
  // GET /api/filas — Listar filas
  // Operador ve apenas filas dele
  // ============================================
  fastify.get('/', {
    preHandler: [
      fastify.authenticate,
      fastify.addTenantFilter,
      fastify.requirePermission('filas', 'read'),
    ],
  }, async (request, reply) => {
    const { empresaId, user } = request;
    const isOperador = user.role === 'operador';
    const { todas, incluir_inativas } = request.query || {};

    let filas;
    if (isOperador && !todas) {
      filas = await getFilasDoUsuario(user.id, empresaId);
    } else {
      // Master/admin podem ver filas inativas se pedirem
      const showInativas = incluir_inativas === 'true' && (user.role === 'master' || user.role === 'admin');
      const result = await pool.query(
        `SELECT * FROM filas_atendimento WHERE empresa_id = $1 ${showInativas ? '' : 'AND ativo = true'} ORDER BY ativo DESC, nome`,
        [empresaId]
      );
      filas = result.rows;
    }

    // Calcular stats
    const filaIds = filas.map(f => f.id);
    const stats = filaIds.length > 0
      ? await calcularStatsFilas(empresaId, filaIds)
      : [];

    const statsMap = {};
    for (const s of stats) {
      statsMap[s.fila_id] = s;
    }

    const data = filas.map(f => ({
      ...f,
      stats: statsMap[f.id] || { aguardando: 0, em_atendimento: 0, membros_online: 0, membros_total: 0 },
    }));

    reply.send({ success: true, data });
  });

  // ============================================
  // GET /api/filas/stats — Stats de todas as filas
  // ============================================
  fastify.get('/stats', {
    preHandler: [
      fastify.authenticate,
      fastify.addTenantFilter,
      fastify.requirePermission('filas', 'read'),
    ],
  }, async (request, reply) => {
    const { empresaId, user } = request;
    const isOperador = user.role === 'operador';

    let filaIds = null;
    if (isOperador) {
      const filas = await getFilasDoUsuario(user.id, empresaId);
      filaIds = filas.map(f => f.id);
    }

    const stats = await calcularStatsFilas(empresaId, filaIds);
    reply.send({ success: true, data: stats });
  });

  // ============================================
  // POST /api/filas — Criar fila
  // ============================================
  fastify.post('/', {
    preHandler: [
      fastify.authenticate,
      fastify.addTenantFilter,
      fastify.requirePermission('filas', 'write'),
    ],
  }, async (request, reply) => {
    const { empresaId } = request;
    const {
      nome, descricao, cor, icone,
      auto_assignment, metodo_distribuicao, max_conversas_por_operador,
      horario_funcionamento_ativo, horario_funcionamento, mensagem_fora_horario,
      prioridade_padrao, sla_primeira_resposta_min, sla_resolucao_min,
      membros,
    } = request.body;

    if (!nome || nome.trim().length === 0) {
      return reply.status(400).send({ success: false, error: { message: 'Nome e obrigatorio' } });
    }

    // Verificar duplicado
    const existing = await pool.query(
      `SELECT id FROM filas_atendimento WHERE empresa_id = $1 AND nome = $2 AND ativo = true`,
      [empresaId, nome.trim()]
    );
    if (existing.rows.length > 0) {
      return reply.status(409).send({ success: false, error: { message: 'Ja existe fila com este nome' } });
    }

    const result = await pool.query(
      `INSERT INTO filas_atendimento
        (empresa_id, nome, descricao, cor, icone, auto_assignment, metodo_distribuicao,
         max_conversas_por_operador, horario_funcionamento_ativo, horario_funcionamento,
         mensagem_fora_horario, prioridade_padrao, sla_primeira_resposta_min, sla_resolucao_min)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
       RETURNING *`,
      [
        empresaId, nome.trim(), descricao || null, cor || '#3B82F6', icone || 'headset',
        auto_assignment !== false, metodo_distribuicao || 'round_robin',
        max_conversas_por_operador || 10,
        horario_funcionamento_ativo || false, horario_funcionamento ? JSON.stringify(horario_funcionamento) : '{}',
        mensagem_fora_horario || null, prioridade_padrao || 'none',
        sla_primeira_resposta_min || null, sla_resolucao_min || null,
      ]
    );

    const fila = result.rows[0];

    // Adicionar membros se fornecidos
    if (membros && membros.length > 0) {
      for (const usuarioId of membros) {
        await pool.query(
          `INSERT INTO fila_membros (fila_id, usuario_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
          [fila.id, usuarioId]
        );
      }
    }

    // Auto-criar tool de transferência para esta fila
    try {
      const toolNome = `transferir_para_fila_${fila.nome.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/_+$/, '')}`;
      await pool.query(`
        INSERT INTO tools (empresa_id, nome, descricao_para_llm, tipo_tool, fila_destino_id, parametros_schema_json, ativo)
        VALUES ($1, $2, $3, 'transferencia', $4, $5, true)
      `, [
        empresaId,
        toolNome,
        `Transfere o atendimento para a fila ${fila.nome}. O cliente sera atendido por um operador humano desta fila.`,
        fila.id,
        JSON.stringify({ type: 'object', properties: {}, required: [] })
      ]);
    } catch (toolErr) {
      logger.warn(`Falha ao criar tool de transferencia para fila ${fila.nome}: ${toolErr.message}`);
    }

    logger.info(`Fila criada: ${fila.nome} (${fila.id})`);
    reply.status(201).send({ success: true, data: fila });
  });

  // ============================================
  // GET /api/filas/:id — Detalhes da fila
  // ============================================
  fastify.get('/:id', {
    preHandler: [
      fastify.authenticate,
      fastify.addTenantFilter,
      fastify.requirePermission('filas', 'read'),
    ],
  }, async (request, reply) => {
    const { id } = request.params;
    const { empresaId, user } = request;

    const result = await pool.query(
      `SELECT * FROM filas_atendimento WHERE id = $1 AND empresa_id = $2`,
      [id, empresaId]
    );

    if (result.rows.length === 0) {
      return reply.status(404).send({ success: false, error: { message: 'Fila nao encontrada' } });
    }

    const fila = result.rows[0];

    // Operador so pode ver fila se for membro
    if (user.role === 'operador') {
      const isMembro = await isMembroDaFila(user.id, id);
      if (!isMembro) {
        return reply.status(403).send({ success: false, error: { message: 'Sem acesso a esta fila' } });
      }
    }

    // Stats
    const stats = await calcularStatsFila(id);

    // Membros
    const membrosResult = await pool.query(
      `SELECT u.id, u.nome, u.email, u.role, u.disponibilidade, fm.papel, fm.criado_em
       FROM fila_membros fm
       JOIN usuarios u ON fm.usuario_id = u.id
       WHERE fm.fila_id = $1
       ORDER BY u.nome`,
      [id]
    );

    reply.send({
      success: true,
      data: {
        ...fila,
        stats,
        membros: membrosResult.rows,
      },
    });
  });

  // ============================================
  // PUT /api/filas/:id — Atualizar fila
  // ============================================
  fastify.put('/:id', {
    preHandler: [
      fastify.authenticate,
      fastify.addTenantFilter,
      fastify.requirePermission('filas', 'write'),
    ],
  }, async (request, reply) => {
    const { id } = request.params;
    const { empresaId } = request;
    const body = request.body;

    // Verificar existencia
    const existing = await pool.query(
      `SELECT id FROM filas_atendimento WHERE id = $1 AND empresa_id = $2`,
      [id, empresaId]
    );
    if (existing.rows.length === 0) {
      return reply.status(404).send({ success: false, error: { message: 'Fila nao encontrada' } });
    }

    const fields = [];
    const values = [];
    let paramCount = 0;

    const allowedFields = [
      'nome', 'descricao', 'cor', 'icone',
      'auto_assignment', 'metodo_distribuicao', 'max_conversas_por_operador',
      'horario_funcionamento_ativo', 'horario_funcionamento', 'mensagem_fora_horario',
      'prioridade_padrao', 'sla_primeira_resposta_min', 'sla_resolucao_min', 'ativo',
    ];

    for (const field of allowedFields) {
      if (body[field] !== undefined) {
        paramCount++;
        fields.push(`${field} = $${paramCount}`);
        values.push(field === 'horario_funcionamento' ? JSON.stringify(body[field]) : body[field]);
      }
    }

    if (fields.length === 0) {
      return reply.status(400).send({ success: false, error: { message: 'Nenhum campo para atualizar' } });
    }

    paramCount++;
    fields.push(`atualizado_em = NOW()`);
    values.push(id);

    const result = await pool.query(
      `UPDATE filas_atendimento SET ${fields.join(', ')} WHERE id = $${paramCount} RETURNING *`,
      values
    );

    reply.send({ success: true, data: result.rows[0] });
  });

  // ============================================
  // DELETE /api/filas/:id — Excluir fila permanentemente
  // ============================================
  fastify.delete('/:id', {
    preHandler: [
      fastify.authenticate,
      fastify.addTenantFilter,
      fastify.requirePermission('filas', 'delete'),
    ],
  }, async (request, reply) => {
    const { id } = request.params;
    const { empresaId } = request;

    try {
      // Verificar se a fila existe
      const filaResult = await pool.query(
        `SELECT id, nome, is_default FROM filas_atendimento WHERE id = $1 AND empresa_id = $2`,
        [id, empresaId]
      );
      if (filaResult.rows.length === 0) {
        return reply.status(404).send({ success: false, error: { message: 'Fila nao encontrada' } });
      }

      const fila = filaResult.rows[0];

      // Nao permitir excluir fila default
      if (fila.is_default) {
        return reply.status(400).send({
          success: false,
          error: { message: 'Nao e possivel excluir a fila padrao. Defina outra fila como padrao primeiro.' },
        });
      }

      // Verificar se tem agentes ativos vinculados
      const agentesVinculados = await pool.query(
        `SELECT id, nome FROM agentes WHERE fila_id = $1 AND ativo = true`,
        [id]
      );
      if (agentesVinculados.rows.length > 0) {
        const nomes = agentesVinculados.rows.map(a => a.nome).join(', ');
        return reply.status(400).send({
          success: false,
          error: { message: `Fila vinculada a agentes ativos: ${nomes}. Desvincule ou exclua os agentes primeiro.` },
        });
      }

      // Verificar se tem conversas ativas
      const activeConversas = await pool.query(
        `SELECT COUNT(*) as total FROM conversas WHERE fila_id = $1 AND status = 'ativo'`,
        [id]
      );
      if (parseInt(activeConversas.rows[0].total) > 0) {
        return reply.status(400).send({
          success: false,
          error: { message: `Fila tem ${activeConversas.rows[0].total} conversas ativas. Transfira ou finalize antes de excluir.` },
        });
      }

      // Desvincular conversas finalizadas/timeout
      await pool.query(
        `UPDATE conversas SET fila_id = NULL WHERE fila_id = $1 AND empresa_id = $2`,
        [id, empresaId]
      );

      // Remover tools de transferência que apontam para esta fila
      // Primeiro remove agente_tools, depois a tool em si
      await pool.query(
        `DELETE FROM agente_tools WHERE tool_id IN (SELECT id FROM tools WHERE fila_destino_id = $1)`,
        [id]
      );
      await pool.query(
        `DELETE FROM tools WHERE fila_destino_id = $1`,
        [id]
      );

      // fila_membros: CASCADE automatico
      // agentes.fila_id: SET NULL automatico
      // Excluir permanentemente
      await pool.query(
        `DELETE FROM filas_atendimento WHERE id = $1 AND empresa_id = $2`,
        [id, empresaId]
      );

      logger.info(`Fila excluida permanentemente: ${fila.nome} (${id})`);
      reply.status(204).send();
    } catch (error) {
      logger.error(`Erro ao excluir fila ${id}:`, error);
      return reply.status(500).send({
        success: false,
        error: { message: 'Erro ao excluir fila' },
      });
    }
  });

  // ============================================
  // GET /api/filas/:id/membros — Listar membros
  // ============================================
  fastify.get('/:id/membros', {
    preHandler: [
      fastify.authenticate,
      fastify.addTenantFilter,
      fastify.requirePermission('filas', 'read'),
    ],
  }, async (request, reply) => {
    const { id } = request.params;
    const { user } = request;

    // Operador so pode ver se for membro
    if (user.role === 'operador') {
      const isMembro = await isMembroDaFila(user.id, id);
      if (!isMembro) {
        return reply.status(403).send({ success: false, error: { message: 'Sem acesso a esta fila' } });
      }
    }

    const result = await pool.query(
      `SELECT u.id, u.nome, u.email, u.role, u.disponibilidade, u.max_conversas_simultaneas,
              fm.papel, fm.criado_em,
              COUNT(c.id) FILTER (WHERE c.status = 'ativo' AND c.controlado_por = 'humano') as conversas_ativas
       FROM fila_membros fm
       JOIN usuarios u ON fm.usuario_id = u.id
       LEFT JOIN conversas c ON c.operador_id = u.id
       WHERE fm.fila_id = $1
       GROUP BY u.id, u.nome, u.email, u.role, u.disponibilidade, u.max_conversas_simultaneas, fm.papel, fm.criado_em
       ORDER BY u.nome`,
      [id]
    );

    reply.send({ success: true, data: result.rows });
  });

  // ============================================
  // POST /api/filas/:id/membros — Adicionar membros
  // ============================================
  fastify.post('/:id/membros', {
    preHandler: [
      fastify.authenticate,
      fastify.addTenantFilter,
      fastify.requirePermission('filas', 'write'),
    ],
  }, async (request, reply) => {
    const { id } = request.params;
    const { empresaId } = request;
    const { usuario_ids, papel } = request.body;

    if (!usuario_ids || !Array.isArray(usuario_ids) || usuario_ids.length === 0) {
      return reply.status(400).send({ success: false, error: { message: 'usuario_ids e obrigatorio (array)' } });
    }

    // Verificar fila existe
    const filaResult = await pool.query(
      `SELECT id FROM filas_atendimento WHERE id = $1 AND empresa_id = $2 AND ativo = true`,
      [id, empresaId]
    );
    if (filaResult.rows.length === 0) {
      return reply.status(404).send({ success: false, error: { message: 'Fila nao encontrada' } });
    }

    let added = 0;
    for (const usuarioId of usuario_ids) {
      try {
        await pool.query(
          `INSERT INTO fila_membros (fila_id, usuario_id, papel) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
          [id, usuarioId, papel || 'membro']
        );
        added++;
      } catch (error) {
        logger.warn(`Erro ao adicionar membro ${usuarioId} na fila ${id}:`, error.message);
      }
    }

    reply.status(201).send({ success: true, data: { adicionados: added } });
  });

  // ============================================
  // DELETE /api/filas/:id/membros/:userId — Remover membro
  // ============================================
  fastify.delete('/:id/membros/:userId', {
    preHandler: [
      fastify.authenticate,
      fastify.addTenantFilter,
      fastify.requirePermission('filas', 'write'),
    ],
  }, async (request, reply) => {
    const { id, userId } = request.params;

    await pool.query(
      `DELETE FROM fila_membros WHERE fila_id = $1 AND usuario_id = $2`,
      [id, userId]
    );

    reply.status(204).send();
  });

  // ============================================
  // POST /api/filas/:id/membros/remover-bulk — Remover membros em massa
  // ============================================
  fastify.post('/:id/membros/remover-bulk', {
    preHandler: [
      fastify.authenticate,
      fastify.addTenantFilter,
      fastify.requirePermission('filas', 'write'),
    ],
  }, async (request, reply) => {
    const { id } = request.params;
    const { usuario_ids } = request.body;

    if (!Array.isArray(usuario_ids) || usuario_ids.length === 0) {
      return reply.code(400).send({ success: false, error: { message: 'usuario_ids deve ser um array nao vazio' } });
    }

    const result = await pool.query(
      `DELETE FROM fila_membros WHERE fila_id = $1 AND usuario_id = ANY($2)`,
      [id, usuario_ids]
    );

    reply.send({ success: true, data: { removidos: result.rowCount } });
  });

  // ============================================
  // GET /api/filas/:id/conversas — Conversas da fila
  // ============================================
  fastify.get('/:id/conversas', {
    preHandler: [
      fastify.authenticate,
      fastify.addTenantFilter,
      fastify.requirePermission('filas', 'read'),
    ],
  }, async (request, reply) => {
    const { id } = request.params;
    const { empresaId, user } = request;
    const { status, tipo, page = 1, per_page = 50 } = request.query;

    // Operador so pode ver se for membro
    if (user.role === 'operador') {
      const isMembro = await isMembroDaFila(user.id, id);
      if (!isMembro) {
        return reply.status(403).send({ success: false, error: { message: 'Sem acesso a esta fila' } });
      }
    }

    let where = `c.fila_id = $1 AND c.empresa_id = $2`;
    const params = [id, empresaId];
    let paramCount = 2;

    // Filtros
    if (status) {
      paramCount++;
      where += ` AND c.status = $${paramCount}`;
      params.push(status);
    } else {
      where += ` AND c.status IN ('ativo', 'pendente')`;
    }

    if (tipo === 'nao_atribuidas') {
      where += ` AND c.operador_id IS NULL AND c.controlado_por IN ('fila', 'ia')`;
    } else if (tipo === 'minhas') {
      paramCount++;
      where += ` AND c.operador_id = $${paramCount}`;
      params.push(user.id);
    }

    const offset = (parseInt(page) - 1) * parseInt(per_page);

    // Count
    const countResult = await pool.query(
      `SELECT COUNT(*) as total FROM conversas c WHERE ${where}`,
      params
    );

    // Dados (LATERAL join para performance)
    const result = await pool.query(
      `SELECT c.*,
              a.nome as agente_nome,
              wn.nome_exibicao as conexao_nome,
              wn.numero_formatado as conexao_numero,
              lm.total_mensagens,
              lm.ultima_mensagem,
              lm.ultima_mensagem_em
       FROM conversas c
       LEFT JOIN agentes a ON c.agente_id = a.id
       LEFT JOIN whatsapp_numbers wn ON wn.id = c.whatsapp_number_id
       LEFT JOIN LATERAL (
         SELECT
           COUNT(*) as total_mensagens,
           (SELECT conteudo FROM mensagens_log m2 WHERE m2.conversa_id = c.id ORDER BY m2.criado_em DESC LIMIT 1) as ultima_mensagem,
           MAX(criado_em) as ultima_mensagem_em
         FROM mensagens_log m WHERE m.conversa_id = c.id
       ) lm ON true
       WHERE ${where}
       ORDER BY
         CASE c.prioridade
           WHEN 'urgent' THEN 1
           WHEN 'high' THEN 2
           WHEN 'medium' THEN 3
           WHEN 'low' THEN 4
           ELSE 5
         END,
         c.atualizado_em DESC
       LIMIT $${paramCount + 1} OFFSET $${paramCount + 2}`,
      [...params, parseInt(per_page), offset]
    );

    reply.send({
      success: true,
      data: result.rows,
      meta: {
        total: parseInt(countResult.rows[0].total),
        page: parseInt(page),
        per_page: parseInt(per_page),
        total_pages: Math.ceil(parseInt(countResult.rows[0].total) / parseInt(per_page)),
      },
    });
  });
}
