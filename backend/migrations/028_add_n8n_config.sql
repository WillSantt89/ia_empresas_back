-- Migration: Add n8n webhook configuration to empresas
-- webhook_token: secret token for authenticating n8n webhook calls
-- n8n_response_url: optional URL for async response delivery to n8n

ALTER TABLE empresas ADD COLUMN IF NOT EXISTS webhook_token VARCHAR(64);
ALTER TABLE empresas ADD COLUMN IF NOT EXISTS n8n_response_url TEXT;

-- Index for fast token lookup (only non-null tokens)
CREATE INDEX IF NOT EXISTS idx_empresas_webhook_token ON empresas(webhook_token) WHERE webhook_token IS NOT NULL;
