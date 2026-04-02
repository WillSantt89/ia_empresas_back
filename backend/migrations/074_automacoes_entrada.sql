-- Migration 074: Automações de Entrada
-- Consultas automáticas a APIs externas quando um novo cliente entra em contato.
-- Se a API retornar match=true, direciona o cliente ao agente destino com os dados.

CREATE TABLE IF NOT EXISTS automacoes_entrada (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id UUID NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  nome VARCHAR(100) NOT NULL,
  url_api TEXT NOT NULL,
  metodo VARCHAR(10) NOT NULL DEFAULT 'POST',
  headers_json JSONB DEFAULT '{}',
  agente_destino_id UUID NOT NULL REFERENCES agentes(id) ON DELETE CASCADE,
  timeout_ms INTEGER NOT NULL DEFAULT 5000,
  ativo BOOLEAN NOT NULL DEFAULT false,
  ordem INTEGER NOT NULL DEFAULT 0,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_automacoes_entrada_empresa ON automacoes_entrada(empresa_id);
CREATE INDEX idx_automacoes_entrada_empresa_ativo ON automacoes_entrada(empresa_id, ativo) WHERE ativo = true;
