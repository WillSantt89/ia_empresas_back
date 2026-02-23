-- UP
CREATE TABLE IF NOT EXISTS planos (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nome VARCHAR(100) NOT NULL,
  descricao TEXT,
  preco_base_mensal DECIMAL(10,2) DEFAULT 0,
  max_usuarios INTEGER DEFAULT 3,
  max_tools INTEGER DEFAULT 10,
  max_mensagens_mes INTEGER DEFAULT 5000,
  permite_modelo_pro BOOLEAN DEFAULT false,
  ativo BOOLEAN DEFAULT true,
  criado_em TIMESTAMPTZ DEFAULT NOW(),
  atualizado_em TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes
CREATE INDEX idx_planos_ativo ON planos(ativo);

-- Trigger para atualizar timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.atualizado_em = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER update_planos_updated_at BEFORE UPDATE ON planos
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- DOWN
DROP TRIGGER IF EXISTS update_planos_updated_at ON planos;
DROP FUNCTION IF EXISTS update_updated_at_column();
DROP TABLE IF EXISTS planos;