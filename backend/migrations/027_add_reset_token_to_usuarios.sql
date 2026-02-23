-- UP
ALTER TABLE usuarios
ADD COLUMN IF NOT EXISTS reset_token_hash VARCHAR(255),
ADD COLUMN IF NOT EXISTS reset_token_expires TIMESTAMPTZ;

-- Index for faster lookups
CREATE INDEX IF NOT EXISTS idx_usuarios_reset_token_hash ON usuarios(reset_token_hash);

-- DOWN
DROP INDEX IF EXISTS idx_usuarios_reset_token_hash;

ALTER TABLE usuarios
DROP COLUMN IF EXISTS reset_token_hash,
DROP COLUMN IF EXISTS reset_token_expires;