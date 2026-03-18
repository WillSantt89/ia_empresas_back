-- Migration 050: Configuração de follow-up automático
-- Permite configurar retries automáticos quando cliente não responde

-- Tabela de configuração por empresa
CREATE TABLE IF NOT EXISTS config_followup (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id UUID UNIQUE NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  ativo BOOLEAN DEFAULT false,

  -- Array de retries (1-5), cada um com: numero, intervalo_minutos, tipo ('fixo'|'ia'), mensagem_fixa
  retries JSONB DEFAULT '[
    {"numero": 1, "intervalo_minutos": 5, "tipo": "fixo", "mensagem_fixa": "Oi! Ainda está por aí? 😊"},
    {"numero": 2, "intervalo_minutos": 15, "tipo": "fixo", "mensagem_fixa": "Estou aqui caso precise de ajuda!"},
    {"numero": 3, "intervalo_minutos": 30, "tipo": "ia", "mensagem_fixa": null}
  ]'::jsonb,

  -- Horário de funcionamento
  horario_inicio TIME DEFAULT '08:00',
  horario_fim TIME DEFAULT '18:00',
  dias_semana INTEGER[] DEFAULT ARRAY[1,2,3,4,5], -- 0=dom, 1=seg..6=sab

  -- Mensagem de encerramento (enviada ao finalizar por inatividade)
  mensagem_encerramento TEXT DEFAULT 'Como não recebemos sua resposta, vou encerrar nosso atendimento por aqui. Caso precise, é só nos chamar novamente! 😊',

  criado_em TIMESTAMPTZ DEFAULT NOW(),
  atualizado_em TIMESTAMPTZ DEFAULT NOW()
);

-- Colunas de controle na conversa
ALTER TABLE conversas ADD COLUMN IF NOT EXISTS followup_count SMALLINT DEFAULT 0;
ALTER TABLE conversas ADD COLUMN IF NOT EXISTS followup_ultimo_em TIMESTAMPTZ;

-- Índice para o checker buscar conversas elegíveis
CREATE INDEX IF NOT EXISTS idx_conversas_followup
  ON conversas (empresa_id, status, controlado_por, followup_count)
  WHERE status = 'ativo' AND controlado_por = 'ia';
