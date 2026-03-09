-- Migration 048: Add fila_destino_id to tools for queue-only transfers
-- Allows transfer tools to point to a queue instead of (or in addition to) an agent

ALTER TABLE tools ADD COLUMN IF NOT EXISTS fila_destino_id UUID REFERENCES filas_atendimento(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_tools_fila_destino ON tools(fila_destino_id) WHERE fila_destino_id IS NOT NULL;

-- Add constraint: transfer tool must have either agente_destino_id or fila_destino_id (not both, not neither)
-- Only applies to transfer tools
ALTER TABLE tools ADD CONSTRAINT tools_transfer_destino_check
  CHECK (
    tipo_tool <> 'transferencia'
    OR (agente_destino_id IS NOT NULL AND fila_destino_id IS NULL)
    OR (agente_destino_id IS NULL AND fila_destino_id IS NOT NULL)
  );
