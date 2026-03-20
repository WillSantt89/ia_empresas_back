-- Migration 066: Membros de conexões WhatsApp
-- Permite atribuir operadores a conexões específicas (estilo Chatwoot inbox members)
-- Se a conexão não tem membros, todos veem (backward compatible)

CREATE TABLE IF NOT EXISTS whatsapp_number_membros (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  whatsapp_number_id UUID NOT NULL REFERENCES whatsapp_numbers(id) ON DELETE CASCADE,
  usuario_id UUID NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  criado_em TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(whatsapp_number_id, usuario_id)
);

CREATE INDEX idx_wn_membros_whatsapp ON whatsapp_number_membros(whatsapp_number_id);
CREATE INDEX idx_wn_membros_usuario ON whatsapp_number_membros(usuario_id);

-- Registrar migration
INSERT INTO migrations (name) VALUES ('066_whatsapp_number_membros');
