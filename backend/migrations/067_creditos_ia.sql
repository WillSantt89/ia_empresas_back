-- Migration 067: Tabela de créditos IA (pool mensal por empresa)
-- Sistema de créditos substitui limite diário por agente

CREATE TABLE IF NOT EXISTS creditos_ia (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id UUID NOT NULL UNIQUE REFERENCES empresas(id) ON DELETE CASCADE,
  creditos_plano INTEGER NOT NULL DEFAULT 0,
  creditos_plano_usados INTEGER NOT NULL DEFAULT 0,
  creditos_extras INTEGER NOT NULL DEFAULT 0,
  creditos_extras_usados INTEGER NOT NULL DEFAULT 0,
  ciclo_inicio DATE NOT NULL DEFAULT CURRENT_DATE,
  ciclo_fim DATE NOT NULL DEFAULT (DATE_TRUNC('month', CURRENT_DATE) + INTERVAL '1 month - 1 day')::DATE,
  notificado_90 BOOLEAN NOT NULL DEFAULT false,
  bloqueado BOOLEAN NOT NULL DEFAULT false,
  criado_em TIMESTAMPTZ DEFAULT NOW(),
  atualizado_em TIMESTAMPTZ DEFAULT NOW()
);

-- Index para consultas rápidas no message-processor
CREATE INDEX IF NOT EXISTS idx_creditos_ia_empresa ON creditos_ia(empresa_id);

-- Trigger para atualizar timestamp
CREATE TRIGGER update_creditos_ia_updated_at
  BEFORE UPDATE ON creditos_ia
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();
