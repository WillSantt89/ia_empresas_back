-- Migration 051: Corrigir filas sem is_default e conversas sem fila_id
-- Problema: migration 035 adicionou is_default com DEFAULT false mas nao atualizou filas existentes
-- Resultado: conversas criadas com fila_id = NULL nao aparecem no frontend

-- UP

-- 1. Para cada empresa que NAO tem fila default, marcar a primeira fila ativa (por criado_em) como default
UPDATE filas_atendimento
SET is_default = true
WHERE id IN (
  SELECT DISTINCT ON (empresa_id) id
  FROM filas_atendimento
  WHERE ativo = true
    AND empresa_id NOT IN (
      SELECT empresa_id FROM filas_atendimento WHERE is_default = true AND ativo = true
    )
  ORDER BY empresa_id, criado_em ASC
);

-- 2. Corrigir conversas ativas que ficaram sem fila_id — vincular à fila default da empresa
UPDATE conversas c
SET fila_id = (
  SELECT fa.id FROM filas_atendimento fa
  WHERE fa.empresa_id = c.empresa_id AND fa.ativo = true
  ORDER BY fa.is_default DESC, fa.criado_em ASC
  LIMIT 1
),
controlado_por = CASE
  WHEN c.operador_id IS NOT NULL THEN c.controlado_por
  WHEN c.controlado_por = 'ia' THEN 'ia'
  ELSE 'fila'
END,
atualizado_em = NOW()
WHERE c.fila_id IS NULL
  AND c.status IN ('ativo', 'pendente');
