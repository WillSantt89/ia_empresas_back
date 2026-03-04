-- Migration 034: Chat Proprio + Filas de Atendimento
-- Novas tabelas e alteracoes para substituir Chatwoot por sistema interno

-- ============================================
-- 1. NOVAS TABELAS
-- ============================================

-- Filas de atendimento (departamentos)
CREATE TABLE IF NOT EXISTS filas_atendimento (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id UUID NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  nome VARCHAR(100) NOT NULL,
  descricao TEXT,
  cor VARCHAR(7) DEFAULT '#3B82F6',
  icone VARCHAR(50) DEFAULT 'headset',

  -- Configuracao de atribuicao
  auto_assignment BOOLEAN DEFAULT true,
  metodo_distribuicao VARCHAR(20) DEFAULT 'round_robin' CHECK (metodo_distribuicao IN ('round_robin', 'manual')),
  max_conversas_por_operador INTEGER DEFAULT 10,

  -- Horario de funcionamento
  horario_funcionamento_ativo BOOLEAN DEFAULT false,
  horario_funcionamento JSONB DEFAULT '{}',
  mensagem_fora_horario TEXT DEFAULT 'Estamos fora do horario de atendimento. Retornaremos em breve.',

  -- Prioridade padrao
  prioridade_padrao VARCHAR(10) DEFAULT 'none' CHECK (prioridade_padrao IN ('none', 'low', 'medium', 'high', 'urgent')),

  -- SLA (tempo maximo de espera em minutos)
  sla_primeira_resposta_min INTEGER,
  sla_resolucao_min INTEGER,

  ativo BOOLEAN DEFAULT true,
  criado_em TIMESTAMPTZ DEFAULT NOW(),
  atualizado_em TIMESTAMPTZ DEFAULT NOW(),

  UNIQUE(empresa_id, nome)
);

CREATE INDEX IF NOT EXISTS idx_filas_empresa ON filas_atendimento(empresa_id) WHERE ativo = true;

-- Membros das filas
CREATE TABLE IF NOT EXISTS fila_membros (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  fila_id UUID NOT NULL REFERENCES filas_atendimento(id) ON DELETE CASCADE,
  usuario_id UUID NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  papel VARCHAR(20) DEFAULT 'membro' CHECK (papel IN ('membro', 'supervisor')),
  criado_em TIMESTAMPTZ DEFAULT NOW(),

  UNIQUE(fila_id, usuario_id)
);

CREATE INDEX IF NOT EXISTS idx_fila_membros_usuario ON fila_membros(usuario_id);
CREATE INDEX IF NOT EXISTS idx_fila_membros_fila ON fila_membros(fila_id);

-- Labels (tags globais por empresa)
CREATE TABLE IF NOT EXISTS labels (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id UUID NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  nome VARCHAR(50) NOT NULL,
  cor VARCHAR(7) DEFAULT '#6B7280',
  descricao TEXT,
  ativo BOOLEAN DEFAULT true,
  criado_em TIMESTAMPTZ DEFAULT NOW(),

  UNIQUE(empresa_id, nome)
);

CREATE INDEX IF NOT EXISTS idx_labels_empresa ON labels(empresa_id) WHERE ativo = true;

-- Relacao N:N entre conversas e labels
CREATE TABLE IF NOT EXISTS conversa_labels (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversa_id UUID NOT NULL REFERENCES conversas(id) ON DELETE CASCADE,
  label_id UUID NOT NULL REFERENCES labels(id) ON DELETE CASCADE,
  criado_em TIMESTAMPTZ DEFAULT NOW(),

  UNIQUE(conversa_id, label_id)
);

CREATE INDEX IF NOT EXISTS idx_conversa_labels_conversa ON conversa_labels(conversa_id);
CREATE INDEX IF NOT EXISTS idx_conversa_labels_label ON conversa_labels(label_id);

-- Notas internas (visiveis apenas para operadores/admins)
CREATE TABLE IF NOT EXISTS notas_internas (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversa_id UUID NOT NULL REFERENCES conversas(id) ON DELETE CASCADE,
  usuario_id UUID NOT NULL REFERENCES usuarios(id),
  usuario_nome VARCHAR(255),
  conteudo TEXT NOT NULL,
  criado_em TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_notas_conversa ON notas_internas(conversa_id);

-- ============================================
-- 2. ALTERACOES EM TABELAS EXISTENTES
-- ============================================

-- conversas: novos campos
ALTER TABLE conversas ADD COLUMN IF NOT EXISTS fila_id UUID REFERENCES filas_atendimento(id);
ALTER TABLE conversas ADD COLUMN IF NOT EXISTS fila_entrada_em TIMESTAMPTZ;
ALTER TABLE conversas ADD COLUMN IF NOT EXISTS operador_id UUID REFERENCES usuarios(id);
ALTER TABLE conversas ADD COLUMN IF NOT EXISTS operador_nome VARCHAR(255);
ALTER TABLE conversas ADD COLUMN IF NOT EXISTS operador_atribuido_em TIMESTAMPTZ;
ALTER TABLE conversas ADD COLUMN IF NOT EXISTS prioridade VARCHAR(10) DEFAULT 'none';
ALTER TABLE conversas ADD COLUMN IF NOT EXISTS snoozed_ate TIMESTAMPTZ;
ALTER TABLE conversas ADD COLUMN IF NOT EXISTS contato_nome VARCHAR(255);

-- Expandir CHECK de controlado_por para incluir 'fila'
ALTER TABLE conversas DROP CONSTRAINT IF EXISTS conversas_controlado_por_check;
ALTER TABLE conversas ADD CONSTRAINT conversas_controlado_por_check
  CHECK (controlado_por IN ('ia', 'humano', 'fila'));

-- Expandir CHECK de status para incluir 'pendente' e 'snoozed'
ALTER TABLE conversas DROP CONSTRAINT IF EXISTS conversas_status_check;
ALTER TABLE conversas ADD CONSTRAINT conversas_status_check
  CHECK (status IN ('ativo', 'pendente', 'snoozed', 'finalizado', 'timeout'));

-- Indices para novos campos
CREATE INDEX IF NOT EXISTS idx_conversas_fila ON conversas(fila_id, status) WHERE fila_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_conversas_operador ON conversas(operador_id, status) WHERE operador_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_conversas_prioridade ON conversas(prioridade, status);
CREATE INDEX IF NOT EXISTS idx_conversas_snoozed ON conversas(snoozed_ate) WHERE snoozed_ate IS NOT NULL AND status = 'snoozed';

-- usuarios: disponibilidade e capacidade
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS disponibilidade VARCHAR(20) DEFAULT 'offline';
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS auto_offline BOOLEAN DEFAULT true;
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS max_conversas_simultaneas INTEGER DEFAULT 10;
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS ultima_atividade TIMESTAMPTZ;

-- mensagens_log: status de entrega e remetente
ALTER TABLE mensagens_log ADD COLUMN IF NOT EXISTS status_entrega VARCHAR(20) DEFAULT 'sent';
ALTER TABLE mensagens_log ADD COLUMN IF NOT EXISTS remetente_tipo VARCHAR(20);
ALTER TABLE mensagens_log ADD COLUMN IF NOT EXISTS remetente_id UUID;
ALTER TABLE mensagens_log ADD COLUMN IF NOT EXISTS remetente_nome VARCHAR(255);

CREATE INDEX IF NOT EXISTS idx_mensagens_status_entrega ON mensagens_log(status_entrega) WHERE status_entrega != 'sent';
