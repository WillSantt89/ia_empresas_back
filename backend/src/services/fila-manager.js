import { pool } from '../config/database.js';
import { logger } from '../config/logger.js';

/**
 * Retorna as filas que um usuario pertence
 */
export async function getFilasDoUsuario(usuarioId, empresaId) {
  const result = await pool.query(
    `SELECT fa.* FROM filas_atendimento fa
     JOIN fila_membros fm ON fa.id = fm.fila_id
     WHERE fm.usuario_id = $1 AND fa.empresa_id = $2 AND fa.ativo = true
     ORDER BY fa.nome`,
    [usuarioId, empresaId]
  );
  return result.rows;
}

/**
 * Verifica se usuario e membro de uma fila
 */
export async function isMembroDaFila(usuarioId, filaId) {
  const result = await pool.query(
    `SELECT 1 FROM fila_membros WHERE usuario_id = $1 AND fila_id = $2`,
    [usuarioId, filaId]
  );
  return result.rows.length > 0;
}

/**
 * Proximo operador disponivel (round-robin com balanceamento)
 */
export async function getProximoOperadorDisponivel(filaId) {
  // Buscar membros disponiveis que nao atingiram limite
  const result = await pool.query(
    `SELECT
       u.id, u.nome, u.max_conversas_simultaneas,
       COUNT(c.id) FILTER (WHERE c.status = 'ativo' AND c.controlado_por = 'humano') as conversas_ativas
     FROM fila_membros fm
     JOIN usuarios u ON fm.usuario_id = u.id
     LEFT JOIN conversas c ON c.operador_id = u.id AND c.status = 'ativo'
     WHERE fm.fila_id = $1
       AND u.disponibilidade = 'disponivel'
       AND u.ativo = true
     GROUP BY u.id, u.nome, u.max_conversas_simultaneas
     HAVING COUNT(c.id) FILTER (WHERE c.status = 'ativo' AND c.controlado_por = 'humano') < u.max_conversas_simultaneas
     ORDER BY COUNT(c.id) FILTER (WHERE c.status = 'ativo' AND c.controlado_por = 'humano') ASC,
              RANDOM()
     LIMIT 1`,
    [filaId]
  );

  return result.rows[0] || null;
}

/**
 * Atribui conversa automaticamente via round-robin
 * Retorna o operador atribuido ou null
 */
export async function atribuirConversaAutomatica(conversaId, filaId) {
  // Verificar se fila tem auto_assignment
  const filaResult = await pool.query(
    `SELECT auto_assignment FROM filas_atendimento WHERE id = $1 AND ativo = true`,
    [filaId]
  );

  if (!filaResult.rows[0]?.auto_assignment) {
    return null;
  }

  const operador = await getProximoOperadorDisponivel(filaId);
  if (!operador) {
    return null;
  }

  // Atribuir
  await pool.query(
    `UPDATE conversas SET
       operador_id = $1,
       operador_nome = $2,
       operador_atribuido_em = NOW(),
       controlado_por = 'humano',
       atualizado_em = NOW()
     WHERE id = $3`,
    [operador.id, operador.nome, conversaId]
  );

  // Registrar no historico
  await pool.query(
    `INSERT INTO controle_historico
       (conversa_id, empresa_id, acao, de_controlador, para_controlador, humano_id, humano_nome, motivo)
     SELECT
       id, empresa_id, 'auto_assignment', controlado_por, 'humano', $1, $2, 'Round-robin automatico'
     FROM conversas WHERE id = $3`,
    [operador.id, operador.nome, conversaId]
  );

  logger.info(`Auto-assigned conversa ${conversaId} to ${operador.nome}`);
  return operador;
}

/**
 * Calcula estatisticas das filas de uma empresa
 */
export async function calcularStatsFilas(empresaId, filaIds = null) {
  let whereExtra = '';
  const params = [empresaId];

  if (filaIds && filaIds.length > 0) {
    whereExtra = ` AND fa.id = ANY($2)`;
    params.push(filaIds);
  }

  const result = await pool.query(
    `SELECT
       fa.id as fila_id,
       fa.nome,
       COUNT(c.id) FILTER (WHERE c.status = 'ativo' AND c.operador_id IS NULL) as aguardando,
       COUNT(c.id) FILTER (WHERE c.status = 'ativo' AND c.operador_id IS NOT NULL AND c.controlado_por = 'humano') as em_atendimento,
       COUNT(DISTINCT c.operador_id) FILTER (WHERE c.status = 'ativo') as operadores_atendendo,
       (SELECT COUNT(*) FROM fila_membros fm2
        JOIN usuarios u2 ON fm2.usuario_id = u2.id
        WHERE fm2.fila_id = fa.id AND u2.disponibilidade = 'disponivel') as membros_online,
       (SELECT COUNT(*) FROM fila_membros fm3 WHERE fm3.fila_id = fa.id) as membros_total
     FROM filas_atendimento fa
     LEFT JOIN conversas c ON c.fila_id = fa.id AND c.status IN ('ativo', 'pendente')
     WHERE fa.empresa_id = $1 AND fa.ativo = true${whereExtra}
     GROUP BY fa.id, fa.nome
     ORDER BY fa.nome`,
    params
  );

  return result.rows.map(r => ({
    ...r,
    aguardando: parseInt(r.aguardando) || 0,
    em_atendimento: parseInt(r.em_atendimento) || 0,
    operadores_atendendo: parseInt(r.operadores_atendendo) || 0,
    membros_online: parseInt(r.membros_online) || 0,
    membros_total: parseInt(r.membros_total) || 0,
  }));
}

/**
 * Calcula stats de uma fila individual
 */
export async function calcularStatsFila(filaId) {
  const result = await pool.query(
    `SELECT
       COUNT(c.id) FILTER (WHERE c.operador_id IS NULL) as aguardando,
       COUNT(c.id) FILTER (WHERE c.operador_id IS NOT NULL AND c.controlado_por = 'humano') as em_atendimento,
       (SELECT COUNT(*) FROM fila_membros fm
        JOIN usuarios u ON fm.usuario_id = u.id
        WHERE fm.fila_id = $1 AND u.disponibilidade = 'disponivel') as membros_online,
       (SELECT COUNT(*) FROM fila_membros fm2 WHERE fm2.fila_id = $1) as membros_total
     FROM conversas c
     WHERE c.fila_id = $1 AND c.status IN ('ativo', 'pendente')`,
    [filaId]
  );

  const row = result.rows[0] || { aguardando: 0, em_atendimento: 0, membros_online: 0, membros_total: 0 };
  return {
    ...row,
    aguardando: parseInt(row.aguardando) || 0,
    em_atendimento: parseInt(row.em_atendimento) || 0,
    membros_online: parseInt(row.membros_online) || 0,
    membros_total: parseInt(row.membros_total) || 0,
  };
}

/**
 * Verifica se operador pode receber mais conversas
 */
export async function verificarCapacidadeOperador(usuarioId) {
  const result = await pool.query(
    `SELECT
       u.max_conversas_simultaneas,
       COUNT(c.id) as conversas_ativas
     FROM usuarios u
     LEFT JOIN conversas c ON c.operador_id = u.id AND c.status = 'ativo' AND c.controlado_por = 'humano'
     WHERE u.id = $1
     GROUP BY u.id, u.max_conversas_simultaneas`,
    [usuarioId]
  );

  if (result.rows.length === 0) return false;
  const { max_conversas_simultaneas, conversas_ativas } = result.rows[0];
  return parseInt(conversas_ativas) < parseInt(max_conversas_simultaneas);
}

/**
 * Verifica horario de funcionamento da fila
 */
export function verificarHorarioFuncionamento(fila) {
  if (!fila.horario_funcionamento_ativo) return true;

  const agora = new Date();
  const dias = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sab'];
  const diaAtual = dias[agora.getDay()];
  const horario = fila.horario_funcionamento?.[diaAtual];

  if (!horario) return false;

  const horaAtual = `${String(agora.getHours()).padStart(2, '0')}:${String(agora.getMinutes()).padStart(2, '0')}`;
  return horaAtual >= horario.inicio && horaAtual <= horario.fim;
}
