/**
 * Automação de Entrada Service
 *
 * Consulta APIs externas quando uma NOVA conversa é criada.
 * Se a API retornar match=true, retorna os dados e o agente destino.
 * As automações são executadas sequencialmente por ordem de prioridade.
 */
import { logger } from '../config/logger.js';
import { pool } from '../config/database.js';

const createLogger = logger.child({ module: 'automacao-entrada' });

/**
 * Verifica se existe alguma automação de entrada ativa que dê match para o telefone.
 * Executa cada automação em ordem até encontrar um match ou esgotar todas.
 *
 * @param {string} empresa_id - ID da empresa
 * @param {string} phone - Telefone do cliente (formato WhatsApp, ex: 5511999999999)
 * @returns {Object|null} - { automacao_id, automacao_nome, agente_destino_id, dados } ou null
 */
export async function checkAutomacoesEntrada(empresa_id, phone) {
  try {
    const result = await pool.query(`
      SELECT ae.id, ae.nome, ae.url_api, ae.metodo, ae.headers_json, ae.agente_destino_id, ae.timeout_ms
      FROM automacoes_entrada ae
      WHERE ae.empresa_id = $1 AND ae.ativo = true
      ORDER BY ae.ordem ASC, ae.criado_em ASC
    `, [empresa_id]);

    if (result.rows.length === 0) return null;

    for (const auto of result.rows) {
      try {
        const headers = { 'Content-Type': 'application/json', ...(auto.headers_json || {}) };
        const bodyPayload = JSON.stringify({ telefone: phone, empresa_id });

        const fetchOptions = {
          method: auto.metodo || 'POST',
          headers,
          signal: AbortSignal.timeout(auto.timeout_ms || 5000),
        };

        if (auto.metodo !== 'GET') {
          fetchOptions.body = bodyPayload;
        }

        const startTime = Date.now();
        const response = await fetch(auto.url_api, fetchOptions);
        const latency = Date.now() - startTime;

        if (!response.ok) {
          createLogger.warn({ automacao: auto.nome, status: response.status, latency }, 'Automação API retornou erro HTTP');
          continue;
        }

        const rawData = await response.json();
        // Tolera resposta como objeto {match,dados} OU array [{match,dados}] (n8n costuma embrulhar em array)
        const data = Array.isArray(rawData) ? (rawData[0] || {}) : rawData;

        if (data.match === true) {
          createLogger.info({
            empresa_id, phone, automacao: auto.nome,
            agente_destino_id: auto.agente_destino_id, latency,
          }, 'Automação de entrada: MATCH encontrado');

          return {
            automacao_id: auto.id,
            automacao_nome: auto.nome,
            agente_destino_id: auto.agente_destino_id,
            dados: data.dados || {},
          };
        }

        createLogger.debug({ empresa_id, phone, automacao: auto.nome, latency }, 'Automação de entrada: sem match');
      } catch (err) {
        createLogger.warn({ automacao: auto.nome, error: err.message }, 'Automação de entrada falhou, tentando próxima');
        continue;
      }
    }

    return null;
  } catch (err) {
    createLogger.error({ err, empresa_id }, 'Erro ao verificar automações de entrada');
    return null;
  }
}
