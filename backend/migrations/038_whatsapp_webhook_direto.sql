-- Migration 038: Support for direct WhatsApp webhook (bypass n8n)
-- Adds whatsapp_app_secret column for HMAC signature validation

-- whatsapp_app_secret: Meta App Secret (encrypted with AES-256, same as token_graph_api)
-- Used to validate X-Hub-Signature-256 HMAC on incoming Meta webhooks
ALTER TABLE whatsapp_numbers ADD COLUMN IF NOT EXISTS whatsapp_app_secret TEXT;

-- Add comment for documentation
COMMENT ON COLUMN whatsapp_numbers.whatsapp_app_secret IS 'Meta App Secret (encrypted AES-256) for X-Hub-Signature-256 HMAC validation on direct webhooks';
