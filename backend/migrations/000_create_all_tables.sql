-- This is a consolidated migration file for faster development
-- In production, split into individual files

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Function to update timestamps
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.atualizado_em = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

-- 1. PLANOS
CREATE TABLE IF NOT EXISTS planos (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nome VARCHAR(100) NOT NULL,
  descricao TEXT,
  preco_base_mensal DECIMAL(10,2) DEFAULT 0,
  max_usuarios INTEGER DEFAULT 3,
  max_tools INTEGER DEFAULT 10,
  max_mensagens_mes INTEGER DEFAULT 5000,
  permite_modelo_pro BOOLEAN DEFAULT false,
  ativo BOOLEAN DEFAULT true,
  criado_em TIMESTAMPTZ DEFAULT NOW(),
  atualizado_em TIMESTAMPTZ DEFAULT NOW()
);

-- 2. ITENS COBRÁVEIS
CREATE TABLE IF NOT EXISTS itens_cobraveis (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug VARCHAR(50) UNIQUE NOT NULL,
  nome VARCHAR(100) NOT NULL,
  descricao TEXT,
  tipo_cobranca VARCHAR(20) NOT NULL CHECK (tipo_cobranca IN ('por_faixa', 'preco_fixo')),
  preco_fixo DECIMAL(10,2),
  ativo BOOLEAN DEFAULT true,
  criado_em TIMESTAMPTZ DEFAULT NOW()
);

-- 3. FAIXAS ITEM
CREATE TABLE IF NOT EXISTS faixas_item (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  item_cobravel_id UUID NOT NULL REFERENCES itens_cobraveis(id) ON DELETE CASCADE,
  nome VARCHAR(100) NOT NULL,
  limite_diario INTEGER NOT NULL,
  preco_mensal DECIMAL(10,2) NOT NULL,
  ativo BOOLEAN DEFAULT true,
  criado_em TIMESTAMPTZ DEFAULT NOW()
);

-- 4. EMPRESAS
CREATE TABLE IF NOT EXISTS empresas (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nome VARCHAR(255) NOT NULL,
  slug VARCHAR(100) UNIQUE NOT NULL,
  logo_url VARCHAR(500),
  plano_id UUID REFERENCES planos(id),
  chatwoot_url VARCHAR(500),
  chatwoot_api_token VARCHAR(500),
  chatwoot_account_id INTEGER,
  chatwoot_status VARCHAR(20) DEFAULT 'ativo' CHECK (chatwoot_status IN ('ativo', 'provisionando', 'erro')),
  chatwoot_admin_email VARCHAR(255),
  chatwoot_admin_senha_hash VARCHAR(255),
  ativo BOOLEAN DEFAULT true,
  criado_em TIMESTAMPTZ DEFAULT NOW(),
  atualizado_em TIMESTAMPTZ DEFAULT NOW()
);

-- 5. USUARIOS
CREATE TABLE IF NOT EXISTS usuarios (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id UUID REFERENCES empresas(id) ON DELETE CASCADE,
  nome VARCHAR(255) NOT NULL,
  email VARCHAR(255) UNIQUE NOT NULL,
  senha_hash VARCHAR(255) NOT NULL,
  role VARCHAR(20) NOT NULL CHECK (role IN ('master', 'admin', 'operador', 'viewer')),
  ativo BOOLEAN DEFAULT true,
  ultimo_login TIMESTAMPTZ,
  reset_token_hash VARCHAR(255),
  reset_token_expires TIMESTAMPTZ,
  criado_em TIMESTAMPTZ DEFAULT NOW()
);

-- 6. API KEYS
CREATE TABLE IF NOT EXISTS api_keys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id UUID NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  provedor VARCHAR(50) NOT NULL DEFAULT 'gemini' CHECK (provedor IN ('gemini', 'openai', 'anthropic')),
  nome_exibicao VARCHAR(100) NOT NULL,
  api_key_encrypted TEXT NOT NULL,
  status VARCHAR(20) DEFAULT 'standby' CHECK (status IN ('ativa', 'standby', 'rate_limited', 'erro', 'desativada')),
  prioridade INTEGER NOT NULL DEFAULT 1,
  total_requests_hoje INTEGER DEFAULT 0,
  total_tokens_hoje BIGINT DEFAULT 0,
  ultimo_uso TIMESTAMPTZ,
  ultimo_erro TIMESTAMPTZ,
  ultimo_erro_msg TEXT,
  retry_apos TIMESTAMPTZ,
  tentativas_erro INTEGER DEFAULT 0,
  criado_por UUID REFERENCES usuarios(id),
  criado_em TIMESTAMPTZ DEFAULT NOW(),
  atualizado_em TIMESTAMPTZ DEFAULT NOW()
);

-- 7. ASSINATURAS
CREATE TABLE IF NOT EXISTS assinaturas (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id UUID UNIQUE NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  plano_id UUID NOT NULL REFERENCES planos(id),
  status VARCHAR(20) DEFAULT 'ativa' CHECK (status IN ('ativa', 'suspensa', 'cancelada')),
  data_inicio DATE NOT NULL DEFAULT CURRENT_DATE,
  data_proximo_cobro DATE,
  criado_em TIMESTAMPTZ DEFAULT NOW(),
  atualizado_em TIMESTAMPTZ DEFAULT NOW()
);

-- 8. ASSINATURA ITENS
CREATE TABLE IF NOT EXISTS assinatura_itens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  assinatura_id UUID NOT NULL REFERENCES assinaturas(id) ON DELETE CASCADE,
  empresa_id UUID NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  item_cobravel_id UUID NOT NULL REFERENCES itens_cobraveis(id),
  faixa_id UUID REFERENCES faixas_item(id),
  quantidade INTEGER NOT NULL DEFAULT 1,
  preco_unitario DECIMAL(10,2) NOT NULL,
  limite_diario INTEGER,
  preco_total DECIMAL(10,2) GENERATED ALWAYS AS (quantidade * preco_unitario) STORED,
  ativo BOOLEAN DEFAULT true,
  adicionado_em TIMESTAMPTZ DEFAULT NOW(),
  removido_em TIMESTAMPTZ
);

-- 9. AGENTES (criado antes de outras tabelas que referenciam)
CREATE TABLE IF NOT EXISTS agentes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id UUID NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  nome VARCHAR(100) NOT NULL,
  descricao TEXT,
  tipo VARCHAR(20) NOT NULL DEFAULT 'especialista' CHECK (tipo IN ('triagem', 'especialista')),
  modelo_llm VARCHAR(50) DEFAULT 'gemini-2.0-flash-001',
  temperatura DECIMAL(2,1) DEFAULT 0.3 CHECK (temperatura >= 0 AND temperatura <= 1),
  max_tokens INTEGER DEFAULT 2048,
  mensagem_limite_atingido TEXT DEFAULT 'Olá! No momento estamos com alto volume de atendimentos. Tente novamente mais tarde! 🙏',
  conta_atendimento BOOLEAN DEFAULT true,
  ativo BOOLEAN DEFAULT true,
  criado_em TIMESTAMPTZ DEFAULT NOW(),
  atualizado_em TIMESTAMPTZ DEFAULT NOW()
);

-- 10. INBOXES
CREATE TABLE IF NOT EXISTS inboxes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id UUID NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  inbox_id_chatwoot INTEGER NOT NULL,
  nome VARCHAR(100),
  agente_id UUID REFERENCES agentes(id) ON DELETE SET NULL,
  ativo BOOLEAN DEFAULT true,
  criado_em TIMESTAMPTZ DEFAULT NOW()
);

-- 11. WHATSAPP NUMBERS
CREATE TABLE IF NOT EXISTS whatsapp_numbers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id UUID NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  inbox_id UUID REFERENCES inboxes(id) ON DELETE SET NULL,
  nome_exibicao VARCHAR(100),
  phone_number_id VARCHAR(100) NOT NULL,
  waba_id VARCHAR(100),
  token_graph_api TEXT NOT NULL,
  numero_formatado VARCHAR(20),
  ativo BOOLEAN DEFAULT true,
  criado_em TIMESTAMPTZ DEFAULT NOW()
);

-- 12. PROMPTS
CREATE TABLE IF NOT EXISTS prompts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agente_id UUID NOT NULL REFERENCES agentes(id) ON DELETE CASCADE,
  empresa_id UUID NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  versao INTEGER NOT NULL DEFAULT 1,
  conteudo TEXT NOT NULL,
  ativo BOOLEAN DEFAULT false,
  criado_por UUID REFERENCES usuarios(id),
  criado_em TIMESTAMPTZ DEFAULT NOW()
);

-- 13. TOOLS
CREATE TABLE IF NOT EXISTS tools (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id UUID NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  nome VARCHAR(100) NOT NULL,
  descricao_para_llm TEXT NOT NULL,
  url VARCHAR(500) NOT NULL,
  metodo VARCHAR(10) NOT NULL DEFAULT 'POST' CHECK (metodo IN ('GET', 'POST', 'PUT', 'PATCH', 'DELETE')),
  headers_json JSONB DEFAULT '{}',
  body_template_json JSONB DEFAULT '{}',
  parametros_schema_json JSONB NOT NULL,
  timeout_ms INTEGER DEFAULT 30000,
  ativo BOOLEAN DEFAULT true,
  criado_em TIMESTAMPTZ DEFAULT NOW(),
  atualizado_em TIMESTAMPTZ DEFAULT NOW()
);

-- 14. AGENTE TOOLS
CREATE TABLE IF NOT EXISTS agente_tools (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agente_id UUID NOT NULL REFERENCES agentes(id) ON DELETE CASCADE,
  tool_id UUID NOT NULL REFERENCES tools(id) ON DELETE CASCADE,
  ordem_prioridade INTEGER DEFAULT 0,
  ativo BOOLEAN DEFAULT true,
  criado_em TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(agente_id, tool_id)
);

-- 15. AGENTE TRANSFERENCIAS
CREATE TABLE IF NOT EXISTS agente_transferencias (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id UUID NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  agente_origem_id UUID NOT NULL REFERENCES agentes(id) ON DELETE CASCADE,
  agente_destino_id UUID NOT NULL REFERENCES agentes(id) ON DELETE CASCADE,
  trigger_tipo VARCHAR(30) NOT NULL CHECK (trigger_tipo IN ('tool_result', 'keyword', 'menu_opcao')),
  trigger_valor VARCHAR(255) NOT NULL,
  transferir_historico BOOLEAN DEFAULT true,
  ativo BOOLEAN DEFAULT true,
  criado_em TIMESTAMPTZ DEFAULT NOW()
);

-- 16. CONVERSAS
CREATE TABLE IF NOT EXISTS conversas (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id UUID NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  inbox_id UUID REFERENCES inboxes(id),
  conversation_id_chatwoot INTEGER,
  contato_whatsapp VARCHAR(20),
  agente_id UUID REFERENCES agentes(id),
  agente_inicial_id UUID REFERENCES agentes(id),
  historico_agentes_json JSONB DEFAULT '[]',
  controlado_por VARCHAR(10) DEFAULT 'ia' CHECK (controlado_por IN ('ia', 'humano')),
  humano_id UUID REFERENCES usuarios(id),
  humano_nome VARCHAR(255),
  humano_assumiu_em TIMESTAMPTZ,
  humano_devolveu_em TIMESTAMPTZ,
  humano_ultima_msg_em TIMESTAMPTZ,
  status VARCHAR(20) DEFAULT 'ativo' CHECK (status IN ('ativo', 'finalizado', 'timeout')),
  dados_json JSONB DEFAULT '{}',
  criado_em TIMESTAMPTZ DEFAULT NOW(),
  atualizado_em TIMESTAMPTZ DEFAULT NOW()
);

-- 17. ATENDIMENTOS
CREATE TABLE IF NOT EXISTS atendimentos (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id UUID NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  agente_id UUID NOT NULL REFERENCES agentes(id) ON DELETE CASCADE,
  conversa_id UUID REFERENCES conversas(id) ON DELETE CASCADE,
  conversation_id_chatwoot INTEGER,
  status VARCHAR(20) DEFAULT 'ativo' CHECK (status IN ('ativo', 'finalizado', 'timeout')),
  iniciado_em TIMESTAMPTZ DEFAULT NOW(),
  finalizado_em TIMESTAMPTZ,
  total_mensagens INTEGER DEFAULT 0,
  protocolo VARCHAR(50),
  criado_em TIMESTAMPTZ DEFAULT NOW()
);

-- 18. MENSAGENS LOG
CREATE TABLE IF NOT EXISTS mensagens_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversa_id UUID REFERENCES conversas(id) ON DELETE CASCADE,
  empresa_id UUID NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  direcao VARCHAR(10) NOT NULL CHECK (direcao IN ('entrada', 'saida')),
  conteudo TEXT,
  tokens_input INTEGER DEFAULT 0,
  tokens_output INTEGER DEFAULT 0,
  tools_invocadas_json JSONB,
  modelo_usado VARCHAR(50),
  api_key_usada_id UUID REFERENCES api_keys(id),
  latencia_ms INTEGER,
  erro TEXT,
  criado_em TIMESTAMPTZ DEFAULT NOW()
);

-- 19. USO DIARIO AGENTE
CREATE TABLE IF NOT EXISTS uso_diario_agente (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id UUID NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  agente_id UUID NOT NULL REFERENCES agentes(id) ON DELETE CASCADE,
  data DATE NOT NULL DEFAULT CURRENT_DATE,
  total_atendimentos INTEGER DEFAULT 0,
  limite_diario INTEGER NOT NULL,
  limite_atingido BOOLEAN DEFAULT false,
  criado_em TIMESTAMPTZ DEFAULT NOW(),
  atualizado_em TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(empresa_id, agente_id, data)
);

-- 20. USO MENSAL
CREATE TABLE IF NOT EXISTS uso_mensal (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id UUID NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  ano_mes VARCHAR(7) NOT NULL,
  total_mensagens INTEGER DEFAULT 0,
  total_tokens_input BIGINT DEFAULT 0,
  total_tokens_output BIGINT DEFAULT 0,
  total_tool_calls INTEGER DEFAULT 0,
  atualizado_em TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(empresa_id, ano_mes)
);

-- 21. CONTROLE HISTORICO
CREATE TABLE IF NOT EXISTS controle_historico (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversa_id UUID NOT NULL REFERENCES conversas(id) ON DELETE CASCADE,
  empresa_id UUID NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  acao VARCHAR(50) NOT NULL CHECK (acao IN ('humano_assumiu', 'humano_devolveu', 'timeout_ia_reassumiu', 'admin_forcou')),
  de_controlador VARCHAR(10) NOT NULL,
  para_controlador VARCHAR(10) NOT NULL,
  humano_id UUID REFERENCES usuarios(id),
  humano_nome VARCHAR(255),
  motivo VARCHAR(100),
  criado_em TIMESTAMPTZ DEFAULT NOW()
);

-- 22. CONFIG CONTROLE HUMANO
CREATE TABLE IF NOT EXISTS config_controle_humano (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id UUID UNIQUE NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  timeout_inatividade_minutos INTEGER DEFAULT 30,
  mensagem_retorno_ia TEXT DEFAULT 'Voltei! Desculpe a espera. Como posso ajudar? 😊',
  permitir_devolver_via_nota BOOLEAN DEFAULT true,
  comando_assumir VARCHAR(50) DEFAULT '/assumir',
  comando_devolver VARCHAR(50) DEFAULT '/devolver',
  notificar_admin_ao_assumir BOOLEAN DEFAULT true,
  notificar_admin_ao_devolver BOOLEAN DEFAULT true,
  ativo BOOLEAN DEFAULT true,
  criado_em TIMESTAMPTZ DEFAULT NOW()
);

-- 23. FATURAS
CREATE TABLE IF NOT EXISTS faturas (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id UUID NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  assinatura_id UUID REFERENCES assinaturas(id),
  ano_mes VARCHAR(7) NOT NULL,
  valor_plano_base DECIMAL(10,2) DEFAULT 0,
  valor_itens DECIMAL(10,2) DEFAULT 0,
  valor_total DECIMAL(10,2) DEFAULT 0,
  desconto DECIMAL(10,2) DEFAULT 0,
  valor_final DECIMAL(10,2) DEFAULT 0,
  status VARCHAR(20) DEFAULT 'pendente' CHECK (status IN ('pendente', 'paga', 'atrasada', 'cancelada')),
  data_vencimento DATE,
  data_pagamento DATE,
  detalhes_json JSONB,
  criado_em TIMESTAMPTZ DEFAULT NOW()
);

-- 24. NOTIFICACOES
CREATE TABLE IF NOT EXISTS notificacoes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id UUID NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  tipo VARCHAR(50) NOT NULL,
  titulo VARCHAR(255) NOT NULL,
  mensagem TEXT NOT NULL,
  severidade VARCHAR(20) DEFAULT 'info' CHECK (severidade IN ('info', 'warning', 'critical')),
  lida BOOLEAN DEFAULT false,
  criado_em TIMESTAMPTZ DEFAULT NOW()
);

-- 25. ASSINATURA HISTORICO
CREATE TABLE IF NOT EXISTS assinatura_historico (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  assinatura_id UUID NOT NULL REFERENCES assinaturas(id) ON DELETE CASCADE,
  empresa_id UUID NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  acao VARCHAR(50) NOT NULL CHECK (acao IN ('adicionou_item', 'removeu_item', 'alterou_quantidade', 'mudou_plano', 'mudou_faixa', 'desconto_aplicado')),
  item_cobravel_id UUID REFERENCES itens_cobraveis(id),
  quantidade_anterior INTEGER,
  quantidade_nova INTEGER,
  preco_anterior DECIMAL(10,2),
  preco_novo DECIMAL(10,2),
  motivo TEXT,
  executado_por UUID REFERENCES usuarios(id),
  criado_em TIMESTAMPTZ DEFAULT NOW()
);

-- 26. ALERTAS CONFIG
CREATE TABLE IF NOT EXISTS alertas_config (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id UUID REFERENCES empresas(id) ON DELETE CASCADE,
  tipo VARCHAR(50) NOT NULL,
  percentual INTEGER NOT NULL,
  notificar_master BOOLEAN DEFAULT true,
  notificar_admin BOOLEAN DEFAULT true,
  mensagem_custom TEXT,
  ativo BOOLEAN DEFAULT true,
  criado_em TIMESTAMPTZ DEFAULT NOW()
);

-- Create all indexes
CREATE INDEX idx_planos_ativo ON planos(ativo);
CREATE INDEX idx_itens_cobraveis_slug ON itens_cobraveis(slug);
CREATE INDEX idx_itens_cobraveis_ativo ON itens_cobraveis(ativo);
CREATE INDEX idx_faixas_item_cobravel_id ON faixas_item(item_cobravel_id);
CREATE INDEX idx_empresas_slug ON empresas(slug);
CREATE INDEX idx_empresas_plano_id ON empresas(plano_id);
CREATE INDEX idx_empresas_ativo ON empresas(ativo);
CREATE INDEX idx_usuarios_empresa_id ON usuarios(empresa_id);
CREATE INDEX idx_usuarios_email ON usuarios(email);
CREATE INDEX idx_api_keys_empresa_id ON api_keys(empresa_id);
CREATE INDEX idx_api_keys_empresa_status_prioridade ON api_keys(empresa_id, status, prioridade);
CREATE INDEX idx_assinaturas_empresa_id ON assinaturas(empresa_id);
CREATE INDEX idx_assinatura_itens_empresa_id ON assinatura_itens(empresa_id);
CREATE INDEX idx_assinatura_itens_assinatura_id ON assinatura_itens(assinatura_id);
CREATE INDEX idx_assinatura_historico_empresa_id ON assinatura_historico(empresa_id);
CREATE INDEX idx_faturas_empresa_ano_mes ON faturas(empresa_id, ano_mes);
CREATE INDEX idx_notificacoes_empresa_lida ON notificacoes(empresa_id, lida);
CREATE INDEX idx_inboxes_empresa_id ON inboxes(empresa_id);
CREATE INDEX idx_inboxes_empresa_chatwoot ON inboxes(empresa_id, inbox_id_chatwoot);
CREATE INDEX idx_whatsapp_numbers_empresa_id ON whatsapp_numbers(empresa_id);
CREATE INDEX idx_whatsapp_numbers_phone_id ON whatsapp_numbers(phone_number_id);
CREATE INDEX idx_agentes_empresa_id ON agentes(empresa_id);
CREATE INDEX idx_prompts_agente_ativo ON prompts(agente_id, ativo);
CREATE INDEX idx_tools_empresa_id ON tools(empresa_id);
CREATE INDEX idx_agente_tools_agente_id ON agente_tools(agente_id);
CREATE INDEX idx_agente_transferencias_empresa_origem ON agente_transferencias(empresa_id, agente_origem_id);
CREATE INDEX idx_conversas_empresa_status ON conversas(empresa_id, status);
CREATE INDEX idx_conversas_conversation_chatwoot ON conversas(conversation_id_chatwoot);
CREATE INDEX idx_conversas_empresa_controlador ON conversas(empresa_id, controlado_por);
CREATE INDEX idx_atendimentos_empresa_agente ON atendimentos(empresa_id, agente_id);
CREATE INDEX idx_atendimentos_empresa_status ON atendimentos(empresa_id, status);
CREATE INDEX idx_mensagens_log_empresa_criado ON mensagens_log(empresa_id, criado_em DESC);
CREATE INDEX idx_mensagens_log_conversa_id ON mensagens_log(conversa_id);
CREATE INDEX idx_uso_diario_agente_empresa_data ON uso_diario_agente(empresa_id, data);
CREATE INDEX idx_uso_mensal_empresa_ano_mes ON uso_mensal(empresa_id, ano_mes);
CREATE INDEX idx_controle_historico_conversa ON controle_historico(conversa_id);
CREATE INDEX idx_controle_historico_empresa ON controle_historico(empresa_id);

-- Create triggers for updated_at
CREATE TRIGGER update_planos_updated_at BEFORE UPDATE ON planos
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_empresas_updated_at BEFORE UPDATE ON empresas
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_api_keys_updated_at BEFORE UPDATE ON api_keys
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_assinaturas_updated_at BEFORE UPDATE ON assinaturas
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_agentes_updated_at BEFORE UPDATE ON agentes
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_tools_updated_at BEFORE UPDATE ON tools
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_conversas_updated_at BEFORE UPDATE ON conversas
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_uso_diario_agente_updated_at BEFORE UPDATE ON uso_diario_agente
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Table for tracking migrations
CREATE TABLE IF NOT EXISTS _migrations (
  id SERIAL PRIMARY KEY,
  name VARCHAR(255) NOT NULL UNIQUE,
  executed_at TIMESTAMPTZ DEFAULT NOW()
);