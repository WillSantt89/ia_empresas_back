-- Migration 075: Reply to Message (citacao/quote)
-- Adiciona suporte a "responder mensagem" estilo WhatsApp.
--
-- reply_to_message_id: FK pra mensagem da nossa base que esta sendo respondida.
--                      Permite resolver autor/conteudo da citacao via JOIN sem
--                      depender da Meta API.
-- reply_to_wamid:      wamid da Meta da mensagem original. Usado quando enviamos
--                      uma reply (precisamos do wamid pra colocar no context.message_id)
--                      e quando recebemos uma reply do cliente (Meta envia o wamid
--                      no payload do webhook). Pode ser preenchido sem que tenhamos
--                      o registro local correspondente (mensagem antiga, importada).

ALTER TABLE mensagens_log
  ADD COLUMN IF NOT EXISTS reply_to_message_id UUID REFERENCES mensagens_log(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS reply_to_wamid VARCHAR(255);

-- Index para listar respostas de uma mensagem (raro mas eventualmente util)
CREATE INDEX IF NOT EXISTS idx_mensagens_log_reply_to ON mensagens_log(reply_to_message_id) WHERE reply_to_message_id IS NOT NULL;

-- Index para resolver wamid -> mensagem ao receber webhook (cliente respondendo nossa msg)
CREATE INDEX IF NOT EXISTS idx_mensagens_log_reply_to_wamid ON mensagens_log(reply_to_wamid) WHERE reply_to_wamid IS NOT NULL;
