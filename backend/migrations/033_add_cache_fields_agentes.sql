-- Migration 033: Add context cache fields to agentes table
-- Gemini Context Caching support (manual, per-agent)

ALTER TABLE agentes
  ADD COLUMN IF NOT EXISTS cache_enabled BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS gemini_cache_id VARCHAR(255),
  ADD COLUMN IF NOT EXISTS cache_expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS cache_api_key_id UUID REFERENCES api_keys(id);
