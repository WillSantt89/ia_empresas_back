-- UP

-- Migration 063: Prevenir tickets duplicados por conexao
-- Regra: apenas 1 conversa ativa por (empresa, contato, conexao WhatsApp)

-- 1. Limpar duplicatas existentes: manter apenas a mais recente por (empresa, contato, whatsapp_number_id)
WITH duplicatas AS (
  SELECT id,
    ROW_NUMBER() OVER (
      PARTITION BY empresa_id, contato_whatsapp, whatsapp_number_id
      ORDER BY criado_em DESC
    ) AS rn
  FROM conversas
  WHERE status = 'ativo' AND whatsapp_number_id IS NOT NULL
)
UPDATE conversas
SET status = 'finalizado',
    finalizado_em = NOW(),
    dados_json = COALESCE(dados_json, '{}'::jsonb) || '{"motivo_finalizacao": "duplicata_corrigida_migration_062"}'::jsonb
WHERE id IN (SELECT id FROM duplicatas WHERE rn > 1);

-- 2. Criar indice parcial unico
-- Permite apenas 1 conversa ativa por (empresa, contato, conexao)
-- Conversas sem whatsapp_number_id (legado) ficam fora do indice
CREATE UNIQUE INDEX IF NOT EXISTS idx_conversas_unique_ativo_conexao
  ON conversas (empresa_id, contato_whatsapp, whatsapp_number_id)
  WHERE status = 'ativo' AND whatsapp_number_id IS NOT NULL;
