-- Migration 046: Add api_key_hash for fast lookup without decryption
-- Security improvement: avoids decrypting ALL keys to find a match

ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS api_key_hash VARCHAR(64);

-- Create index for fast hash lookups
CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys (api_key_hash) WHERE api_key_hash IS NOT NULL;

-- Down migration:
-- ALTER TABLE api_keys DROP COLUMN IF EXISTS api_key_hash;
