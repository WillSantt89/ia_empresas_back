-- Migration 030: Adicionar colunas iteracoes e modelo à tabela conversacao_analytics

-- UP
ALTER TABLE conversacao_analytics
  ADD COLUMN IF NOT EXISTS iteracoes INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS modelo VARCHAR(100);

-- DOWN
ALTER TABLE conversacao_analytics
  DROP COLUMN IF EXISTS iteracoes,
  DROP COLUMN IF EXISTS modelo;
