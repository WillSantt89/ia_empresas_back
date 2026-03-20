/**
 * Flow Engine — Motor de fluxo estruturado para chatbot
 *
 * Avalia input do cliente contra o nó atual do fluxo,
 * avança estado, e retorna resposta sem chamar IA.
 * Se o input não bate, retorna fallback para IA processar.
 */

import { redis } from '../config/redis.js';
import { logger } from '../config/logger.js';

const createLogger = logger.child({ module: 'flow-engine' });

const FLOW_TTL = 86400; // 24h
const LOCK_TTL = 10; // 10s lock para evitar race condition

// --- Validações de input ---
const VALIDATORS = {
  cpf: (text) => {
    const digits = text.replace(/\D/g, '');
    return digits.length === 11 ? digits : null;
  },
  email: (text) => {
    const match = text.trim().match(/^[^\s@]+@[^\s@]+\.[^\s@]+$/);
    return match ? text.trim().toLowerCase() : null;
  },
  phone: (text) => {
    const digits = text.replace(/\D/g, '');
    return (digits.length >= 10 && digits.length <= 13) ? digits : null;
  },
  date: (text) => {
    const match = text.trim().match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
    return match ? text.trim() : null;
  },
  number: (text) => {
    const num = text.trim().replace(/[.,]/g, '');
    return /^\d+$/.test(num) ? num : null;
  },
  any: (text) => text.trim() || null,
};

/**
 * Gera a chave Redis para o estado do fluxo
 */
function flowKey(empresaId, phone) {
  return `chatbot:${empresaId}:${phone}`;
}

/**
 * Adquire lock para evitar race condition entre workers
 */
async function acquireLock(empresaId, phone) {
  const lockKey = `lock:chatbot:${empresaId}:${phone}`;
  const result = await redis.set(lockKey, '1', 'EX', LOCK_TTL, 'NX');
  return result === 'OK';
}

async function releaseLock(empresaId, phone) {
  const lockKey = `lock:chatbot:${empresaId}:${phone}`;
  await redis.del(lockKey);
}

/**
 * Busca o estado atual do fluxo no Redis
 * @returns {object|null} { fluxo_id, node_atual, variables, started_at }
 */
export async function getFlowState(empresaId, phone) {
  try {
    const data = await redis.get(flowKey(empresaId, phone));
    return data ? JSON.parse(data) : null;
  } catch {
    return null;
  }
}

/**
 * Salva o estado do fluxo no Redis
 */
async function saveFlowState(empresaId, phone, state) {
  await redis.set(flowKey(empresaId, phone), JSON.stringify(state), 'EX', FLOW_TTL);
}

/**
 * Remove o estado do fluxo (finaliza)
 */
export async function clearFlowState(empresaId, phone) {
  await redis.del(flowKey(empresaId, phone));
}

/**
 * Substitui variáveis {{var}} no texto
 */
function interpolate(text, variables) {
  return text.replace(/\{\{(\w+)\}\}/g, (_, key) => variables[key] || `{{${key}}}`);
}

/**
 * Processa um nó do fluxo e retorna a resposta
 * @returns {object} { handled, response, action, variables, context }
 *   handled=true: fluxo respondeu, não chamar IA
 *   handled=false: fallback para IA (com context para o prompt)
 */
export async function processFlowNode(fluxoJson, state, userInput) {
  const { nodes, start_node } = fluxoJson;
  if (!nodes) return { handled: false };

  const nodeId = state.node_atual || start_node;
  const node = nodes[nodeId];

  if (!node) {
    createLogger.warn({ nodeId }, 'Flow node not found');
    return { handled: false };
  }

  const variables = { ...state.variables };
  const inputText = (userInput || '').trim();
  const inputLower = inputText.toLowerCase();

  // --- Nó tipo message: só envia mensagens e avança ---
  if (node.type === 'message') {
    const messages = (node.messages || []).map(m => interpolate(m, variables));
    const nextNode = node.next;

    if (nextNode && nodes[nextNode]) {
      // Se o próximo nó também é message ou action, processar em cadeia
      const nextResult = await processNodeChain(nodes, nextNode, variables);
      return {
        handled: true,
        response: [...messages, ...nextResult.messages].join('\n\n'),
        nextNode: nextResult.finalNode,
        variables: nextResult.variables,
      };
    }

    return { handled: true, response: messages.join('\n\n'), nextNode, variables };
  }

  // --- Nó tipo input_options: verifica se input bate com opção ---
  if (node.type === 'input_options') {
    const options = node.options || [];

    // Tenta match por valor ou label
    const matched = options.find(opt => {
      const val = String(opt.value).toLowerCase();
      const label = (opt.label || '').toLowerCase();
      return inputLower === val || inputLower === label
        || inputText === String(opt.value)
        || label.startsWith(inputLower)
        // Match "1" contra "1 - Consignado"
        || label.match(new RegExp(`^${inputLower.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*[-–]`));
    });

    if (matched) {
      if (node.variable) {
        variables[node.variable] = matched.value;
      }
      const nextNode = matched.next || node.next;

      // Processar cadeia de nós automáticos
      if (nextNode && nodes[nextNode]) {
        const nextResult = await processNodeChain(nodes, nextNode, variables);
        return {
          handled: true,
          response: nextResult.messages.length > 0 ? nextResult.messages.join('\n\n') : null,
          nextNode: nextResult.finalNode,
          variables: nextResult.variables,
        };
      }

      return { handled: true, response: null, nextNode, variables };
    }

    // Não bateu — fallback
    if (node.fallback === 'ai') {
      const optionsList = options.map(o => o.label || o.value).join(', ');
      return {
        handled: false,
        context: `O cliente está no passo "${node.title || nodeId}" do fluxo. As opções válidas são: ${optionsList}. O cliente escreveu: "${inputText}". Responda a dúvida do cliente de forma breve e peça para ele escolher uma das opções válidas.`,
      };
    }

    // Repetir opções
    const messages = (node.messages || []).map(m => interpolate(m, variables));
    return { handled: true, response: messages.join('\n\n'), nextNode: nodeId, variables };
  }

  // --- Nó tipo input_text: valida e salva ---
  if (node.type === 'input_text') {
    const validator = VALIDATORS[node.validation || 'any'];
    const validated = validator ? validator(inputText) : inputText;

    if (validated) {
      if (node.variable) {
        variables[node.variable] = validated;
      }
      const nextNode = node.next;

      if (nextNode && nodes[nextNode]) {
        const nextResult = await processNodeChain(nodes, nextNode, variables);
        return {
          handled: true,
          response: nextResult.messages.length > 0 ? nextResult.messages.join('\n\n') : null,
          nextNode: nextResult.finalNode,
          variables: nextResult.variables,
        };
      }

      return { handled: true, response: null, nextNode, variables };
    }

    // Validação falhou
    if (node.fallback === 'ai') {
      return {
        handled: false,
        context: `O cliente está no passo "${node.title || nodeId}" do fluxo. Precisamos que ele informe um ${node.validation || 'texto'} válido. O cliente escreveu: "${inputText}". Responda de forma breve e peça o dado novamente no formato correto.`,
      };
    }

    const errorMsg = node.error_message || `Por favor, informe um ${node.validation || 'valor'} válido.`;
    return { handled: true, response: interpolate(errorMsg, variables), nextNode: nodeId, variables };
  }

  // --- Nó tipo input_confirm: sim/não ---
  if (node.type === 'input_confirm') {
    const yes = ['sim', 's', 'yes', 'y', '1', 'confirmo', 'correto', 'isso'].includes(inputLower);
    const no = ['nao', 'não', 'n', 'no', '2', 'errado', 'incorreto'].includes(inputLower);

    if (yes || no) {
      if (node.variable) {
        variables[node.variable] = yes ? 'sim' : 'nao';
      }
      const nextNode = yes ? (node.next_yes || node.next) : (node.next_no || node.next);

      if (nextNode && nodes[nextNode]) {
        const nextResult = await processNodeChain(nodes, nextNode, variables);
        return {
          handled: true,
          response: nextResult.messages.length > 0 ? nextResult.messages.join('\n\n') : null,
          nextNode: nextResult.finalNode,
          variables: nextResult.variables,
        };
      }

      return { handled: true, response: null, nextNode, variables };
    }

    if (node.fallback === 'ai') {
      return {
        handled: false,
        context: `O cliente está no passo "${node.title || nodeId}" do fluxo. Precisamos de uma confirmação (sim ou não). O cliente escreveu: "${inputText}". Responda de forma breve e peça para confirmar com sim ou não.`,
      };
    }

    return { handled: true, response: 'Por favor, responda com Sim ou Não.', nextNode: nodeId, variables };
  }

  // --- Nó tipo condition: desvio automático ---
  if (node.type === 'condition') {
    // Processar em cadeia
    const result = await processNodeChain(nodes, nodeId, variables);
    return {
      handled: true,
      response: result.messages.length > 0 ? result.messages.join('\n\n') : null,
      nextNode: result.finalNode,
      variables: result.variables,
    };
  }

  // --- Nó tipo assign_agent: passa para IA com variáveis ---
  if (node.type === 'assign_agent') {
    const varSummary = Object.entries(variables)
      .map(([k, v]) => `${k}: ${v}`)
      .join(', ');
    const assignMsg = node.message || null;
    return {
      handled: false,
      action: 'assign_agent',
      response: assignMsg ? interpolate(assignMsg, variables) : null,
      context: `O cliente completou o fluxo do chatbot e informou os seguintes dados: ${varSummary}. ${node.instruction || 'Continue o atendimento usando esses dados.'}`,
      variables,
      clearFlow: true,
    };
  }

  // --- Nó tipo transfer_queue: transfere para fila ---
  if (node.type === 'transfer_queue') {
    return {
      handled: true,
      action: 'transfer_queue',
      queueId: node.queue_id,
      response: node.message ? interpolate(node.message, variables) : null,
      variables,
      clearFlow: true,
    };
  }

  // --- Nó tipo end: finaliza ---
  if (node.type === 'end') {
    const msg = node.message ? interpolate(node.message, variables) : null;
    return {
      handled: true,
      action: 'end',
      response: msg,
      variables,
      clearFlow: true,
    };
  }

  // Tipo desconhecido — fallback IA
  return { handled: false };
}

/**
 * Processa cadeia de nós automáticos (message, condition) sem esperar input
 */
async function processNodeChain(nodes, startNodeId, variables, maxDepth = 10) {
  const messages = [];
  let currentId = startNodeId;
  let depth = 0;
  const vars = { ...variables };

  while (currentId && depth < maxDepth) {
    const node = nodes[currentId];
    if (!node) break;
    depth++;

    if (node.type === 'message') {
      const msgs = (node.messages || []).map(m => interpolate(m, vars));
      messages.push(...msgs);
      currentId = node.next;
      continue;
    }

    if (node.type === 'condition') {
      const varName = node.variable;
      const varValue = vars[varName];
      const conditions = node.conditions || [];
      let matched = false;

      for (const cond of conditions) {
        if (evaluateCondition(varValue, cond.operator, cond.value)) {
          currentId = cond.next;
          matched = true;
          break;
        }
      }

      if (!matched) {
        currentId = node.default || node.next;
      }
      continue;
    }

    // Nó que precisa de input — parar aqui
    if (['input_text', 'input_options', 'input_confirm'].includes(node.type)) {
      // Incluir mensagens do nó de input
      const msgs = (node.messages || []).map(m => interpolate(m, vars));
      messages.push(...msgs);
      break;
    }

    // assign_agent, transfer_queue, end — parar
    break;
  }

  return { messages, finalNode: currentId, variables: vars };
}

/**
 * Avalia condição para nó condition
 */
function evaluateCondition(value, operator, condValue) {
  const v = String(value || '').toLowerCase();
  const c = String(condValue || '').toLowerCase();

  switch (operator) {
    case 'equals': return v === c;
    case 'not_equals': return v !== c;
    case 'contains': return v.includes(c);
    case 'starts_with': return v.startsWith(c);
    case 'exists': return !!value;
    case 'not_exists': return !value;
    default: return v === c;
  }
}

/**
 * Inicia um fluxo para uma conversa
 */
export async function startFlow(empresaId, phone, fluxoId, fluxoJson) {
  // Lock para evitar race condition entre workers
  const locked = await acquireLock(empresaId, phone);
  if (!locked) {
    createLogger.warn({ empresaId, phone }, 'Flow start skipped — another worker processing');
    return null;
  }

  try {
    // Verificar se outro worker já iniciou o fluxo
    const existing = await getFlowState(empresaId, phone);
    if (existing) {
      createLogger.info({ empresaId, phone }, 'Flow already started by another worker');
      return null;
    }

    const startNode = fluxoJson.start_node;
    if (!startNode || !fluxoJson.nodes?.[startNode]) {
      createLogger.warn({ fluxoId }, 'Invalid flow: no start_node');
      return null;
    }

    const state = {
      fluxo_id: fluxoId,
      node_atual: startNode,
      variables: {},
      started_at: new Date().toISOString(),
    };

    await saveFlowState(empresaId, phone, state);

    // Processar cadeia inicial (mensagens de boas-vindas + primeiro input)
    const result = await processNodeChain(fluxoJson.nodes, startNode, {});

    // Atualizar estado com o nó final da cadeia
    state.node_atual = result.finalNode;
    state.variables = result.variables;
    await saveFlowState(empresaId, phone, state);

    return {
      response: result.messages.join('\n\n'),
      state,
    };
  } finally {
    await releaseLock(empresaId, phone);
  }
}

/**
 * Processa input do cliente no fluxo ativo
 */
export async function processFlowInput(empresaId, phone, fluxoJson, userInput) {
  const locked = await acquireLock(empresaId, phone);
  if (!locked) {
    createLogger.warn({ empresaId, phone }, 'Flow input skipped — another worker processing');
    return { handled: true, response: null }; // Silently skip duplicate
  }

  try {
    const state = await getFlowState(empresaId, phone);
    if (!state) return null;

    const result = await processFlowNode(fluxoJson, state, userInput);

    if (result.clearFlow) {
      await clearFlowState(empresaId, phone);
      createLogger.info({ empresaId, phone, action: result.action, variables: result.variables }, 'Flow completed');
    } else if (result.nextNode) {
      state.node_atual = result.nextNode;
      state.variables = result.variables || state.variables;
      await saveFlowState(empresaId, phone, state);
    }

    return result;
  } finally {
    await releaseLock(empresaId, phone);
  }
}
