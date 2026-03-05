-- Migration 040: Mensagem configurável quando cliente envia mídia e IA não suporta
ALTER TABLE agentes
  ADD COLUMN IF NOT EXISTS mensagem_midia_nao_suportada TEXT DEFAULT NULL;

COMMENT ON COLUMN agentes.mensagem_midia_nao_suportada IS 'Mensagem enviada ao cliente quando envia mídia (imagem, áudio, etc) e o agente IA só aceita texto. NULL = processa mídia normalmente com Gemini.';
