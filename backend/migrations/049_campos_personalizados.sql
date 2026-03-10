-- Migration 049: Campos Personalizados (Custom Attributes)
-- Definições de campos criados pelo admin para contato ou atendimento

CREATE TABLE IF NOT EXISTS campos_personalizados (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id UUID NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,

  display_name VARCHAR(100) NOT NULL,
  chave VARCHAR(80) NOT NULL,
  tipo VARCHAR(20) NOT NULL DEFAULT 'text',
  contexto VARCHAR(20) NOT NULL DEFAULT 'contato',
  descricao TEXT,

  opcoes JSONB DEFAULT '[]',
  regex_pattern VARCHAR(500),
  regex_mensagem VARCHAR(255),
  valor_padrao VARCHAR(500),

  obrigatorio_resolucao BOOLEAN NOT NULL DEFAULT false,
  ordem INTEGER NOT NULL DEFAULT 0,
  ativo BOOLEAN NOT NULL DEFAULT true,

  criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Constraints
  CONSTRAINT campos_tipo_check CHECK (tipo IN ('text','number','date','list','checkbox','link','phone','email','cpf')),
  CONSTRAINT campos_contexto_check CHECK (contexto IN ('contato','atendimento')),
  CONSTRAINT campos_chave_unique UNIQUE (empresa_id, contexto, chave)
);

-- Indices
CREATE INDEX IF NOT EXISTS idx_campos_personalizados_empresa
  ON campos_personalizados(empresa_id);
CREATE INDEX IF NOT EXISTS idx_campos_personalizados_empresa_contexto
  ON campos_personalizados(empresa_id, contexto, ativo);
CREATE INDEX IF NOT EXISTS idx_campos_personalizados_ordem
  ON campos_personalizados(empresa_id, contexto, ordem);
