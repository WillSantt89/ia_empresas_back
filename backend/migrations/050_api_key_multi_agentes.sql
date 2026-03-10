-- Migration 050: API Key multi-agentes
-- Uma API key pode ser usada por todos os agentes ou por agentes específicos

-- Flag para usar em todos os agentes da empresa
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS todos_agentes BOOLEAN NOT NULL DEFAULT false;

-- Tabela ponte para associação N:N entre api_keys e agentes
CREATE TABLE IF NOT EXISTS api_key_agentes (
  api_key_id UUID NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
  agente_id UUID NOT NULL REFERENCES agentes(id) ON DELETE CASCADE,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (api_key_id, agente_id)
);

CREATE INDEX IF NOT EXISTS idx_api_key_agentes_agente
  ON api_key_agentes(agente_id);

-- Migrar dados existentes: mover agente_id atual para tabela ponte
INSERT INTO api_key_agentes (api_key_id, agente_id)
SELECT id, agente_id FROM api_keys WHERE agente_id IS NOT NULL
ON CONFLICT DO NOTHING;
