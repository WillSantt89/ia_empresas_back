import { pool } from '../config/database.js';
import { logger } from '../config/logger.js';

const TIPOS_VALIDOS = ['text', 'number', 'date', 'list', 'checkbox', 'link', 'phone', 'email', 'cpf'];
const CONTEXTOS_VALIDOS = ['contato', 'atendimento'];

// Gerar chave slug a partir do display_name
function gerarChave(nome) {
  return nome
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '')
    .substring(0, 80);
}

// Validar valor conforme tipo do campo
export function validarValorCampo(campo, valor) {
  if (valor === null || valor === undefined || valor === '') return { valido: true, valor: '' };

  const v = String(valor).trim();

  switch (campo.tipo) {
    case 'number': {
      const num = Number(v);
      if (isNaN(num)) return { valido: false, erro: `"${campo.display_name}" deve ser um numero` };
      return { valido: true, valor: v };
    }
    case 'date': {
      const d = new Date(v);
      if (isNaN(d.getTime())) return { valido: false, erro: `"${campo.display_name}" deve ser uma data valida` };
      return { valido: true, valor: v };
    }
    case 'checkbox': {
      const boolVal = v === 'true' || v === '1' || v === 'sim' || v === 'yes';
      const falseVal = v === 'false' || v === '0' || v === 'nao' || v === 'no' || v === '';
      if (!boolVal && !falseVal) return { valido: false, erro: `"${campo.display_name}" deve ser sim/nao` };
      return { valido: true, valor: boolVal ? 'true' : 'false' };
    }
    case 'list': {
      const opcoes = campo.opcoes || [];
      if (opcoes.length > 0 && !opcoes.includes(v)) {
        return { valido: false, erro: `"${campo.display_name}" deve ser um dos valores: ${opcoes.join(', ')}` };
      }
      return { valido: true, valor: v };
    }
    case 'link': {
      if (v && !/^https?:\/\/.+/i.test(v)) return { valido: false, erro: `"${campo.display_name}" deve ser uma URL valida` };
      return { valido: true, valor: v };
    }
    case 'email': {
      if (v && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) return { valido: false, erro: `"${campo.display_name}" deve ser um email valido` };
      return { valido: true, valor: v };
    }
    case 'phone': {
      const digits = v.replace(/\D/g, '');
      if (digits.length < 10 || digits.length > 15) return { valido: false, erro: `"${campo.display_name}" deve ser um telefone valido` };
      return { valido: true, valor: v };
    }
    case 'cpf': {
      const cpfDigits = v.replace(/\D/g, '');
      if (cpfDigits.length !== 11) return { valido: false, erro: `"${campo.display_name}" deve ter 11 digitos` };
      return { valido: true, valor: v };
    }
    default: // text
      break;
  }

  // Regex validation (para qualquer tipo)
  if (campo.regex_pattern) {
    try {
      const re = new RegExp(campo.regex_pattern);
      if (!re.test(v)) {
        return { valido: false, erro: campo.regex_mensagem || `"${campo.display_name}" formato invalido` };
      }
    } catch { /* regex inválida, ignora */ }
  }

  return { valido: true, valor: v };
}

export default async function camposPersonalizadosRoutes(fastify) {
  // ============================================
  // GET /api/campos-personalizados — Listar
  // ============================================
  fastify.get('/', {
    preHandler: [
      fastify.authenticate,
      fastify.addTenantFilter,
      fastify.requirePermission('configuracoes', 'read'),
    ],
  }, async (request, reply) => {
    const { empresaId } = request;
    const { contexto, ativo } = request.query || {};

    let where = 'empresa_id = $1';
    const params = [empresaId];
    let paramCount = 1;

    if (contexto && CONTEXTOS_VALIDOS.includes(contexto)) {
      paramCount++;
      where += ` AND contexto = $${paramCount}`;
      params.push(contexto);
    }

    if (ativo !== undefined) {
      paramCount++;
      where += ` AND ativo = $${paramCount}`;
      params.push(ativo === 'true');
    }

    const result = await pool.query(
      `SELECT * FROM campos_personalizados WHERE ${where} ORDER BY contexto, ordem, display_name`,
      params
    );

    reply.send({ success: true, data: result.rows });
  });

  // ============================================
  // GET /api/campos-personalizados/ativos — Campos ativos (para operador/IA)
  // Permissão mais ampla: qualquer autenticado
  // ============================================
  fastify.get('/ativos', {
    preHandler: [
      fastify.authenticate,
      fastify.addTenantFilter,
    ],
  }, async (request, reply) => {
    const { empresaId } = request;
    const { contexto } = request.query || {};

    let where = 'empresa_id = $1 AND ativo = true';
    const params = [empresaId];

    if (contexto && CONTEXTOS_VALIDOS.includes(contexto)) {
      where += ' AND contexto = $2';
      params.push(contexto);
    }

    const result = await pool.query(
      `SELECT id, display_name, chave, tipo, contexto, descricao, opcoes, regex_pattern, regex_mensagem, valor_padrao, obrigatorio_resolucao, ordem
       FROM campos_personalizados WHERE ${where} ORDER BY contexto, ordem, display_name`,
      params
    );

    reply.send({ success: true, data: result.rows });
  });

  // ============================================
  // POST /api/campos-personalizados — Criar
  // ============================================
  fastify.post('/', {
    preHandler: [
      fastify.authenticate,
      fastify.addTenantFilter,
      fastify.requirePermission('configuracoes', 'write'),
    ],
  }, async (request, reply) => {
    const { empresaId } = request;
    const {
      display_name, chave: chaveInput, tipo, contexto, descricao,
      opcoes, regex_pattern, regex_mensagem, valor_padrao,
      obrigatorio_resolucao, ordem,
    } = request.body;

    if (!display_name || !display_name.trim()) {
      return reply.status(400).send({ success: false, error: { message: 'Nome do campo e obrigatorio' } });
    }

    if (!contexto || !CONTEXTOS_VALIDOS.includes(contexto)) {
      return reply.status(400).send({ success: false, error: { message: 'Contexto deve ser "contato" ou "atendimento"' } });
    }

    if (tipo && !TIPOS_VALIDOS.includes(tipo)) {
      return reply.status(400).send({ success: false, error: { message: `Tipo invalido. Validos: ${TIPOS_VALIDOS.join(', ')}` } });
    }

    const chave = (chaveInput && chaveInput.trim()) ? chaveInput.trim().toLowerCase().replace(/[^a-z0-9_]/g, '_') : gerarChave(display_name);

    // Verificar duplicado
    const existing = await pool.query(
      `SELECT id FROM campos_personalizados WHERE empresa_id = $1 AND contexto = $2 AND chave = $3`,
      [empresaId, contexto, chave]
    );
    if (existing.rows.length > 0) {
      return reply.status(409).send({ success: false, error: { message: `Ja existe campo com chave "${chave}" no contexto "${contexto}"` } });
    }

    // Calcular próxima ordem
    const maxOrdem = await pool.query(
      `SELECT COALESCE(MAX(ordem), 0) + 1 as next_ordem FROM campos_personalizados WHERE empresa_id = $1 AND contexto = $2`,
      [empresaId, contexto]
    );

    const result = await pool.query(
      `INSERT INTO campos_personalizados
        (empresa_id, display_name, chave, tipo, contexto, descricao,
         opcoes, regex_pattern, regex_mensagem, valor_padrao,
         obrigatorio_resolucao, ordem)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       RETURNING *`,
      [
        empresaId,
        display_name.trim(),
        chave,
        tipo || 'text',
        contexto,
        descricao || null,
        opcoes ? JSON.stringify(opcoes) : '[]',
        regex_pattern || null,
        regex_mensagem || null,
        valor_padrao || null,
        obrigatorio_resolucao || false,
        ordem !== undefined ? ordem : maxOrdem.rows[0].next_ordem,
      ]
    );

    logger.info(`Campo personalizado criado: ${display_name} (${chave}) [${contexto}]`);
    reply.status(201).send({ success: true, data: result.rows[0] });
  });

  // ============================================
  // PUT /api/campos-personalizados/:id — Atualizar
  // ============================================
  fastify.put('/:id', {
    preHandler: [
      fastify.authenticate,
      fastify.addTenantFilter,
      fastify.requirePermission('configuracoes', 'write'),
    ],
  }, async (request, reply) => {
    const { id } = request.params;
    const { empresaId } = request;
    const body = request.body;

    const existing = await pool.query(
      `SELECT * FROM campos_personalizados WHERE id = $1 AND empresa_id = $2`,
      [id, empresaId]
    );
    if (existing.rows.length === 0) {
      return reply.status(404).send({ success: false, error: { message: 'Campo nao encontrado' } });
    }

    if (body.tipo && !TIPOS_VALIDOS.includes(body.tipo)) {
      return reply.status(400).send({ success: false, error: { message: `Tipo invalido. Validos: ${TIPOS_VALIDOS.join(', ')}` } });
    }

    const allowedFields = [
      'display_name', 'tipo', 'descricao', 'opcoes', 'regex_pattern',
      'regex_mensagem', 'valor_padrao', 'obrigatorio_resolucao', 'ordem', 'ativo',
    ];

    const fields = [];
    const values = [];
    let paramCount = 0;

    for (const field of allowedFields) {
      if (body[field] !== undefined) {
        paramCount++;
        fields.push(`${field} = $${paramCount}`);
        values.push(field === 'opcoes' ? JSON.stringify(body[field]) : body[field]);
      }
    }

    if (fields.length === 0) {
      return reply.status(400).send({ success: false, error: { message: 'Nenhum campo para atualizar' } });
    }

    fields.push('atualizado_em = NOW()');
    paramCount++;
    values.push(id);

    const result = await pool.query(
      `UPDATE campos_personalizados SET ${fields.join(', ')} WHERE id = $${paramCount} RETURNING *`,
      values
    );

    reply.send({ success: true, data: result.rows[0] });
  });

  // ============================================
  // DELETE /api/campos-personalizados/:id — Desativar (soft delete)
  // ============================================
  fastify.delete('/:id', {
    preHandler: [
      fastify.authenticate,
      fastify.addTenantFilter,
      fastify.requirePermission('configuracoes', 'delete'),
    ],
  }, async (request, reply) => {
    const { id } = request.params;
    const { empresaId } = request;

    const existing = await pool.query(
      `SELECT id, display_name FROM campos_personalizados WHERE id = $1 AND empresa_id = $2`,
      [id, empresaId]
    );
    if (existing.rows.length === 0) {
      return reply.status(404).send({ success: false, error: { message: 'Campo nao encontrado' } });
    }

    await pool.query(
      `UPDATE campos_personalizados SET ativo = false, atualizado_em = NOW() WHERE id = $1`,
      [id]
    );

    logger.info(`Campo personalizado desativado: ${existing.rows[0].display_name} (${id})`);
    reply.status(204).send();
  });

  // ============================================
  // PUT /api/campos-personalizados/reordenar — Reordenar campos
  // ============================================
  fastify.put('/reordenar', {
    preHandler: [
      fastify.authenticate,
      fastify.addTenantFilter,
      fastify.requirePermission('configuracoes', 'write'),
    ],
  }, async (request, reply) => {
    const { empresaId } = request;
    const { campos } = request.body; // [{ id, ordem }]

    if (!Array.isArray(campos) || campos.length === 0) {
      return reply.status(400).send({ success: false, error: { message: 'campos deve ser um array de { id, ordem }' } });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const { id, ordem } of campos) {
        await client.query(
          `UPDATE campos_personalizados SET ordem = $1, atualizado_em = NOW() WHERE id = $2 AND empresa_id = $3`,
          [ordem, id, empresaId]
        );
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    reply.send({ success: true });
  });
}
