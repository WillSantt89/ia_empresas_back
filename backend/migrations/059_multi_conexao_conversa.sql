-- Migration 059: Multi-conexão por ticket
-- Permite que uma conversa receba mensagens de múltiplos números WhatsApp
-- e o operador escolha qual conexão usar para responder.

-- 1. JSONB com as conexões que já enviaram mensagem nesta conversa
ALTER TABLE conversas ADD COLUMN IF NOT EXISTS conexoes_whatsapp JSONB DEFAULT '[]'::jsonb;

-- 2. Conexão ativa escolhida pelo operador (fallback: whatsapp_number_id original)
ALTER TABLE conversas ADD COLUMN IF NOT EXISTS conexao_ativa_id UUID REFERENCES whatsapp_numbers(id) ON DELETE SET NULL;

-- 3. Rastrear por qual número cada mensagem foi enviada/recebida
ALTER TABLE mensagens_log ADD COLUMN IF NOT EXISTS whatsapp_number_id UUID REFERENCES whatsapp_numbers(id) ON DELETE SET NULL;

-- 4. Popular conexoes_whatsapp nas conversas existentes que já têm whatsapp_number_id
UPDATE conversas SET conexoes_whatsapp = jsonb_build_array(
  jsonb_build_object(
    'wn_id', whatsapp_number_id::text,
    'first_seen', criado_em,
    'last_seen', atualizado_em
  )
) WHERE whatsapp_number_id IS NOT NULL AND (conexoes_whatsapp IS NULL OR conexoes_whatsapp = '[]'::jsonb);

-- 5. Setar conexao_ativa_id = whatsapp_number_id existente
UPDATE conversas SET conexao_ativa_id = whatsapp_number_id WHERE whatsapp_number_id IS NOT NULL AND conexao_ativa_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_conversas_conexao_ativa ON conversas(conexao_ativa_id);
CREATE INDEX IF NOT EXISTS idx_mensagens_log_wn_id ON mensagens_log(whatsapp_number_id);
