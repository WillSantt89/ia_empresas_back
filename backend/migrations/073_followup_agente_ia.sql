-- Migration 073: Agente IA dedicado para follow-up
ALTER TABLE config_followup ADD COLUMN IF NOT EXISTS agente_followup_id UUID REFERENCES agentes(id) ON DELETE SET NULL;
