import { query } from '../config/database.js';
import { logger } from '../config/logger.js';
import { ERROR_CODES } from '../config/constants.js';

/**
 * Resource limit checking middleware
 * Verifies if company has not exceeded subscription limits
 */

/**
 * Check if company has reached limit for a resource type
 * @param {string} tipoRecurso - Resource type ('agente_ia', 'numero_whatsapp', 'usuarios', 'tools')
 * @returns {Function} Middleware function
 */
export function checkLimit(tipoRecurso) {
  return async (request, reply) => {
    try {
      // Skip for master users in global context
      if (request.isMaster && !request.empresaId) {
        return;
      }

      // Skip for GET requests (listing/viewing)
      if (request.method === 'GET') {
        return;
      }

      const empresaId = request.empresaId;
      if (!empresaId) {
        return; // No company context, skip limit check
      }

      switch (tipoRecurso) {
        case 'agente_ia':
          await checkAgenteLimit(empresaId, reply);
          break;

        case 'numero_whatsapp':
          await checkNumeroWhatsappLimit(empresaId, reply);
          break;

        case 'usuarios':
          await checkUsuariosLimit(empresaId, reply);
          break;

        case 'tools':
          await checkToolsLimit(empresaId, reply);
          break;

        default:
          logger.warn('Unknown resource type for limit check', { tipo_recurso: tipoRecurso });
      }

      logger.debug('Limit check passed', {
        empresa_id: empresaId,
        tipo_recurso: tipoRecurso
      });

    } catch (error) {
      logger.error('Limit middleware error', {
        error: error.message,
        empresa_id: request.empresaId,
        tipo_recurso: tipoRecurso
      });

      reply.code(error.statusCode || 500).send({
        success: false,
        error: {
          code: error.code || ERROR_CODES.INTERNAL_ERROR,
          message: error.message
        }
      });
    }
  };
}

/**
 * Check AI agent limit
 */
async function checkAgenteLimit(empresaId, reply) {
  // Get contracted quantity
  const { rows: contracted } = await query(`
    SELECT
      ai.quantidade,
      ai.ativo
    FROM assinatura_itens ai
    JOIN assinaturas a ON a.id = ai.assinatura_id
    JOIN itens_cobraveis ic ON ic.id = ai.item_cobravel_id
    WHERE ai.empresa_id = $1
      AND ic.slug = 'agente_ia'
      AND ai.ativo = true
      AND a.status = 'ativa'
    LIMIT 1
  `, [empresaId]);

  if (contracted.length === 0) {
    const error = new Error('Sem item contratado para agentes IA');
    error.code = ERROR_CODES.RESOURCE_LIMIT_REACHED;
    error.statusCode = 403;
    throw error;
  }

  const quantidadeContratada = contracted[0].quantidade;

  // Get current quantity
  const { rows: current } = await query(`
    SELECT COUNT(*) as total
    FROM agentes
    WHERE empresa_id = $1 AND ativo = true
  `, [empresaId]);

  const quantidadeAtual = parseInt(current[0].total);

  if (quantidadeAtual >= quantidadeContratada) {
    const error = new Error(`Limite de ${quantidadeContratada} agentes IA atingido`);
    error.code = ERROR_CODES.RESOURCE_LIMIT_REACHED;
    error.statusCode = 403;
    throw error;
  }
}

/**
 * Check WhatsApp number limit
 */
async function checkNumeroWhatsappLimit(empresaId, reply) {
  // Get contracted quantity
  const { rows: contracted } = await query(`
    SELECT
      ai.quantidade,
      ai.ativo
    FROM assinatura_itens ai
    JOIN assinaturas a ON a.id = ai.assinatura_id
    JOIN itens_cobraveis ic ON ic.id = ai.item_cobravel_id
    WHERE ai.empresa_id = $1
      AND ic.slug = 'numero_whatsapp'
      AND ai.ativo = true
      AND a.status = 'ativa'
    LIMIT 1
  `, [empresaId]);

  if (contracted.length === 0) {
    const error = new Error('Sem item contratado para números WhatsApp');
    error.code = ERROR_CODES.RESOURCE_LIMIT_REACHED;
    error.statusCode = 403;
    throw error;
  }

  const quantidadeContratada = contracted[0].quantidade;

  // Get current quantity
  const { rows: current } = await query(`
    SELECT COUNT(*) as total
    FROM whatsapp_numbers
    WHERE empresa_id = $1 AND ativo = true
  `, [empresaId]);

  const quantidadeAtual = parseInt(current[0].total);

  if (quantidadeAtual >= quantidadeContratada) {
    const error = new Error(`Limite de ${quantidadeContratada} números WhatsApp atingido`);
    error.code = ERROR_CODES.RESOURCE_LIMIT_REACHED;
    error.statusCode = 403;
    throw error;
  }
}

/**
 * Check users limit based on plan
 */
async function checkUsuariosLimit(empresaId, reply) {
  // Get plan limits
  const { rows: planLimits } = await query(`
    SELECT p.max_usuarios
    FROM empresas e
    JOIN planos p ON p.id = e.plano_id
    WHERE e.id = $1
    LIMIT 1
  `, [empresaId]);

  if (planLimits.length === 0) {
    return; // No plan, skip check
  }

  const maxUsuarios = planLimits[0].max_usuarios;

  // Get current quantity
  const { rows: current } = await query(`
    SELECT COUNT(*) as total
    FROM usuarios
    WHERE empresa_id = $1 AND ativo = true
  `, [empresaId]);

  const quantidadeAtual = parseInt(current[0].total);

  if (quantidadeAtual >= maxUsuarios) {
    const error = new Error(`Limite de ${maxUsuarios} usuários do plano atingido`);
    error.code = ERROR_CODES.RESOURCE_LIMIT_REACHED;
    error.statusCode = 403;
    throw error;
  }
}

/**
 * Check tools limit based on plan
 */
async function checkToolsLimit(empresaId, reply) {
  // Get plan limits
  const { rows: planLimits } = await query(`
    SELECT p.max_tools
    FROM empresas e
    JOIN planos p ON p.id = e.plano_id
    WHERE e.id = $1
    LIMIT 1
  `, [empresaId]);

  if (planLimits.length === 0) {
    return; // No plan, skip check
  }

  const maxTools = planLimits[0].max_tools;

  // Get current quantity
  const { rows: current } = await query(`
    SELECT COUNT(*) as total
    FROM tools
    WHERE empresa_id = $1 AND ativo = true
  `, [empresaId]);

  const quantidadeAtual = parseInt(current[0].total);

  if (quantidadeAtual >= maxTools) {
    const error = new Error(`Limite de ${maxTools} tools do plano atingido`);
    error.code = ERROR_CODES.RESOURCE_LIMIT_REACHED;
    error.statusCode = 403;
    throw error;
  }
}

/**
 * Check daily message limit for the company
 */
export async function checkMessageLimit(empresaId) {
  // Get plan message limit
  const { rows: planLimits } = await query(`
    SELECT p.max_mensagens_mes
    FROM empresas e
    JOIN planos p ON p.id = e.plano_id
    WHERE e.id = $1
    LIMIT 1
  `, [empresaId]);

  if (planLimits.length === 0) {
    return true; // No plan, allow
  }

  const maxMensagensMes = planLimits[0].max_mensagens_mes;

  // Get current month usage
  const currentMonth = new Date().toISOString().slice(0, 7); // YYYY-MM
  const { rows: usage } = await query(`
    SELECT total_mensagens
    FROM uso_mensal
    WHERE empresa_id = $1 AND ano_mes = $2
    LIMIT 1
  `, [empresaId, currentMonth]);

  const mensagensUsadas = usage.length > 0 ? parseInt(usage[0].total_mensagens) : 0;

  if (mensagensUsadas >= maxMensagensMes) {
    logger.warn('Monthly message limit reached', {
      empresa_id: empresaId,
      limit: maxMensagensMes,
      used: mensagensUsadas
    });
    return false;
  }

  return true;
}

/**
 * Get resource usage summary for a company
 */
export async function getResourceUsage(empresaId) {
  const [agentes, numeros, usuarios, tools, mensagens] = await Promise.all([
    // Agentes
    query(`
      SELECT
        COUNT(*) FILTER (WHERE ativo = true) as atual,
        COALESCE(ai.quantidade, 0) as contratado
      FROM agentes a
      CROSS JOIN LATERAL (
        SELECT ai.quantidade
        FROM assinatura_itens ai
        JOIN assinaturas assin ON assin.id = ai.assinatura_id
        JOIN itens_cobraveis ic ON ic.id = ai.item_cobravel_id
        WHERE ai.empresa_id = $1
          AND ic.slug = 'agente_ia'
          AND ai.ativo = true
          AND assin.status = 'ativa'
        LIMIT 1
      ) ai
      WHERE a.empresa_id = $1
      GROUP BY ai.quantidade
    `, [empresaId]),

    // Números WhatsApp
    query(`
      SELECT
        COUNT(*) FILTER (WHERE ativo = true) as atual,
        COALESCE(ai.quantidade, 0) as contratado
      FROM whatsapp_numbers wn
      CROSS JOIN LATERAL (
        SELECT ai.quantidade
        FROM assinatura_itens ai
        JOIN assinaturas assin ON assin.id = ai.assinatura_id
        JOIN itens_cobraveis ic ON ic.id = ai.item_cobravel_id
        WHERE ai.empresa_id = $1
          AND ic.slug = 'numero_whatsapp'
          AND ai.ativo = true
          AND assin.status = 'ativa'
        LIMIT 1
      ) ai
      WHERE wn.empresa_id = $1
      GROUP BY ai.quantidade
    `, [empresaId]),

    // Usuários
    query(`
      SELECT
        COUNT(*) FILTER (WHERE u.ativo = true) as atual,
        COALESCE(p.max_usuarios, 0) as limite_plano
      FROM usuarios u
      CROSS JOIN LATERAL (
        SELECT p.max_usuarios
        FROM empresas e
        JOIN planos p ON p.id = e.plano_id
        WHERE e.id = $1
        LIMIT 1
      ) p
      WHERE u.empresa_id = $1
      GROUP BY p.max_usuarios
    `, [empresaId]),

    // Tools
    query(`
      SELECT
        COUNT(*) FILTER (WHERE t.ativo = true) as atual,
        COALESCE(p.max_tools, 0) as limite_plano
      FROM tools t
      CROSS JOIN LATERAL (
        SELECT p.max_tools
        FROM empresas e
        JOIN planos p ON p.id = e.plano_id
        WHERE e.id = $1
        LIMIT 1
      ) p
      WHERE t.empresa_id = $1
      GROUP BY p.max_tools
    `, [empresaId]),

    // Mensagens do mês
    query(`
      SELECT
        COALESCE(um.total_mensagens, 0) as usado,
        COALESCE(p.max_mensagens_mes, 0) as limite_plano
      FROM empresas e
      LEFT JOIN planos p ON p.id = e.plano_id
      LEFT JOIN uso_mensal um ON um.empresa_id = e.id AND um.ano_mes = $2
      WHERE e.id = $1
    `, [empresaId, new Date().toISOString().slice(0, 7)])
  ]);

  return {
    agentes_ia: {
      usado: parseInt(agentes.rows[0]?.atual || 0),
      contratado: parseInt(agentes.rows[0]?.contratado || 0),
      percentual: agentes.rows[0]?.contratado > 0
        ? Math.round((agentes.rows[0].atual / agentes.rows[0].contratado) * 100)
        : 0
    },
    numeros_whatsapp: {
      usado: parseInt(numeros.rows[0]?.atual || 0),
      contratado: parseInt(numeros.rows[0]?.contratado || 0),
      percentual: numeros.rows[0]?.contratado > 0
        ? Math.round((numeros.rows[0].atual / numeros.rows[0].contratado) * 100)
        : 0
    },
    usuarios: {
      usado: parseInt(usuarios.rows[0]?.atual || 0),
      limite: parseInt(usuarios.rows[0]?.limite_plano || 0),
      percentual: usuarios.rows[0]?.limite_plano > 0
        ? Math.round((usuarios.rows[0].atual / usuarios.rows[0].limite_plano) * 100)
        : 0
    },
    tools: {
      usado: parseInt(tools.rows[0]?.atual || 0),
      limite: parseInt(tools.rows[0]?.limite_plano || 0),
      percentual: tools.rows[0]?.limite_plano > 0
        ? Math.round((tools.rows[0].atual / tools.rows[0].limite_plano) * 100)
        : 0
    },
    mensagens_mes: {
      usado: parseInt(mensagens.rows[0]?.usado || 0),
      limite: parseInt(mensagens.rows[0]?.limite_plano || 0),
      percentual: mensagens.rows[0]?.limite_plano > 0
        ? Math.round((mensagens.rows[0].usado / mensagens.rows[0].limite_plano) * 100)
        : 0
    }
  };
}