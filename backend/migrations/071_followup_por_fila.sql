-- Migration 071: Follow-up por fila
-- Permite configurar follow-up específico por fila de atendimento

-- Adicionar coluna fila_id (nullable = config padrão)
ALTER TABLE config_followup ADD COLUMN IF NOT EXISTS fila_id UUID REFERENCES filas_atendimento(id) ON DELETE CASCADE;

-- Adicionar nome para identificar a regra
ALTER TABLE config_followup ADD COLUMN IF NOT EXISTS nome VARCHAR(100);

-- Remover constraint UNIQUE antiga (empresa_id sozinho)
-- e criar nova constraint UNIQUE(empresa_id, fila_id) permitindo null
ALTER TABLE config_followup DROP CONSTRAINT IF EXISTS config_followup_empresa_id_key;

-- Unique: uma config por fila por empresa (null = padrão)
CREATE UNIQUE INDEX IF NOT EXISTS idx_config_followup_empresa_fila
  ON config_followup (empresa_id, COALESCE(fila_id, '00000000-0000-0000-0000-000000000000'));

-- Atualizar config existente com nome padrão
UPDATE config_followup SET nome = 'Padrão (todas as filas)' WHERE fila_id IS NULL AND nome IS NULL;
