-- Migration 070: Campos de ciclo calendário nas assinaturas

-- Data real da contratação
ALTER TABLE assinaturas ADD COLUMN IF NOT EXISTS data_contratacao DATE DEFAULT CURRENT_DATE;

-- Se já passou pelo ciclo proporcional (alinhamento ao calendário)
ALTER TABLE assinaturas ADD COLUMN IF NOT EXISTS primeiro_ciclo_completo BOOLEAN NOT NULL DEFAULT false;

-- Preencher data_contratacao com data_inicio para assinaturas existentes
UPDATE assinaturas SET data_contratacao = data_inicio WHERE data_contratacao IS NULL;

-- Inicializar creditos_ia para empresas com planos IA que já existem
INSERT INTO creditos_ia (empresa_id, creditos_plano, ciclo_inicio, ciclo_fim)
SELECT
  a.empresa_id,
  COALESCE(p.creditos_ia_mensal, 0),
  COALESCE(a.data_inicio, CURRENT_DATE),
  (DATE_TRUNC('month', CURRENT_DATE) + INTERVAL '1 month - 1 day')::DATE
FROM assinaturas a
JOIN planos p ON p.id = a.plano_id
WHERE a.status = 'ativa'
  AND p.creditos_ia_mensal > 0
  AND NOT EXISTS (SELECT 1 FROM creditos_ia c WHERE c.empresa_id = a.empresa_id)
ON CONFLICT (empresa_id) DO NOTHING;
