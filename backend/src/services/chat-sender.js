import { pool } from '../config/database.js';
import { logger } from '../config/logger.js';
import { addToHistory } from './memory.js';
import { decrypt } from '../config/encryption.js';
import { emitNovaMensagem } from './websocket.js';
import { sendTextMessage } from './whatsapp-sender.js';

/**
 * Envia mensagem do operador para o cliente via WhatsApp (envio direto Meta API)
 *
 * @param {string} conversaId
 * @param {string} conteudo
 * @param {{id: string, nome: string}} operador
 * @param {{replyToMessageId?: string}} [opts] - replyToMessageId: id local da mensagem
 *   sendo respondida (cria reply/quote no WhatsApp)
 */
export async function enviarMensagemWhatsApp(conversaId, conteudo, operador, opts = {}) {
  const { replyToMessageId = null } = opts;
  // 1. Buscar conversa + empresa
  const conversaResult = await pool.query(
    `SELECT c.*, c.conexao_ativa_id, e.n8n_response_url, e.webhook_token
     FROM conversas c
     JOIN empresas e ON c.empresa_id = e.id
     WHERE c.id = $1`,
    [conversaId]
  );

  if (conversaResult.rows.length === 0) {
    throw new Error('Conversa nao encontrada');
  }

  const conversa = conversaResult.rows[0];

  if (!conversa.contato_whatsapp) {
    throw new Error('Conversa sem contato WhatsApp');
  }

  // 2. Buscar numero WhatsApp — conexao_ativa_id > whatsapp_number_id > fallback FIFO
  const wnIdEscolhido = conversa.conexao_ativa_id || conversa.whatsapp_number_id;
  const wnQuery = wnIdEscolhido
    ? `SELECT id, phone_number_id, token_graph_api FROM whatsapp_numbers WHERE id = $1 AND ativo = true`
    : `SELECT id, phone_number_id, token_graph_api FROM whatsapp_numbers WHERE empresa_id = $1 AND ativo = true ORDER BY criado_em ASC LIMIT 1`;
  const wnParam = wnIdEscolhido || conversa.empresa_id;
  const whatsappResult = await pool.query(wnQuery, [wnParam]);

  if (whatsappResult.rows.length === 0) {
    throw new Error('Nenhum numero WhatsApp ativo encontrado');
  }

  const whatsappNumber = whatsappResult.rows[0];
  const token = decrypt(whatsappNumber.token_graph_api);

  if (!token) {
    throw new Error('Token WhatsApp invalido ou nao configurado');
  }

  // 3a. Resolver mensagem sendo respondida (reply/quote) — opcional
  let replyToWamid = null;
  if (replyToMessageId) {
    const replyResult = await pool.query(
      `SELECT whatsapp_message_id FROM mensagens_log
       WHERE id = $1 AND conversa_id = $2 AND empresa_id = $3`,
      [replyToMessageId, conversaId, conversa.empresa_id]
    );
    if (replyResult.rows.length > 0 && replyResult.rows[0].whatsapp_message_id) {
      replyToWamid = replyResult.rows[0].whatsapp_message_id;
    }
    // Se nao achou ou nao tem wamid, ignoramos silenciosamente: a mensagem ainda
    // sera enviada, so sem o context/reply.
  }

  // 3b. Salvar em mensagens_log (com whatsapp_number_id da conexão usada)
  const msgResult = await pool.query(
    `INSERT INTO mensagens_log
       (conversa_id, empresa_id, direcao, conteudo, remetente_tipo, remetente_id, remetente_nome, status_entrega, whatsapp_number_id, reply_to_message_id, reply_to_wamid)
     VALUES ($1, $2, 'saida', $3, 'operador', $4, $5, 'sending', $6, $7, $8)
     RETURNING *`,
    [conversaId, conversa.empresa_id, conteudo, operador.id, operador.nome, whatsappNumber.id || null, replyToMessageId || null, replyToWamid]
  );

  const mensagem = msgResult.rows[0];

  // 4. Adicionar ao historico Redis
  const conversationKey = `whatsapp:${conversa.contato_whatsapp}`;
  try {
    await addToHistory(conversa.empresa_id, conversationKey, 'model', conteudo);
  } catch (error) {
    logger.warn('Erro ao adicionar msg do operador ao Redis:', error.message);
  }

  // 5. Atualizar ultima_mensagem da conversa
  await pool.query(
    `UPDATE conversas SET atualizado_em = NOW() WHERE id = $1`,
    [conversaId]
  );

  // 6. Enviar diretamente via Meta Graph API
  try {
    const result = await sendTextMessage(
      whatsappNumber.phone_number_id,
      token,
      conversa.contato_whatsapp,
      conteudo,
      replyToWamid
    );

    if (result.success) {
      await pool.query(
        `UPDATE mensagens_log SET status_entrega = 'sent', whatsapp_message_id = $1 WHERE id = $2`,
        [result.wamid, mensagem.id]
      );
      mensagem.status_entrega = 'sent';
      mensagem.whatsapp_message_id = result.wamid;
    } else {
      logger.warn(`Meta API falhou para conversa ${conversaId}: ${result.error}`);
      await pool.query(
        `UPDATE mensagens_log SET status_entrega = 'failed', erro = $1 WHERE id = $2`,
        [result.error, mensagem.id]
      );
      mensagem.status_entrega = 'failed';
    }
  } catch (error) {
    logger.error(`Erro enviando msg via Meta API:`, error.message);
    await pool.query(
      `UPDATE mensagens_log SET status_entrega = 'failed', erro = $1 WHERE id = $2`,
      [error.message, mensagem.id]
    );
    mensagem.status_entrega = 'failed';
    mensagem.erro = error.message;
  }

  // 7. Emitir WebSocket
  emitNovaMensagem(conversaId, conversa.fila_id, {
    id: mensagem.id,
    conversa_id: conversaId,
    conteudo,
    direcao: 'saida',
    remetente_tipo: 'operador',
    remetente_id: operador.id,
    remetente_nome: operador.nome,
    status_entrega: mensagem.status_entrega,
    criado_em: mensagem.criado_em,
    reply_to_message_id: mensagem.reply_to_message_id || null,
  });

  return mensagem;
}
