-- Migration 043: Numeração sequencial de tickets por empresa
-- Cada empresa tem sua própria sequência (#00001, #00002, ...)

-- UP

-- Tabela de sequências por empresa
CREATE TABLE IF NOT EXISTS empresa_ticket_sequences (
  empresa_id UUID PRIMARY KEY REFERENCES empresas(id) ON DELETE CASCADE,
  next_val INTEGER NOT NULL DEFAULT 1
);

-- Função atômica: retorna próximo número e incrementa
CREATE OR REPLACE FUNCTION get_next_ticket_number(p_empresa_id UUID)
RETURNS INTEGER LANGUAGE plpgsql AS $$
DECLARE v_ticket INTEGER;
BEGIN
  INSERT INTO empresa_ticket_sequences (empresa_id, next_val)
  VALUES (p_empresa_id, 2)
  ON CONFLICT (empresa_id) DO UPDATE
    SET next_val = empresa_ticket_sequences.next_val + 1
  RETURNING next_val - 1 INTO v_ticket;
  RETURN v_ticket;
END; $$;

-- Coluna na tabela conversas
ALTER TABLE conversas ADD COLUMN IF NOT EXISTS numero_ticket INTEGER;

-- Índice único por empresa
CREATE UNIQUE INDEX IF NOT EXISTS idx_conversas_numero_ticket
  ON conversas (empresa_id, numero_ticket) WHERE numero_ticket IS NOT NULL;

-- Backfill: numerar conversas existentes por ordem de criação
WITH numbered AS (
  SELECT id, empresa_id, ROW_NUMBER() OVER (PARTITION BY empresa_id ORDER BY criado_em, id) AS num
  FROM conversas WHERE numero_ticket IS NULL
)
UPDATE conversas SET numero_ticket = numbered.num
FROM numbered WHERE conversas.id = numbered.id;

-- Inicializar sequences com valor correto (próximo número = total + 1)
INSERT INTO empresa_ticket_sequences (empresa_id, next_val)
SELECT empresa_id, COUNT(*) + 1 FROM conversas GROUP BY empresa_id
ON CONFLICT (empresa_id) DO UPDATE SET next_val = EXCLUDED.next_val;
