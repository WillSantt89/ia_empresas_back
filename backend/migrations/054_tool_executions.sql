-- Migration 054: Tabela de execuções de tools para histórico e auditoria
-- Registra cada execução de tool (http, transferencia, encerramento, atributo)

-- UP

CREATE TABLE IF NOT EXISTS tool_executions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id UUID NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  tool_id UUID REFERENCES tools(id) ON DELETE SET NULL,
  tool_nome VARCHAR(100) NOT NULL,
  tipo_tool VARCHAR(20) NOT NULL DEFAULT 'http',
  agente_id UUID REFERENCES agentes(id) ON DELETE SET NULL,
  agente_nome VARCHAR(255),
  conversa_id UUID REFERENCES conversas(id) ON DELETE SET NULL,
  contato_whatsapp VARCHAR(30),
  contato_nome VARCHAR(255),
  parametros_json JSONB,
  resultado_json JSONB,
  sucesso BOOLEAN NOT NULL DEFAULT true,
  erro TEXT,
  tempo_processamento_ms INTEGER,
  criado_em TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tool_executions_empresa ON tool_executions(empresa_id, criado_em DESC);
CREATE INDEX IF NOT EXISTS idx_tool_executions_tool ON tool_executions(tool_id);
CREATE INDEX IF NOT EXISTS idx_tool_executions_agente ON tool_executions(agente_id);
CREATE INDEX IF NOT EXISTS idx_tool_executions_conversa ON tool_executions(conversa_id);
