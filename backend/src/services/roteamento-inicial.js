/**
 * Roteamento Inteligente
 *
 * Aplica regras de roteamento por palavra-chave APENAS na primeira mensagem
 * de uma nova conversa. Se uma regra ativa der match, retorna a fila destino
 * (e opcionalmente uma resposta automatica), bypassando chatbot e IA.
 *
 * Regras sao avaliadas em ordem (campo `ordem` ASC). Primeira que bater vence.
 */
import { logger } from '../config/logger.js';
import { pool } from '../config/database.js';

const createLogger = logger.child({ module: 'roteamento-inicial' });

/**
 * Normaliza texto pra comparacao: lowercase + remove acentos + colapsa espacos.
 */
function normalize(text) {
  if (!text) return '';
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // remove acentos
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Verifica se a primeira mensagem de uma nova conversa bate em alguma regra
 * de roteamento ativa para a empresa.
 *
 * @param {string} empresa_id
 * @param {string} texto - conteudo da primeira mensagem do cliente
 * @returns {Promise<{regra_id: string, regra_nome: string, fila_id: string, resposta_automatica: string|null} | null>}
 */
export async function matchRegraRoteamento(empresa_id, texto) {
  if (!texto || typeof texto !== 'string') return null;

  try {
    const result = await pool.query(`
      SELECT id, nome, palavras_chave, modo_match, fila_id, resposta_automatica
      FROM regras_roteamento_inicial
      WHERE empresa_id = $1 AND ativo = true
      ORDER BY ordem ASC, criado_em ASC
    `, [empresa_id]);

    if (result.rows.length === 0) return null;

    const textoNorm = normalize(texto);

    for (const regra of result.rows) {
      const palavras = (regra.palavras_chave || []).map(normalize).filter(Boolean);
      if (palavras.length === 0) continue;

      let bateu = false;
      if (regra.modo_match === 'exact') {
        // Exact: a mensagem inteira (normalizada) deve ser igual a uma das palavras
        bateu = palavras.includes(textoNorm);
      } else {
        // Contains (default): basta que o texto contenha qualquer uma das palavras
        bateu = palavras.some(p => textoNorm.includes(p));
      }

      if (bateu) {
        createLogger.info({
          empresa_id, regra: regra.nome, fila_id: regra.fila_id,
          modo: regra.modo_match, texto_preview: texto.substring(0, 80),
        }, 'Regra de roteamento inteligente bateu');

        return {
          regra_id: regra.id,
          regra_nome: regra.nome,
          fila_id: regra.fila_id,
          resposta_automatica: regra.resposta_automatica || null,
        };
      }
    }

    return null;
  } catch (err) {
    createLogger.error({ err, empresa_id }, 'Erro ao avaliar regras de roteamento');
    return null;
  }
}
