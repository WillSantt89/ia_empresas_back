-- UP
CREATE TABLE IF NOT EXISTS itens_cobraveis (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug VARCHAR(50) UNIQUE NOT NULL,
  nome VARCHAR(100) NOT NULL,
  descricao TEXT,
  tipo_cobranca VARCHAR(20) NOT NULL CHECK (tipo_cobranca IN ('por_faixa', 'preco_fixo')),
  preco_fixo DECIMAL(10,2),
  ativo BOOLEAN DEFAULT true,
  criado_em TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes
CREATE INDEX idx_itens_cobraveis_slug ON itens_cobraveis(slug);
CREATE INDEX idx_itens_cobraveis_ativo ON itens_cobraveis(ativo);

-- Check constraint
ALTER TABLE itens_cobraveis ADD CONSTRAINT check_preco_fixo_required
  CHECK ((tipo_cobranca = 'preco_fixo' AND preco_fixo IS NOT NULL) OR tipo_cobranca = 'por_faixa');

-- DOWN
DROP TABLE IF EXISTS itens_cobraveis;