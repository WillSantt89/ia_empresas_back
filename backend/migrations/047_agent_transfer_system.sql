-- Migration 047: Sistema de Transferência entre Agentes
-- Agentes vinculados a filas, tools internas de transferência,
-- auto-criação de agente triagem + fila por empresa

-- 1. Adicionar fila_id ao agente (vínculo agente ↔ fila)
ALTER TABLE agentes ADD COLUMN IF NOT EXISTS fila_id UUID REFERENCES filas_atendimento(id) ON DELETE SET NULL;

-- 2. Adicionar flag is_triagem ao agente
ALTER TABLE agentes ADD COLUMN IF NOT EXISTS is_triagem BOOLEAN DEFAULT false;

-- 3. Adicionar tipo_tool à tabela tools (http = padrão, transferencia = interna)
ALTER TABLE tools ADD COLUMN IF NOT EXISTS tipo_tool VARCHAR(20) DEFAULT 'http'
  CHECK (tipo_tool IN ('http', 'transferencia'));

-- 4. Adicionar agente_destino_id para tools de transferência
ALTER TABLE tools ADD COLUMN IF NOT EXISTS agente_destino_id UUID REFERENCES agentes(id) ON DELETE CASCADE;

-- 5. Tornar url e metodo nullable (tools internas não precisam)
ALTER TABLE tools ALTER COLUMN url DROP NOT NULL;
ALTER TABLE tools ALTER COLUMN metodo DROP NOT NULL;

-- 6. Índice para buscar tools de transferência por agente destino
CREATE INDEX IF NOT EXISTS idx_tools_agente_destino ON tools(agente_destino_id) WHERE tipo_tool = 'transferencia';

-- 7. Índice para buscar agente de triagem de uma empresa
CREATE INDEX IF NOT EXISTS idx_agentes_triagem ON agentes(empresa_id) WHERE is_triagem = true;

-- 8. Índice para buscar agente por fila
CREATE INDEX IF NOT EXISTS idx_agentes_fila ON agentes(fila_id) WHERE fila_id IS NOT NULL;
