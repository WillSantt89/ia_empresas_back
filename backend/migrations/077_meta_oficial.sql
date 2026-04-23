-- Migration 077: Meta Oficial (Embedded Signup)
-- Canal totalmente separado do whatsapp_numbers legado.
-- Fluxo: cliente se conecta via Facebook Login for Business (Embedded Signup) dentro
-- do painel, e a WSChat assume como Tech Provider da WABA do cliente.
--
-- Isolamento total: tabelas, rotas, webhook e filas BullMQ próprias.
-- Único ponto de compartilhamento: helpers de IA (Gemini, filas, créditos).
--
-- Billing: consumo por conversa é capturado do webhook "statuses.pricing" da Meta
-- e convertido de USD para BRL via câmbio + markup configurável (global + override
-- por empresa). Faturas mensais são geradas no fechamento do ciclo.

-- ============================================================
-- 1. WABAs conectadas (1 empresa pode ter várias WABAs)
-- ============================================================
CREATE TABLE IF NOT EXISTS meta_business_accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id UUID NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  waba_id VARCHAR(64) NOT NULL UNIQUE,
  business_id VARCHAR(64),
  nome VARCHAR(255),
  currency VARCHAR(8),
  timezone_id VARCHAR(16),
  message_template_namespace VARCHAR(128),
  access_token_encrypted TEXT NOT NULL,
  onboarding_status VARCHAR(32) NOT NULL DEFAULT 'pending'
    CHECK (onboarding_status IN ('pending', 'active', 'error', 'disconnected')),
  onboarded_at TIMESTAMPTZ,
  onboarded_by_usuario_id UUID REFERENCES usuarios(id) ON DELETE SET NULL,
  ativo BOOLEAN NOT NULL DEFAULT true,
  meta_raw_payload JSONB,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_meta_waba_empresa ON meta_business_accounts(empresa_id, ativo);

-- ============================================================
-- 2. Números de telefone conectados (1 WABA pode ter vários números)
-- ============================================================
CREATE TABLE IF NOT EXISTS meta_phone_numbers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  meta_waba_id UUID NOT NULL REFERENCES meta_business_accounts(id) ON DELETE CASCADE,
  empresa_id UUID NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  phone_number_id VARCHAR(64) NOT NULL UNIQUE,
  display_phone_number VARCHAR(32),
  verified_name VARCHAR(128),
  quality_rating VARCHAR(16),
  messaging_limit_tier VARCHAR(32),
  code_verification_status VARCHAR(32),
  registration_status VARCHAR(32) NOT NULL DEFAULT 'pending'
    CHECK (registration_status IN ('pending', 'registered', 'failed')),
  registered_at TIMESTAMPTZ,
  webhook_subscribed BOOLEAN NOT NULL DEFAULT false,
  pin_2fa_encrypted TEXT,
  ativo BOOLEAN NOT NULL DEFAULT true,
  meta_raw_payload JSONB,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_meta_phone_empresa ON meta_phone_numbers(empresa_id, ativo);
CREATE INDEX IF NOT EXISTS idx_meta_phone_waba ON meta_phone_numbers(meta_waba_id);

-- ============================================================
-- 3. Audit log do processo de Embedded Signup
-- ============================================================
CREATE TABLE IF NOT EXISTS meta_signup_audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id UUID NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  usuario_id UUID REFERENCES usuarios(id) ON DELETE SET NULL,
  event_type VARCHAR(64) NOT NULL,
  event_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  error_message TEXT,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_meta_audit_empresa
  ON meta_signup_audit_log(empresa_id, criado_em DESC);

-- ============================================================
-- 4. Config global / por empresa de precificação e markup
--    empresa_id = NULL → default global (único; enforce abaixo)
-- ============================================================
CREATE TABLE IF NOT EXISTS meta_precificacao_config (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id UUID REFERENCES empresas(id) ON DELETE CASCADE,
  markup_percentual NUMERIC(5,2) NOT NULL DEFAULT 50.00,
  taxa_cambio_fixa NUMERIC(10,4),
  -- Overrides opcionais por categoria em BRL (se NULL usa cálculo USD × câmbio × markup)
  preco_marketing_brl NUMERIC(10,4),
  preco_utility_brl NUMERIC(10,4),
  preco_authentication_brl NUMERIC(10,4),
  preco_service_brl NUMERIC(10,4),
  vigencia_inicio DATE NOT NULL DEFAULT CURRENT_DATE,
  vigencia_fim DATE,
  ativo BOOLEAN NOT NULL DEFAULT true,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Garantir apenas 1 config global ativa (empresa_id NULL) e 1 override ativo por empresa
CREATE UNIQUE INDEX IF NOT EXISTS uniq_meta_precificacao_global_ativo
  ON meta_precificacao_config(ativo) WHERE empresa_id IS NULL AND ativo = true;
CREATE UNIQUE INDEX IF NOT EXISTS uniq_meta_precificacao_empresa_ativo
  ON meta_precificacao_config(empresa_id) WHERE empresa_id IS NOT NULL AND ativo = true;

-- Seed do default global (50% markup, sem câmbio fixo)
INSERT INTO meta_precificacao_config (empresa_id, markup_percentual, ativo)
SELECT NULL, 50.00, true
WHERE NOT EXISTS (
  SELECT 1 FROM meta_precificacao_config WHERE empresa_id IS NULL AND ativo = true
);

-- ============================================================
-- 5. Consumo por conversa (fonte da verdade pra billing)
--    Cada linha = 1 "conversation" cobrada pela Meta
-- ============================================================
CREATE TABLE IF NOT EXISTS meta_conversas_consumo (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id UUID NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  meta_waba_id UUID NOT NULL REFERENCES meta_business_accounts(id) ON DELETE CASCADE,
  meta_phone_number_id UUID NOT NULL REFERENCES meta_phone_numbers(id) ON DELETE CASCADE,
  conversation_id VARCHAR(128) NOT NULL UNIQUE,
  category VARCHAR(32) NOT NULL
    CHECK (category IN ('marketing', 'utility', 'authentication', 'service', 'referral_conversion')),
  pricing_model VARCHAR(16),
  origin_type VARCHAR(32),
  billable BOOLEAN NOT NULL DEFAULT true,
  custo_usd NUMERIC(10,6) NOT NULL DEFAULT 0,
  taxa_cambio_snapshot NUMERIC(10,4),
  custo_brl NUMERIC(10,4) NOT NULL DEFAULT 0,
  markup_aplicado NUMERIC(5,2),
  preco_cliente_brl NUMERIC(10,4) NOT NULL DEFAULT 0,
  iniciada_em TIMESTAMPTZ NOT NULL,
  expira_em TIMESTAMPTZ,
  ciclo_ref DATE NOT NULL,
  raw_payload JSONB,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_meta_consumo_empresa_ciclo
  ON meta_conversas_consumo(empresa_id, ciclo_ref);
CREATE INDEX IF NOT EXISTS idx_meta_consumo_category
  ON meta_conversas_consumo(empresa_id, category, ciclo_ref);

-- ============================================================
-- 6. Log mensagem a mensagem (auditoria + correlação wamid↔conversa)
-- ============================================================
CREATE TABLE IF NOT EXISTS meta_mensagens_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id UUID NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  meta_phone_number_id UUID NOT NULL REFERENCES meta_phone_numbers(id) ON DELETE CASCADE,
  conversation_id VARCHAR(128),
  wamid VARCHAR(128) UNIQUE,
  direcao VARCHAR(8) NOT NULL CHECK (direcao IN ('in', 'out')),
  tipo VARCHAR(32) NOT NULL,
  de VARCHAR(32),
  para VARCHAR(32),
  conteudo TEXT,
  midia_url TEXT,
  midia_mime_type VARCHAR(64),
  template_name VARCHAR(128),
  status VARCHAR(16)
    CHECK (status IS NULL OR status IN ('accepted', 'sent', 'delivered', 'read', 'failed', 'deleted')),
  enviada_em TIMESTAMPTZ,
  entregue_em TIMESTAMPTZ,
  lida_em TIMESTAMPTZ,
  falhou_em TIMESTAMPTZ,
  erro_code VARCHAR(32),
  erro_message TEXT,
  raw_payload JSONB,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_meta_msg_empresa_data
  ON meta_mensagens_log(empresa_id, criado_em DESC);
CREATE INDEX IF NOT EXISTS idx_meta_msg_conversation
  ON meta_mensagens_log(conversation_id) WHERE conversation_id IS NOT NULL;

-- ============================================================
-- 7. Fechamento mensal (fatura agregada pra cobrar o cliente)
-- ============================================================
CREATE TABLE IF NOT EXISTS meta_fatura_mensal (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id UUID NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  mes_ref DATE NOT NULL,
  total_conversas INTEGER NOT NULL DEFAULT 0,
  total_billable INTEGER NOT NULL DEFAULT 0,
  qtd_marketing INTEGER NOT NULL DEFAULT 0,
  qtd_utility INTEGER NOT NULL DEFAULT 0,
  qtd_authentication INTEGER NOT NULL DEFAULT 0,
  qtd_service INTEGER NOT NULL DEFAULT 0,
  total_custo_usd NUMERIC(12,4) NOT NULL DEFAULT 0,
  total_custo_brl NUMERIC(12,4) NOT NULL DEFAULT 0,
  total_preco_cliente_brl NUMERIC(12,4) NOT NULL DEFAULT 0,
  margem_brl NUMERIC(12,4) GENERATED ALWAYS AS
    (total_preco_cliente_brl - total_custo_brl) STORED,
  status VARCHAR(16) NOT NULL DEFAULT 'aberta'
    CHECK (status IN ('aberta', 'fechada', 'paga', 'contestada')),
  fechada_em TIMESTAMPTZ,
  paga_em TIMESTAMPTZ,
  observacao TEXT,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (empresa_id, mes_ref)
);

CREATE INDEX IF NOT EXISTS idx_meta_fatura_empresa_status
  ON meta_fatura_mensal(empresa_id, status);
