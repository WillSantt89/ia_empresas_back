-- Migration 042: Add media storage columns to mensagens_log
-- Allows storing media files (images, audio, video, documents) from WhatsApp

ALTER TABLE mensagens_log
  ADD COLUMN IF NOT EXISTS midia_url TEXT DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS midia_mime_type VARCHAR(100) DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS midia_nome_arquivo VARCHAR(255) DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS midia_tamanho_bytes INTEGER DEFAULT NULL;

COMMENT ON COLUMN mensagens_log.midia_url IS 'Relative path to stored media file (e.g. {empresa_id}/{YYYY-MM}/{uuid}.jpg)';
COMMENT ON COLUMN mensagens_log.midia_mime_type IS 'MIME type of the media file for frontend rendering';
COMMENT ON COLUMN mensagens_log.midia_nome_arquivo IS 'Original filename (for documents)';
COMMENT ON COLUMN mensagens_log.midia_tamanho_bytes IS 'File size in bytes';
