-- Migration 065: Respostas Prontas (Canned Responses)
-- Respostas pré-definidas que operadores podem usar via atalho "/" no chat

CREATE TABLE IF NOT EXISTS respostas_prontas (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id UUID NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  shortcode VARCHAR(50) NOT NULL,
  conteudo TEXT NOT NULL,
  criado_por UUID REFERENCES usuarios(id) ON DELETE SET NULL,
  criado_em TIMESTAMPTZ DEFAULT NOW(),
  atualizado_em TIMESTAMPTZ DEFAULT NOW()
);

-- Shortcode único por empresa
CREATE UNIQUE INDEX idx_respostas_prontas_empresa_shortcode
  ON respostas_prontas(empresa_id, shortcode);

CREATE INDEX idx_respostas_prontas_empresa
  ON respostas_prontas(empresa_id);

-- Registrar migration
INSERT INTO migrations (name) VALUES ('065_respostas_prontas');
