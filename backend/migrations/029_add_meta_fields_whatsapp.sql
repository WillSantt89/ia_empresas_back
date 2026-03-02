-- Migration 029: Adicionar campos de verificação Meta à tabela whatsapp_numbers

-- UP
ALTER TABLE whatsapp_numbers
  ADD COLUMN IF NOT EXISTS verified_name VARCHAR(255),
  ADD COLUMN IF NOT EXISTS display_phone_number VARCHAR(30),
  ADD COLUMN IF NOT EXISTS quality_rating VARCHAR(20),
  ADD COLUMN IF NOT EXISTS name_status VARCHAR(30),
  ADD COLUMN IF NOT EXISTS messaging_limit_tier VARCHAR(50),
  ADD COLUMN IF NOT EXISTS platform_type VARCHAR(20),
  ADD COLUMN IF NOT EXISTS account_mode VARCHAR(20),
  ADD COLUMN IF NOT EXISTS verificacao_status VARCHAR(20) DEFAULT 'pendente',
  ADD COLUMN IF NOT EXISTS verificacao_erro TEXT,
  ADD COLUMN IF NOT EXISTS ultima_verificacao TIMESTAMPTZ;

-- DOWN
ALTER TABLE whatsapp_numbers
  DROP COLUMN IF EXISTS verified_name,
  DROP COLUMN IF EXISTS display_phone_number,
  DROP COLUMN IF EXISTS quality_rating,
  DROP COLUMN IF EXISTS name_status,
  DROP COLUMN IF EXISTS messaging_limit_tier,
  DROP COLUMN IF EXISTS platform_type,
  DROP COLUMN IF EXISTS account_mode,
  DROP COLUMN IF EXISTS verificacao_status,
  DROP COLUMN IF EXISTS verificacao_erro,
  DROP COLUMN IF EXISTS ultima_verificacao;
