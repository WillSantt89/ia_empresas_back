-- Migration 037: Criar tabela contatos
-- Separa dados de contato da tabela conversas em entidade dedicada

-- 1. Criar tabela contatos
CREATE TABLE IF NOT EXISTS contatos (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id UUID NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  whatsapp VARCHAR(20) NOT NULL,
  nome VARCHAR(255),
  email VARCHAR(255),
  observacoes TEXT,
  dados_json JSONB DEFAULT '{}',
  ativo BOOLEAN DEFAULT true,
  criado_em TIMESTAMPTZ DEFAULT NOW(),
  atualizado_em TIMESTAMPTZ DEFAULT NOW()
);

-- Constraint: um contato por whatsapp por empresa
ALTER TABLE contatos ADD CONSTRAINT contatos_empresa_whatsapp_unique UNIQUE (empresa_id, whatsapp);

-- Índices
CREATE INDEX IF NOT EXISTS idx_contatos_empresa_id ON contatos(empresa_id);
CREATE INDEX IF NOT EXISTS idx_contatos_whatsapp ON contatos(whatsapp);
CREATE INDEX IF NOT EXISTS idx_contatos_nome ON contatos(nome);
CREATE INDEX IF NOT EXISTS idx_contatos_empresa_ativo ON contatos(empresa_id, ativo);

-- 2. Adicionar coluna contato_id em conversas
ALTER TABLE conversas ADD COLUMN IF NOT EXISTS contato_id UUID REFERENCES contatos(id);
CREATE INDEX IF NOT EXISTS idx_conversas_contato_id ON conversas(contato_id);

-- 3. Data migration: popular contatos a partir de conversas existentes
INSERT INTO contatos (empresa_id, whatsapp, nome, criado_em)
SELECT DISTINCT ON (empresa_id, contato_whatsapp)
  empresa_id,
  contato_whatsapp,
  contato_nome,
  MIN(criado_em) OVER (PARTITION BY empresa_id, contato_whatsapp)
FROM conversas
WHERE contato_whatsapp IS NOT NULL
  AND contato_whatsapp != ''
ON CONFLICT (empresa_id, whatsapp) DO NOTHING;

-- 4. Atualizar conversas.contato_id com os contatos migrados
UPDATE conversas c
SET contato_id = ct.id
FROM contatos ct
WHERE c.empresa_id = ct.empresa_id
  AND c.contato_whatsapp = ct.whatsapp
  AND c.contato_id IS NULL;
