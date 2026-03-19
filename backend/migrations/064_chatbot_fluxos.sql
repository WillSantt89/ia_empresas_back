-- UP

-- Migration 064: Chatbot Fluxos — motor de fluxo estruturado com IA fallback
-- Permite criar fluxos de coleta de dados (CPF, opcoes, etc) que economizam chamadas de IA

-- 1. Tabela de fluxos
CREATE TABLE IF NOT EXISTS chatbot_fluxos (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id UUID NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  nome VARCHAR(100) NOT NULL,
  descricao TEXT,
  fluxo_json JSONB NOT NULL DEFAULT '{}',
  ativo BOOLEAN DEFAULT true,
  criado_em TIMESTAMPTZ DEFAULT NOW(),
  atualizado_em TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_chatbot_fluxos_empresa ON chatbot_fluxos(empresa_id);

-- 2. Vincular agente ao fluxo (opcional)
ALTER TABLE agentes ADD COLUMN IF NOT EXISTS chatbot_fluxo_id UUID REFERENCES chatbot_fluxos(id) ON DELETE SET NULL;
ALTER TABLE agentes ADD COLUMN IF NOT EXISTS chatbot_ativo BOOLEAN DEFAULT false;
