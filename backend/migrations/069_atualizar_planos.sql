-- Migration 069: Adicionar campo de créditos IA nos planos + novos planos e itens cobráveis

-- Adicionar coluna de créditos mensais ao plano
ALTER TABLE planos ADD COLUMN IF NOT EXISTS creditos_ia_mensal INTEGER NOT NULL DEFAULT 0;

-- Adicionar coluna max_agentes ao plano
ALTER TABLE planos ADD COLUMN IF NOT EXISTS max_agentes INTEGER NOT NULL DEFAULT 0;

-- Adicionar coluna max_conexoes_whatsapp ao plano
ALTER TABLE planos ADD COLUMN IF NOT EXISTS max_conexoes_whatsapp INTEGER NOT NULL DEFAULT 0;

-- Adicionar coluna chatbot_incluso ao plano
ALTER TABLE planos ADD COLUMN IF NOT EXISTS chatbot_incluso BOOLEAN NOT NULL DEFAULT false;

-- Adicionar coluna tipo (chat, ia, trafego) para categorizar
ALTER TABLE planos ADD COLUMN IF NOT EXISTS tipo VARCHAR(20) NOT NULL DEFAULT 'ia';

-- Desativar planos antigos
UPDATE planos SET ativo = false WHERE nome IN ('Starter', 'Pro', 'Enterprise');

-- Inserir novos planos
INSERT INTO planos (nome, descricao, preco_base_mensal, max_usuarios, max_tools, max_mensagens_mes, permite_modelo_pro, creditos_ia_mensal, max_agentes, max_conexoes_whatsapp, chatbot_incluso, tipo)
VALUES
  ('Chat', 'Plano básico de chat humano', 200.00, 2, 0, 0, false, 0, 0, 1, false, 'chat'),
  ('IA Starter', 'Plano IA com 15.000 créditos mensais', 500.00, 2, 10, 0, false, 15000, 2, 1, true, 'ia'),
  ('IA Pro', 'Plano IA profissional com 45.000 créditos mensais', 1000.00, 5, 20, 0, true, 45000, 2, 1, true, 'ia'),
  ('Tráfego Start', 'Gestão de tráfego pago - inicial', 1500.00, 2, 0, 0, false, 0, 0, 0, false, 'trafego'),
  ('Tráfego Médio', 'Gestão de tráfego pago - médio', 3000.00, 2, 0, 0, false, 0, 0, 0, false, 'trafego'),
  ('Tráfego Pro', 'Gestão de tráfego pago - profissional', 5000.00, 2, 0, 0, false, 0, 0, 0, false, 'trafego')
ON CONFLICT DO NOTHING;

-- Inserir novos itens cobráveis
INSERT INTO itens_cobraveis (slug, nome, descricao, tipo_cobranca, preco_fixo)
VALUES
  ('conexao_whatsapp', 'Conexão WhatsApp Adicional', 'Conexão WhatsApp Business adicional', 'preco_fixo', 50.00),
  ('usuario_adicional', 'Usuário Adicional', 'Usuário adicional na plataforma', 'preco_fixo', 30.00),
  ('numero_fixo_digital', 'Número Fixo Digital', 'Número fixo digital (DID)', 'preco_fixo', 30.00),
  ('agente_adicional_starter', 'Agente IA Adicional (Starter)', 'Agente IA adicional com 15.000 créditos', 'preco_fixo', 500.00),
  ('agente_adicional_pro', 'Agente IA Adicional (Pro)', 'Agente IA adicional com 45.000 créditos', 'preco_fixo', 1000.00)
ON CONFLICT (slug) DO UPDATE SET
  nome = EXCLUDED.nome,
  descricao = EXCLUDED.descricao,
  preco_fixo = EXCLUDED.preco_fixo;
