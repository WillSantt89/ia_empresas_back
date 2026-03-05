-- Migration 041: Coluna tipo_mensagem em mensagens_log para suporte a multimídia
ALTER TABLE mensagens_log
  ADD COLUMN IF NOT EXISTS tipo_mensagem VARCHAR(20) DEFAULT 'text';

COMMENT ON COLUMN mensagens_log.tipo_mensagem IS 'Tipo da mensagem: text, image, audio, video, document, sticker, contact, location';
