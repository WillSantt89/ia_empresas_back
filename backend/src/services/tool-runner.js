import fetch from 'node-fetch';
import { logger } from '../config/logger.js';
import { DEFAULT_LIMITS } from '../config/constants.js';
import { pool } from '../config/database.js';
import { validarValorCampo } from '../routes/campos-personalizados.js';
import { emitConversaAtualizada, emitNovaConversaNaFila, emitFilaStats, emitToEmpresa } from './websocket.js';
import { calcularStatsFila } from './fila-manager.js';

/**
 * Tool Runner Service
 * Executes HTTP requests and internal tools for AI agents
 */

const createLogger = logger.child({ module: 'tool-runner' });

/**
 * Execute a tool by making an HTTP request
 * @param {Object} tool - Tool configuration from database
 * @param {Object} args - Arguments provided by the LLM
 * @returns {Promise<Object>} Tool execution result
 */
export async function executeTool(tool, args) {
  const startTime = Date.now();

  try {
    createLogger.debug('Executing tool', {
      tool_name: tool.nome,
      tool_url: tool.url,
      tool_method: tool.metodo,
      args
    });

    // Process body template
    let body = null;
    if (tool.body_template_json && Object.keys(tool.body_template_json).length > 0) {
      body = processTemplate(tool.body_template_json, args);
    } else if (args && Object.keys(args).length > 0) {
      body = args;
    }

    // Process headers
    const headers = {
      'Content-Type': 'application/json',
      ...tool.headers_json
    };

    // Process URL with args if needed (for GET requests with params)
    let url = tool.url;
    if (tool.metodo === 'GET' && args) {
      const queryParams = new URLSearchParams(args).toString();
      if (queryParams) {
        url += (url.includes('?') ? '&' : '?') + queryParams;
      }
    }

    // Configure request
    const requestOptions = {
      method: tool.metodo,
      headers,
      timeout: tool.timeout_ms || DEFAULT_LIMITS.TOOL_TIMEOUT_MS,
      ...(body && tool.metodo !== 'GET' ? { body: JSON.stringify(body) } : {})
    };

    // Create abort controller for timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
      controller.abort();
    }, requestOptions.timeout);

    try {
      // Make the request
      const response = await fetch(url, {
        ...requestOptions,
        signal: controller.signal
      });

      clearTimeout(timeoutId);

      const duration = Date.now() - startTime;

      // Get response body
      let responseBody;
      const contentType = response.headers.get('content-type');

      if (contentType && contentType.includes('application/json')) {
        responseBody = await response.json();
      } else {
        responseBody = await response.text();
      }

      // Check response status
      if (!response.ok) {
        createLogger.warn('Tool returned error status', {
          tool_name: tool.nome,
          status: response.status,
          statusText: response.statusText,
          duration_ms: duration,
          response: responseBody
        });

        return {
          success: false,
          error: 'Tool returned error',
          status: response.status,
          statusText: response.statusText,
          message: responseBody,
          duration_ms: duration
        };
      }

      createLogger.info('Tool executed successfully', {
        tool_name: tool.nome,
        status: response.status,
        duration_ms: duration
      });

      // Return successful response
      return {
        success: true,
        data: responseBody,
        status: response.status,
        duration_ms: duration
      };

    } catch (fetchError) {
      clearTimeout(timeoutId);

      if (fetchError.name === 'AbortError') {
        createLogger.error('Tool execution timeout', {
          tool_name: tool.nome,
          timeout_ms: requestOptions.timeout
        });

        return {
          success: false,
          error: 'Tool timeout',
          timeout: requestOptions.timeout,
          message: `Request timeout after ${requestOptions.timeout}ms`
        };
      }

      throw fetchError;
    }

  } catch (error) {
    const duration = Date.now() - startTime;

    createLogger.error('Tool execution failed', {
      tool_name: tool.nome,
      error: error.message,
      duration_ms: duration
    });

    return {
      success: false,
      error: 'Tool execution failed',
      message: error.message,
      duration_ms: duration
    };
  }
}

/**
 * Execute an internal transfer tool
 * Transfers to an agent (agente_destino_id) or directly to a queue (fila_destino_id)
 * @param {Object} tool - Tool configuration with agente_destino_id OR fila_destino_id
 * @param {Object} context - { conversa_id, empresa_id }
 * @returns {Promise<Object>} Transfer result
 */
export async function executeTransferTool(tool, context) {
  const startTime = Date.now();
  const { conversa_id, empresa_id } = context;

  try {
    // --- Transfer to queue (no agent) ---
    if (tool.fila_destino_id) {
      const filaResult = await pool.query(`
        SELECT id, nome, ativo FROM filas_atendimento
        WHERE id = $1 AND empresa_id = $2
      `, [tool.fila_destino_id, empresa_id]);

      if (filaResult.rows.length === 0) {
        return { success: false, error: 'Fila destino não encontrada' };
      }

      const fila = filaResult.rows[0];

      if (!fila.ativo) {
        return { success: false, error: `Fila "${fila.nome}" está inativa` };
      }

      // Buscar fila de origem ANTES de atualizar
      const origemResult = await pool.query(
        `SELECT fila_id FROM conversas WHERE id = $1 AND empresa_id = $2`,
        [conversa_id, empresa_id]
      );
      const filaOrigemId = origemResult.rows[0]?.fila_id;

      await pool.query(`
        UPDATE conversas
        SET agente_id = NULL,
            fila_id = $1,
            controlado_por = 'fila',
            atualizado_em = NOW()
        WHERE id = $2 AND empresa_id = $3
      `, [fila.id, conversa_id, empresa_id]);

      // Registrar no histórico
      await pool.query(`
        UPDATE conversas
        SET historico_agentes_json = COALESCE(historico_agentes_json, '[]'::jsonb) || $1::jsonb
        WHERE id = $2
      `, [
        JSON.stringify([{
          agente_id: null,
          agente_nome: null,
          fila_id: fila.id,
          fila_nome: fila.nome,
          tipo: 'fila',
          transferido_em: new Date().toISOString()
        }]),
        conversa_id
      ]);

      const duration = Date.now() - startTime;

      createLogger.info({ conversa_id, empresa_id, fila_origem: filaOrigemId, fila_destino: fila.nome, duration_ms: duration }, 'Transfer to queue executed');

      // Buscar dados da conversa para emitir WebSocket
      const conversaData = await pool.query(
        `SELECT id, contato_whatsapp, contato_nome, status, controlado_por, fila_id, numero_ticket, criado_em
         FROM conversas WHERE id = $1`, [conversa_id]
      );
      const conv = conversaData.rows[0];

      if (conv) {
        // Emitir conversa atualizada para fila destino E fila origem
        const updateData = {
          id: conversa_id,
          fila_id: fila.id,
          controlado_por: 'fila',
          agente_id: null,
        };
        emitConversaAtualizada(conversa_id, fila.id, updateData);
        if (filaOrigemId && filaOrigemId !== fila.id) {
          emitConversaAtualizada(conversa_id, filaOrigemId, updateData);
        }

        // Emitir nova conversa na fila destino
        emitNovaConversaNaFila(fila.id, {
          id: conv.id,
          contato_whatsapp: conv.contato_whatsapp,
          contato_nome: conv.contato_nome,
          status: conv.status,
          controlado_por: 'fila',
          fila_id: fila.id,
          numero_ticket: conv.numero_ticket,
          criado_em: conv.criado_em,
        });

        // Atualizar stats da fila destino E origem
        calcularStatsFila(fila.id).then(stats => emitFilaStats(fila.id, stats)).catch(() => {});
        if (filaOrigemId && filaOrigemId !== fila.id) {
          calcularStatsFila(filaOrigemId).then(stats => emitFilaStats(filaOrigemId, stats)).catch(() => {});
        }

        // Emitir para TODA a empresa — garante que todos os operadores vejam a atualização
        emitToEmpresa(empresa_id, 'fila:stats-updated', { fila_destino: fila.id, fila_origem: filaOrigemId });
      }

      return {
        success: true,
        data: {
          transferido_para: fila.nome,
          fila: fila.nome,
          tipo: 'fila',
          mensagem: `Atendimento transferido para a fila ${fila.nome}. Um atendente humano irá continuar o atendimento.`
        },
        duration_ms: duration
      };
    }

    // --- Transfer to agent ---
    if (!tool.agente_destino_id) {
      return { success: false, error: 'Tool de transferência sem destino configurado' };
    }

    // Buscar fila de origem ANTES de atualizar
    const origemAgResult = await pool.query(
      `SELECT fila_id FROM conversas WHERE id = $1 AND empresa_id = $2`,
      [conversa_id, empresa_id]
    );
    const filaOrigemAgId = origemAgResult.rows[0]?.fila_id;

    // Buscar agente destino com sua fila
    const agenteResult = await pool.query(`
      SELECT a.id, a.nome, a.fila_id, a.ativo, f.nome as fila_nome
      FROM agentes a
      LEFT JOIN filas_atendimento f ON f.id = a.fila_id
      WHERE a.id = $1 AND a.empresa_id = $2
    `, [tool.agente_destino_id, empresa_id]);

    if (agenteResult.rows.length === 0) {
      return { success: false, error: 'Agente destino não encontrado' };
    }

    const destino = agenteResult.rows[0];

    if (!destino.ativo) {
      return { success: false, error: `Agente "${destino.nome}" está inativo` };
    }

    // Atualizar conversa: agente + fila (operação casada)
    await pool.query(`
      UPDATE conversas
      SET agente_id = $1,
          fila_id = $2,
          controlado_por = 'ia',
          atualizado_em = NOW()
      WHERE id = $3 AND empresa_id = $4
    `, [destino.id, destino.fila_id, conversa_id, empresa_id]);

    // Registrar no histórico de agentes da conversa
    await pool.query(`
      UPDATE conversas
      SET historico_agentes_json = COALESCE(historico_agentes_json, '[]'::jsonb) || $1::jsonb
      WHERE id = $2
    `, [
      JSON.stringify([{
        agente_id: destino.id,
        agente_nome: destino.nome,
        fila_id: destino.fila_id,
        fila_nome: destino.fila_nome,
        transferido_em: new Date().toISOString()
      }]),
      conversa_id
    ]);

    const duration = Date.now() - startTime;

    createLogger.info({ conversa_id, empresa_id, agente_destino: destino.nome, fila_origem: filaOrigemAgId, fila_destino: destino.fila_nome, duration_ms: duration }, 'Transfer tool executed');

    // Emitir WebSocket: conversa atualizada na fila destino
    const agUpdateData = {
      id: conversa_id,
      fila_id: destino.fila_id,
      controlado_por: 'ia',
      agente_id: destino.id,
      agente_nome: destino.nome,
    };
    emitConversaAtualizada(conversa_id, destino.fila_id, agUpdateData);
    if (filaOrigemAgId && filaOrigemAgId !== destino.fila_id) {
      emitConversaAtualizada(conversa_id, filaOrigemAgId, agUpdateData);
    }

    if (destino.fila_id) {
      calcularStatsFila(destino.fila_id).then(stats => emitFilaStats(destino.fila_id, stats)).catch(() => {});
    }
    if (filaOrigemAgId && filaOrigemAgId !== destino.fila_id) {
      calcularStatsFila(filaOrigemAgId).then(stats => emitFilaStats(filaOrigemAgId, stats)).catch(() => {});
    }

    // Emitir para TODA a empresa
    emitToEmpresa(empresa_id, 'fila:stats-updated', { fila_destino: destino.fila_id, fila_origem: filaOrigemAgId });

    return {
      success: true,
      data: {
        transferido_para: destino.nome,
        fila: destino.fila_nome,
        mensagem: `Atendimento transferido para ${destino.nome}`
      },
      duration_ms: duration
    };

  } catch (error) {
    const duration = Date.now() - startTime;
    createLogger.error({ err: error, conversa_id, empresa_id, agente_destino_id: tool.agente_destino_id, fila_destino_id: tool.fila_destino_id, duration_ms: duration }, 'Transfer tool failed');

    return {
      success: false,
      error: 'Falha na transferência',
      message: error.message,
      duration_ms: duration
    };
  }
}

/**
 * Execute an attribute tool — saves contact or conversation attributes
 * Called by the AI during function calling loop
 * @param {Object} context - { conversa_id, empresa_id, contato_id, tipo_atributo: 'contato'|'atendimento' }
 * @param {Object} args - Key-value pairs from the LLM
 * @returns {Promise<Object>} Result
 */
export async function executeAtributoTool(context, args) {
  const startTime = Date.now();
  const { conversa_id, empresa_id, contato_id, tipo_atributo } = context;

  try {
    if (!args || Object.keys(args).length === 0) {
      return { success: false, error: 'Nenhum atributo fornecido' };
    }

    // Buscar campos definidos
    const camposResult = await pool.query(
      `SELECT * FROM campos_personalizados WHERE empresa_id = $1 AND contexto = $2 AND ativo = true`,
      [empresa_id, tipo_atributo]
    );
    const camposMap = {};
    for (const c of camposResult.rows) {
      camposMap[c.chave] = c;
    }

    const salvos = {};
    const erros = [];

    if (tipo_atributo === 'contato' && contato_id) {
      // Buscar dados atuais do contato
      const contato = await pool.query(
        `SELECT dados_json FROM contatos WHERE id = $1 AND empresa_id = $2`,
        [contato_id, empresa_id]
      );
      if (contato.rows.length === 0) {
        return { success: false, error: 'Contato nao encontrado' };
      }

      const dadosAtuais = contato.rows[0].dados_json || {};

      for (const [chave, valor] of Object.entries(args)) {
        const campo = camposMap[chave];
        if (campo) {
          const validacao = validarValorCampo(campo, valor);
          if (validacao.valido) {
            dadosAtuais[chave] = validacao.valor;
            salvos[chave] = validacao.valor;
          } else {
            erros.push(validacao.erro);
          }
        } else {
          // Campo não definido pelo admin — salva como legado
          dadosAtuais[chave] = String(valor);
          salvos[chave] = String(valor);
        }
      }

      await pool.query(
        `UPDATE contatos SET dados_json = $1, atualizado_em = NOW() WHERE id = $2`,
        [JSON.stringify(dadosAtuais), contato_id]
      );
    } else if (tipo_atributo === 'atendimento') {
      // Buscar dados atuais da conversa
      const conv = await pool.query(
        `SELECT dados_json FROM conversas WHERE id = $1 AND empresa_id = $2`,
        [conversa_id, empresa_id]
      );
      if (conv.rows.length === 0) {
        return { success: false, error: 'Conversa nao encontrada' };
      }

      const dadosAtuais = conv.rows[0].dados_json || {};

      for (const [chave, valor] of Object.entries(args)) {
        const campo = camposMap[chave];
        if (campo) {
          const validacao = validarValorCampo(campo, valor);
          if (validacao.valido) {
            dadosAtuais[chave] = validacao.valor;
            salvos[chave] = validacao.valor;
          } else {
            erros.push(validacao.erro);
          }
        } else {
          dadosAtuais[chave] = String(valor);
          salvos[chave] = String(valor);
        }
      }

      await pool.query(
        `UPDATE conversas SET dados_json = $1, atualizado_em = NOW() WHERE id = $2`,
        [JSON.stringify(dadosAtuais), conversa_id]
      );
    } else {
      return { success: false, error: `Tipo de atributo invalido ou contato nao vinculado` };
    }

    const duration = Date.now() - startTime;

    createLogger.info('Attribute tool executed', {
      conversa_id, empresa_id, contato_id,
      tipo_atributo,
      campos_salvos: Object.keys(salvos),
      duration_ms: duration,
    });

    return {
      success: true,
      data: {
        salvos,
        erros: erros.length > 0 ? erros : undefined,
        mensagem: `Atributos salvos: ${Object.entries(salvos).map(([k, v]) => `${k}=${v}`).join(', ')}`,
      },
      duration_ms: duration,
    };
  } catch (error) {
    const duration = Date.now() - startTime;
    createLogger.error('Attribute tool failed', {
      conversa_id, empresa_id, tipo_atributo,
      error: error.message, duration_ms: duration,
    });
    return { success: false, error: error.message, duration_ms: duration };
  }
}

/**
 * Process template with variable substitution
 * @param {Object} template - Template object with {{variable}} placeholders
 * @param {Object} args - Arguments to substitute
 * @returns {Object} Processed template
 */
function processTemplate(template, args) {
  if (!template || typeof template !== 'object') {
    return template;
  }

  if (!args || typeof args !== 'object') {
    return template;
  }

  // Deep clone the template
  const result = JSON.parse(JSON.stringify(template));

  // Recursive function to replace variables
  function replaceVariables(obj) {
    for (const key in obj) {
      if (typeof obj[key] === 'string') {
        // Replace {{variable}} patterns
        obj[key] = obj[key].replace(/\{\{(\w+)\}\}/g, (match, varName) => {
          return args[varName] !== undefined ? args[varName] : match;
        });
      } else if (typeof obj[key] === 'object' && obj[key] !== null) {
        replaceVariables(obj[key]);
      }
    }
  }

  replaceVariables(result);
  return result;
}

/**
 * Build tool declarations for Gemini API
 * @param {Array} tools - Array of tools from database
 * @returns {Array} Gemini-formatted function declarations
 */
export function buildToolDeclarations(tools) {
  return tools.map(tool => ({
    name: tool.nome,
    description: tool.descricao_para_llm,
    parameters: tool.parametros_schema_json || {
      type: 'object',
      properties: {},
      required: []
    }
  }));
}

/**
 * Validate tool configuration
 * @param {Object} tool - Tool object to validate
 * @returns {Object} Validation result
 */
export function validateTool(tool) {
  const errors = [];

  // Required fields
  if (!tool.nome) {
    errors.push('Tool name is required');
  }

  // Transfer tools don't need url/metodo
  const isTransfer = tool.tipo_tool === 'transferencia';

  if (!isTransfer) {
    if (!tool.url) {
      errors.push('Tool URL is required');
    } else {
      try {
        new URL(tool.url);
      } catch {
        errors.push('Tool URL is invalid');
      }
    }

    if (!tool.metodo) {
      errors.push('Tool method is required');
    } else if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(tool.metodo)) {
      errors.push('Tool method must be GET, POST, PUT, PATCH, or DELETE');
    }
  } else {
    if (!tool.agente_destino_id && !tool.fila_destino_id) {
      errors.push('Transfer tool requires agente_destino_id or fila_destino_id');
    }
  }

  if (!tool.descricao_para_llm) {
    errors.push('Tool description for LLM is required');
  }

  // Validate JSON fields
  if (tool.headers_json && typeof tool.headers_json !== 'object') {
    errors.push('Headers must be a valid JSON object');
  }

  if (tool.body_template_json && typeof tool.body_template_json !== 'object') {
    errors.push('Body template must be a valid JSON object');
  }

  if (!tool.parametros_schema_json || typeof tool.parametros_schema_json !== 'object') {
    errors.push('Parameters schema must be a valid JSON Schema object');
  } else {
    // Basic JSON Schema validation
    if (tool.parametros_schema_json.type !== 'object') {
      errors.push('Parameters schema must have type "object"');
    }
    if (!tool.parametros_schema_json.properties) {
      errors.push('Parameters schema must have properties defined');
    }
  }

  return {
    valid: errors.length === 0,
    errors
  };
}

/**
 * Test tool execution with sample data
 * @param {Object} tool - Tool configuration
 * @param {Object} testArgs - Test arguments
 * @returns {Promise<Object>} Test result
 */
export async function testTool(tool, testArgs = {}) {
  createLogger.info('Testing tool', {
    tool_name: tool.nome,
    test_args: testArgs
  });

  try {
    // Validate tool first
    const validation = validateTool(tool);
    if (!validation.valid) {
      return {
        success: false,
        error: 'Tool validation failed',
        validation_errors: validation.errors
      };
    }

    // Execute the tool
    const result = await executeTool(tool, testArgs);

    createLogger.info('Tool test completed', {
      tool_name: tool.nome,
      success: result.success,
      duration_ms: result.duration_ms
    });

    return {
      success: result.success,
      test_result: result,
      test_args: testArgs
    };

  } catch (error) {
    createLogger.error('Tool test failed', {
      tool_name: tool.nome,
      error: error.message
    });

    return {
      success: false,
      error: 'Tool test failed',
      message: error.message,
      test_args: testArgs
    };
  }
}

/**
 * Execute multiple tools in parallel
 * @param {Array} toolExecutions - Array of {tool, args} objects
 * @returns {Promise<Array>} Array of results
 */
export async function executeToolsParallel(toolExecutions) {
  const promises = toolExecutions.map(({ tool, args }) =>
    executeTool(tool, args).catch(error => ({
      success: false,
      error: 'Tool execution failed',
      message: error.message,
      tool_name: tool.nome
    }))
  );

  return Promise.all(promises);
}

/**
 * Transform tool result for LLM consumption
 * @param {Object} result - Tool execution result
 * @param {number} maxLength - Maximum length for result (to avoid token limits)
 * @returns {Object} Transformed result
 */
export function transformResultForLLM(result, maxLength = 1000) {
  if (!result) {
    return { error: 'No result' };
  }

  // If error, return simplified error
  if (!result.success) {
    return {
      error: result.error || 'Tool execution failed',
      message: result.message || 'Unknown error'
    };
  }

  // For successful results, potentially truncate if too long
  let data = result.data;

  // Convert to string if needed for length check
  const dataStr = typeof data === 'string' ? data : JSON.stringify(data);

  if (dataStr.length > maxLength) {
    // Truncate and add indicator
    if (typeof data === 'string') {
      data = data.substring(0, maxLength) + '... [truncated]';
    } else {
      // For objects, try to summarize
      data = {
        _truncated: true,
        _original_length: dataStr.length,
        _preview: JSON.stringify(data).substring(0, maxLength) + '...'
      };
    }
  }

  return {
    success: true,
    data
  };
}