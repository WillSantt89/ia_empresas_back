-- Migration 045: Vincular conversa a um número WhatsApp específico
-- Permite empresas com múltiplos números WhatsApp rastrear qual número pertence a cada conversa

ALTER TABLE conversas ADD COLUMN IF NOT EXISTS whatsapp_number_id UUID REFERENCES whatsapp_numbers(id) ON DELETE SET NULL;

-- Preencher conversas existentes com o primeiro número ativo da empresa
UPDATE conversas c SET whatsapp_number_id = (
  SELECT wn.id FROM whatsapp_numbers wn
  WHERE wn.empresa_id = c.empresa_id AND wn.ativo = true
  ORDER BY wn.criado_em ASC LIMIT 1
) WHERE c.whatsapp_number_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_conversas_whatsapp_number ON conversas(whatsapp_number_id);

INSERT INTO _migrations (name) VALUES ('045_conversa_whatsapp_number') ON CONFLICT DO NOTHING;
