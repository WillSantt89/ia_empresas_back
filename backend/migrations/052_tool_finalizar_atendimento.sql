-- Migration 052: Criar tool de encerramento de atendimento para todas as empresas
-- tipo_tool = 'encerramento' — tool interna que finaliza a conversa

-- UP

INSERT INTO tools (empresa_id, nome, descricao_para_llm, tipo_tool, parametros_schema_json, ativo)
SELECT
  e.id,
  'finalizar_atendimento',
  'Finaliza e encerra o atendimento atual. Use quando o cliente confirmar que não precisa de mais nada, quando o assunto foi resolvido, ou quando o cliente se despedir.',
  'encerramento',
  '{"type":"object","properties":{},"required":[]}',
  true
FROM empresas e
WHERE e.ativo = true
  AND NOT EXISTS (
    SELECT 1 FROM tools t
    WHERE t.empresa_id = e.id AND t.tipo_tool = 'encerramento'
  );
