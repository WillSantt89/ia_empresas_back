-- Migration 072: Auto-renovação de cache do prompt
ALTER TABLE agentes ADD COLUMN IF NOT EXISTS cache_auto_renew BOOLEAN DEFAULT false;
