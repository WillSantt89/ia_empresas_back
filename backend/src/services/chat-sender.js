import { pool } from '../config/database.js';
import { logger } from '../config/logger.js';
import { addToHistory } from './memory.js';
import { decrypt } from '../config/encryption.js';
import { emitNovaMensagem, emitStatusEntrega } from './websocket.js';

/**
 * Envia mensagem do operador para o cliente via WhatsApp (n8n Flow 2)
 */
export async function enviarMensagemWhatsApp(conversaId, conteudo, operador) {
  // 1. Buscar conversa + empresa + whatsapp_number
  const conversaResult = await pool.query(
    `SELECT c.*, e.n8n_response_url, e.webhook_token
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

  if (!conversa.n8n_response_url) {
    throw new Error('Empresa sem n8n_response_url configurada');
  }

  // 2. Buscar numero WhatsApp ativo para a empresa
  const whatsappResult = await pool.query(
    `SELECT phone_number_id, token_graph_api FROM whatsapp_numbers
     WHERE empresa_id = $1 AND ativo = true
     ORDER BY criado_em ASC LIMIT 1`,
    [conversa.empresa_id]
  );

  if (whatsappResult.rows.length === 0) {
    throw new Error('Nenhum numero WhatsApp ativo encontrado');
  }

  const whatsappNumber = whatsappResult.rows[0];
  const token = decrypt(whatsappNumber.token_graph_api);

  // 3. Salvar em mensagens_log
  const msgResult = await pool.query(
    `INSERT INTO mensagens_log
       (conversa_id, empresa_id, direcao, conteudo, remetente_tipo, remetente_id, remetente_nome, status_entrega)
     VALUES ($1, $2, 'saida', $3, 'operador', $4, $5, 'sending')
     RETURNING *`,
    [conversaId, conversa.empresa_id, conteudo, operador.id, operador.nome]
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

  // 6. Enviar para n8n Flow 2
  try {
    const response = await fetch(conversa.n8n_response_url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        phone: conversa.contato_whatsapp,
        message: conteudo,
        phone_number_id: whatsappNumber.phone_number_id,
        token: token,
        webhook_token: conversa.webhook_token,
      }),
      signal: AbortSignal.timeout(15000),
    });

    if (!response.ok) {
      logger.warn(`n8n Flow 2 retornou ${response.status} para conversa ${conversaId}`);
      // Atualizar status para failed
      await pool.query(
        `UPDATE mensagens_log SET status_entrega = 'failed' WHERE id = $1`,
        [mensagem.id]
      );
      mensagem.status_entrega = 'failed';
    } else {
      // Atualizar status para sent
      await pool.query(
        `UPDATE mensagens_log SET status_entrega = 'sent' WHERE id = $1`,
        [mensagem.id]
      );
      mensagem.status_entrega = 'sent';
    }
  } catch (error) {
    logger.error(`Erro enviando msg para n8n Flow 2:`, error.message);
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
  });

  return mensagem;
}
