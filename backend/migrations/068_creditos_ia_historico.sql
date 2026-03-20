-- Migration 068: Histórico de movimentações de créditos IA

CREATE TABLE IF NOT EXISTS creditos_ia_historico (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id UUID NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  tipo VARCHAR(30) NOT NULL CHECK (tipo IN ('consumo', 'recarga', 'reset_mensal', 'agente_adicional', 'ajuste')),
  quantidade INTEGER NOT NULL,
  saldo_apos INTEGER NOT NULL,
  referencia VARCHAR(255),
  criado_em TIMESTAMPTZ DEFAULT NOW()
);

-- Index para consultas por empresa + período
CREATE INDEX IF NOT EXISTS idx_creditos_historico_empresa ON creditos_ia_historico(empresa_id, criado_em DESC);
CREATE INDEX IF NOT EXISTS idx_creditos_historico_tipo ON creditos_ia_historico(empresa_id, tipo);
