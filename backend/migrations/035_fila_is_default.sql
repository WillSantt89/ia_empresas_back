-- Migration 035: Adicionar coluna is_default em filas_atendimento
-- Permite definir uma fila padrao por empresa para receber novas conversas automaticamente

ALTER TABLE filas_atendimento ADD COLUMN IF NOT EXISTS is_default BOOLEAN DEFAULT false;

-- Garantir que apenas uma fila por empresa seja default
CREATE UNIQUE INDEX IF NOT EXISTS idx_filas_empresa_default
  ON filas_atendimento(empresa_id) WHERE is_default = true AND ativo = true;
