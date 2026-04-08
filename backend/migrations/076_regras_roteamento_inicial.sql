-- Migration 076: Roteamento Inteligente
-- Regras de roteamento por palavra-chave aplicadas APENAS na primeira mensagem
-- de uma nova conversa. Se a mensagem bater numa regra ativa, o ticket e
-- criado direto na fila configurada, sem chatbot e sem IA.

CREATE TABLE IF NOT EXISTS regras_roteamento_inicial (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id UUID NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  nome VARCHAR(100) NOT NULL,
  palavras_chave TEXT[] NOT NULL DEFAULT '{}',
  modo_match VARCHAR(10) NOT NULL DEFAULT 'contains'
    CHECK (modo_match IN ('contains', 'exact')),
  fila_id UUID NOT NULL REFERENCES filas_atendimento(id) ON DELETE CASCADE,
  resposta_automatica TEXT,
  ativo BOOLEAN NOT NULL DEFAULT false,
  ordem INTEGER NOT NULL DEFAULT 0,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_regras_roteamento_empresa_ativo
  ON regras_roteamento_inicial(empresa_id, ativo, ordem)
  WHERE ativo = true;
