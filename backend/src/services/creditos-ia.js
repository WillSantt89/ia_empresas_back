/**
 * Serviço de Créditos IA
 *
 * Gerencia pool mensal de créditos por empresa.
 * 1 crédito = 1 conversa nova processada pela IA.
 * Prioridade: plano → extras → bloqueio.
 */
import { pool } from '../config/database.js';
import { logger } from '../config/logger.js';

const log = logger.child({ module: 'creditos-ia' });

/**
 * Verifica se empresa tem créditos disponíveis.
 * Retorna { disponivel, saldo_plano, saldo_extras, bloqueado } ou null se não tem registro.
 */
export async function verificarCreditos(empresa_id) {
  const result = await pool.query(
    `SELECT * FROM creditos_ia WHERE empresa_id = $1`,
    [empresa_id]
  );

  if (result.rows.length === 0) {
    // Empresa sem registro de créditos — pode ser plano Chat (sem IA) ou legacy
    return null;
  }

  const c = result.rows[0];
  const saldo_plano = c.creditos_plano - c.creditos_plano_usados;
  const saldo_extras = c.creditos_extras - c.creditos_extras_usados;

  return {
    disponivel: !c.bloqueado && (saldo_plano > 0 || saldo_extras > 0),
    saldo_plano,
    saldo_extras,
    saldo_total: saldo_plano + saldo_extras,
    creditos_plano: c.creditos_plano,
    creditos_plano_usados: c.creditos_plano_usados,
    creditos_extras: c.creditos_extras,
    creditos_extras_usados: c.creditos_extras_usados,
    bloqueado: c.bloqueado,
    notificado_90: c.notificado_90,
    ciclo_inicio: c.ciclo_inicio,
    ciclo_fim: c.ciclo_fim,
  };
}

/**
 * Consome 1 crédito para a empresa.
 * Prioridade: plano primeiro, depois extras.
 * Retorna { consumido, fonte, saldo_restante } ou { consumido: false, motivo }.
 */
export async function consumirCredito(empresa_id, referencia = null) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Lock row para evitar race condition
    const result = await client.query(
      `SELECT * FROM creditos_ia WHERE empresa_id = $1 FOR UPDATE`,
      [empresa_id]
    );

    if (result.rows.length === 0) {
      await client.query('COMMIT');
      // Sem registro = sem controle de créditos (plano Chat legacy)
      return { consumido: true, fonte: 'sem_controle', saldo_restante: null };
    }

    const c = result.rows[0];

    if (c.bloqueado) {
      await client.query('COMMIT');
      return { consumido: false, motivo: 'bloqueado' };
    }

    const saldo_plano = c.creditos_plano - c.creditos_plano_usados;
    const saldo_extras = c.creditos_extras - c.creditos_extras_usados;

    if (saldo_plano <= 0 && saldo_extras <= 0) {
      // Bloquear
      await client.query(
        `UPDATE creditos_ia SET bloqueado = true, atualizado_em = NOW() WHERE empresa_id = $1`,
        [empresa_id]
      );
      await client.query('COMMIT');
      return { consumido: false, motivo: 'sem_creditos' };
    }

    let fonte;
    let saldo_apos;

    if (saldo_plano > 0) {
      // Consumir do plano
      await client.query(
        `UPDATE creditos_ia SET creditos_plano_usados = creditos_plano_usados + 1, atualizado_em = NOW() WHERE empresa_id = $1`,
        [empresa_id]
      );
      fonte = 'plano';
      saldo_apos = (saldo_plano - 1) + saldo_extras;
    } else {
      // Consumir dos extras
      await client.query(
        `UPDATE creditos_ia SET creditos_extras_usados = creditos_extras_usados + 1, atualizado_em = NOW() WHERE empresa_id = $1`,
        [empresa_id]
      );
      fonte = 'extras';
      saldo_apos = saldo_extras - 1;
    }

    // Registrar histórico
    await client.query(
      `INSERT INTO creditos_ia_historico (empresa_id, tipo, quantidade, saldo_apos, referencia)
       VALUES ($1, 'consumo', -1, $2, $3)`,
      [empresa_id, saldo_apos, referencia]
    );

    // Verificar se atingiu 90% (notificar) ou 100% (bloquear)
    const total = c.creditos_plano + c.creditos_extras;
    const usados = (c.creditos_plano_usados + 1) + c.creditos_extras_usados;
    // Ajustar usados conforme fonte
    const usados_real = fonte === 'plano'
      ? (c.creditos_plano_usados + 1) + c.creditos_extras_usados
      : c.creditos_plano_usados + (c.creditos_extras_usados + 1);

    const percentual = total > 0 ? (usados_real / total) * 100 : 0;

    if (percentual >= 100) {
      await client.query(
        `UPDATE creditos_ia SET bloqueado = true, atualizado_em = NOW() WHERE empresa_id = $1`,
        [empresa_id]
      );
      // Notificação de bloqueio
      await criarNotificacaoCreditos(client, empresa_id, 'creditos_100', 'Créditos IA Esgotados', 'Todos os créditos de IA foram consumidos. A IA está bloqueada até recarga ou próximo ciclo.');
      log.warn('Créditos esgotados — IA bloqueada', { empresa_id });
    } else if (percentual >= 90 && !c.notificado_90) {
      await client.query(
        `UPDATE creditos_ia SET notificado_90 = true, atualizado_em = NOW() WHERE empresa_id = $1`,
        [empresa_id]
      );
      await criarNotificacaoCreditos(client, empresa_id, 'creditos_90', 'Créditos IA em 90%', `Atenção: ${Math.round(percentual)}% dos créditos de IA foram consumidos. Considere fazer uma recarga.`);
      log.warn('90% dos créditos consumidos', { empresa_id, percentual: Math.round(percentual) });
    }

    await client.query('COMMIT');

    return { consumido: true, fonte, saldo_restante: saldo_apos, percentual: Math.round(percentual) };
  } catch (error) {
    await client.query('ROLLBACK');
    log.error('Erro ao consumir crédito:', error);
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Efetua recarga de créditos extras para uma empresa.
 */
export async function recarregarCreditos(empresa_id, quantidade, executado_por_id = null) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const result = await client.query(
      `SELECT * FROM creditos_ia WHERE empresa_id = $1 FOR UPDATE`,
      [empresa_id]
    );

    if (result.rows.length === 0) {
      await client.query('ROLLBACK');
      throw new Error('Registro de créditos não encontrado para esta empresa');
    }

    const c = result.rows[0];
    const novos_extras = c.creditos_extras + quantidade;
    const saldo_apos = (c.creditos_plano - c.creditos_plano_usados) + (novos_extras - c.creditos_extras_usados);

    await client.query(
      `UPDATE creditos_ia SET creditos_extras = $2, bloqueado = false, atualizado_em = NOW() WHERE empresa_id = $1`,
      [empresa_id, novos_extras]
    );

    // Histórico de créditos
    await client.query(
      `INSERT INTO creditos_ia_historico (empresa_id, tipo, quantidade, saldo_apos, referencia)
       VALUES ($1, 'recarga', $2, $3, $4)`,
      [empresa_id, quantidade, saldo_apos, `recarga:manual:${executado_por_id || 'sistema'}`]
    );

    // Histórico de assinatura
    const assResult = await client.query(
      `SELECT id FROM assinaturas WHERE empresa_id = $1`,
      [empresa_id]
    );
    if (assResult.rows.length > 0 && executado_por_id) {
      await client.query(
        `INSERT INTO assinatura_historico (id, assinatura_id, empresa_id, acao, executado_por, criado_em)
         VALUES (gen_random_uuid(), $1, $2, 'adicionou_item', $3, NOW())`,
        [assResult.rows[0].id, empresa_id, executado_por_id]
      );
    }

    // Notificar desbloqueio
    if (c.bloqueado) {
      await criarNotificacaoCreditos(client, empresa_id, 'creditos_recarga', 'Créditos IA Recarregados', `${quantidade} créditos adicionados. IA desbloqueada.`);
    }

    await client.query('COMMIT');

    log.info('Recarga efetuada', { empresa_id, quantidade, saldo_apos });

    return { creditos_extras: novos_extras, saldo_total: saldo_apos, desbloqueado: c.bloqueado };
  } catch (error) {
    await client.query('ROLLBACK');
    log.error('Erro na recarga:', error);
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Reset mensal de créditos do plano (executado pelo daily-reset no dia 1 ou renovação).
 */
export async function resetMensalCreditos() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Buscar empresas cujo ciclo_fim <= hoje
    const result = await client.query(`
      SELECT c.*, p.creditos_ia_mensal
      FROM creditos_ia c
      JOIN assinaturas a ON a.empresa_id = c.empresa_id AND a.status = 'ativa'
      JOIN planos p ON p.id = a.plano_id
      WHERE c.ciclo_fim <= CURRENT_DATE
    `);

    let resetados = 0;

    for (const c of result.rows) {
      const novo_ciclo_inicio = (new Date()).toISOString().split('T')[0];
      // Próximo ciclo: último dia do próximo mês
      const hoje = new Date();
      const prox_mes = new Date(hoje.getFullYear(), hoje.getMonth() + 1, 1);
      const ultimo_dia = new Date(prox_mes.getFullYear(), prox_mes.getMonth() + 1, 0);
      const novo_ciclo_fim = ultimo_dia.toISOString().split('T')[0];

      const saldo_apos = c.creditos_ia_mensal + (c.creditos_extras - c.creditos_extras_usados);

      await client.query(`
        UPDATE creditos_ia SET
          creditos_plano = $2,
          creditos_plano_usados = 0,
          notificado_90 = false,
          bloqueado = false,
          ciclo_inicio = $3,
          ciclo_fim = $4,
          atualizado_em = NOW()
        WHERE empresa_id = $1
      `, [c.empresa_id, c.creditos_ia_mensal, novo_ciclo_inicio, novo_ciclo_fim]);

      // Histórico
      await client.query(
        `INSERT INTO creditos_ia_historico (empresa_id, tipo, quantidade, saldo_apos, referencia)
         VALUES ($1, 'reset_mensal', $2, $3, $4)`,
        [c.empresa_id, c.creditos_ia_mensal, saldo_apos, `ciclo:${novo_ciclo_inicio}:${novo_ciclo_fim}`]
      );

      resetados++;
    }

    await client.query('COMMIT');
    log.info(`Reset mensal concluído: ${resetados} empresas`);
    return resetados;
  } catch (error) {
    await client.query('ROLLBACK');
    log.error('Erro no reset mensal:', error);
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Inicializa créditos para uma empresa ao criar/mudar assinatura.
 */
export async function inicializarCreditos(empresa_id, creditos_plano) {
  const hoje = new Date();
  const ultimo_dia = new Date(hoje.getFullYear(), hoje.getMonth() + 1, 0);

  await pool.query(`
    INSERT INTO creditos_ia (empresa_id, creditos_plano, ciclo_inicio, ciclo_fim)
    VALUES ($1, $2, CURRENT_DATE, $3)
    ON CONFLICT (empresa_id) DO UPDATE SET
      creditos_plano = $2,
      creditos_plano_usados = 0,
      notificado_90 = false,
      bloqueado = false,
      ciclo_inicio = CURRENT_DATE,
      ciclo_fim = $3,
      atualizado_em = NOW()
  `, [empresa_id, creditos_plano, ultimo_dia.toISOString().split('T')[0]]);

  log.info('Créditos inicializados', { empresa_id, creditos_plano });
}

/**
 * Obtém resumo de créditos para exibição no frontend.
 */
export async function obterResumoCreditos(empresa_id) {
  const result = await pool.query(
    `SELECT c.*, p.nome as plano_nome, p.creditos_ia_mensal as creditos_do_plano
     FROM creditos_ia c
     JOIN assinaturas a ON a.empresa_id = c.empresa_id
     JOIN planos p ON p.id = a.plano_id
     WHERE c.empresa_id = $1`,
    [empresa_id]
  );

  if (result.rows.length === 0) return null;

  const c = result.rows[0];
  const total = c.creditos_plano + c.creditos_extras;
  const usados = c.creditos_plano_usados + c.creditos_extras_usados;
  const saldo = total - usados;
  const percentual = total > 0 ? Math.round((usados / total) * 100) : 0;
  const dias_restantes = Math.max(0, Math.ceil((new Date(c.ciclo_fim) - new Date()) / (1000 * 60 * 60 * 24)));

  return {
    plano_nome: c.plano_nome,
    creditos_plano: c.creditos_plano,
    creditos_plano_usados: c.creditos_plano_usados,
    creditos_extras: c.creditos_extras,
    creditos_extras_usados: c.creditos_extras_usados,
    total,
    usados,
    saldo,
    percentual,
    dias_restantes,
    ciclo_inicio: c.ciclo_inicio,
    ciclo_fim: c.ciclo_fim,
    bloqueado: c.bloqueado,
    notificado_90: c.notificado_90,
  };
}

async function criarNotificacaoCreditos(client, empresa_id, tipo, titulo, mensagem) {
  try {
    await client.query(`
      INSERT INTO notificacoes (id, empresa_id, tipo, titulo, mensagem, severidade, lida, criado_em)
      VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, false, NOW())
    `, [empresa_id, tipo, titulo, mensagem, tipo === 'creditos_100' ? 'critical' : 'warning']);
  } catch (err) {
    log.error('Erro ao criar notificação de créditos:', err);
  }
}
