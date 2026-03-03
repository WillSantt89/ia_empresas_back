-- Migration 032: Adicionar whatsapp_message_id à tabela mensagens_log

-- UP
ALTER TABLE mensagens_log
  ADD COLUMN IF NOT EXISTS whatsapp_message_id VARCHAR(255);

CREATE INDEX IF NOT EXISTS idx_mensagens_log_wamid ON mensagens_log(whatsapp_message_id) WHERE whatsapp_message_id IS NOT NULL;

-- DOWN
DROP INDEX IF EXISTS idx_mensagens_log_wamid;
ALTER TABLE mensagens_log
  DROP COLUMN IF EXISTS whatsapp_message_id;
