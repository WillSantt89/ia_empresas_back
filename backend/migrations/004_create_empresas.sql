-- UP
CREATE TABLE IF NOT EXISTS empresas (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nome VARCHAR(255) NOT NULL,
  slug VARCHAR(100) UNIQUE NOT NULL,
  logo_url VARCHAR(500),
  plano_id UUID REFERENCES planos(id),
  chatwoot_url VARCHAR(500),
  chatwoot_api_token VARCHAR(500),
  chatwoot_account_id INTEGER,
  chatwoot_status VARCHAR(20) DEFAULT 'ativo' CHECK (chatwoot_status IN ('ativo', 'provisionando', 'erro')),
  chatwoot_admin_email VARCHAR(255),
  chatwoot_admin_senha_hash VARCHAR(255),
  ativo BOOLEAN DEFAULT true,
  criado_em TIMESTAMPTZ DEFAULT NOW(),
  atualizado_em TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes
CREATE INDEX idx_empresas_slug ON empresas(slug);
CREATE INDEX idx_empresas_plano_id ON empresas(plano_id);
CREATE INDEX idx_empresas_ativo ON empresas(ativo);
CREATE INDEX idx_empresas_chatwoot_account_id ON empresas(chatwoot_account_id);

-- Trigger para atualizar timestamp
CREATE TRIGGER update_empresas_updated_at BEFORE UPDATE ON empresas
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- DOWN
DROP TRIGGER IF EXISTS update_empresas_updated_at ON empresas;
DROP TABLE IF EXISTS empresas;