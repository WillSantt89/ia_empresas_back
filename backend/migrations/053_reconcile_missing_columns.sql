-- Migration 053: Reconciliar colunas faltantes no banco de produção
-- Garante que todas as colunas adicionadas por migrations anteriores existem

-- UP

-- From 027
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS reset_token_hash VARCHAR(255);
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS reset_token_expires TIMESTAMPTZ;

-- From 028
ALTER TABLE empresas ADD COLUMN IF NOT EXISTS webhook_token VARCHAR(64);
ALTER TABLE empresas ADD COLUMN IF NOT EXISTS n8n_response_url TEXT;

-- From 029
ALTER TABLE whatsapp_numbers ADD COLUMN IF NOT EXISTS verified_name VARCHAR(255);
ALTER TABLE whatsapp_numbers ADD COLUMN IF NOT EXISTS display_phone_number VARCHAR(30);
ALTER TABLE whatsapp_numbers ADD COLUMN IF NOT EXISTS quality_rating VARCHAR(20);
ALTER TABLE whatsapp_numbers ADD COLUMN IF NOT EXISTS name_status VARCHAR(30);
ALTER TABLE whatsapp_numbers ADD COLUMN IF NOT EXISTS messaging_limit_tier VARCHAR(50);
ALTER TABLE whatsapp_numbers ADD COLUMN IF NOT EXISTS platform_type VARCHAR(20);
ALTER TABLE whatsapp_numbers ADD COLUMN IF NOT EXISTS account_mode VARCHAR(20);
ALTER TABLE whatsapp_numbers ADD COLUMN IF NOT EXISTS verificacao_status VARCHAR(20) DEFAULT 'pendente';
ALTER TABLE whatsapp_numbers ADD COLUMN IF NOT EXISTS verificacao_erro TEXT;
ALTER TABLE whatsapp_numbers ADD COLUMN IF NOT EXISTS ultima_verificacao TIMESTAMPTZ;

-- From 030
ALTER TABLE conversacao_analytics ADD COLUMN IF NOT EXISTS iteracoes INTEGER DEFAULT 0;
ALTER TABLE conversacao_analytics ADD COLUMN IF NOT EXISTS modelo VARCHAR(100);

-- From 032
ALTER TABLE mensagens_log ADD COLUMN IF NOT EXISTS whatsapp_message_id VARCHAR(255);
CREATE INDEX IF NOT EXISTS idx_mensagens_log_wamid ON mensagens_log(whatsapp_message_id) WHERE whatsapp_message_id IS NOT NULL;

-- From 033
ALTER TABLE agentes ADD COLUMN IF NOT EXISTS cache_enabled BOOLEAN DEFAULT false;
ALTER TABLE agentes ADD COLUMN IF NOT EXISTS gemini_cache_id VARCHAR(255);
ALTER TABLE agentes ADD COLUMN IF NOT EXISTS cache_expires_at TIMESTAMPTZ;
ALTER TABLE agentes ADD COLUMN IF NOT EXISTS cache_api_key_id UUID REFERENCES api_keys(id);

-- From 034
ALTER TABLE conversas ADD COLUMN IF NOT EXISTS fila_id UUID REFERENCES filas_atendimento(id);
ALTER TABLE conversas ADD COLUMN IF NOT EXISTS fila_entrada_em TIMESTAMPTZ;
ALTER TABLE conversas ADD COLUMN IF NOT EXISTS operador_id UUID REFERENCES usuarios(id);
ALTER TABLE conversas ADD COLUMN IF NOT EXISTS operador_nome VARCHAR(255);
ALTER TABLE conversas ADD COLUMN IF NOT EXISTS operador_atribuido_em TIMESTAMPTZ;
ALTER TABLE conversas ADD COLUMN IF NOT EXISTS prioridade VARCHAR(10) DEFAULT 'none';
ALTER TABLE conversas ADD COLUMN IF NOT EXISTS snoozed_ate TIMESTAMPTZ;
ALTER TABLE conversas ADD COLUMN IF NOT EXISTS contato_nome VARCHAR(255);
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS disponibilidade VARCHAR(20) DEFAULT 'offline';
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS auto_offline BOOLEAN DEFAULT true;
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS max_conversas_simultaneas INTEGER DEFAULT 10;
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS ultima_atividade TIMESTAMPTZ;
ALTER TABLE mensagens_log ADD COLUMN IF NOT EXISTS status_entrega VARCHAR(20) DEFAULT 'sent';
ALTER TABLE mensagens_log ADD COLUMN IF NOT EXISTS remetente_tipo VARCHAR(20);
ALTER TABLE mensagens_log ADD COLUMN IF NOT EXISTS remetente_id UUID;
ALTER TABLE mensagens_log ADD COLUMN IF NOT EXISTS remetente_nome VARCHAR(255);

-- From 035
ALTER TABLE filas_atendimento ADD COLUMN IF NOT EXISTS is_default BOOLEAN DEFAULT false;

-- From 037
ALTER TABLE conversas ADD COLUMN IF NOT EXISTS contato_id UUID REFERENCES contatos(id);

-- From 038
ALTER TABLE whatsapp_numbers ADD COLUMN IF NOT EXISTS whatsapp_app_secret TEXT;

-- From 040
ALTER TABLE agentes ADD COLUMN IF NOT EXISTS mensagem_midia_nao_suportada TEXT DEFAULT NULL;

-- From 041
ALTER TABLE mensagens_log ADD COLUMN IF NOT EXISTS tipo_mensagem VARCHAR(20) DEFAULT 'text';

-- From 042
ALTER TABLE mensagens_log ADD COLUMN IF NOT EXISTS midia_url TEXT DEFAULT NULL;
ALTER TABLE mensagens_log ADD COLUMN IF NOT EXISTS midia_mime_type VARCHAR(100) DEFAULT NULL;
ALTER TABLE mensagens_log ADD COLUMN IF NOT EXISTS midia_nome_arquivo VARCHAR(255) DEFAULT NULL;
ALTER TABLE mensagens_log ADD COLUMN IF NOT EXISTS midia_tamanho_bytes INTEGER DEFAULT NULL;

-- From 043
ALTER TABLE conversas ADD COLUMN IF NOT EXISTS numero_ticket INTEGER;

-- From 044
ALTER TABLE conversas ADD COLUMN IF NOT EXISTS ultima_msg_entrada_em TIMESTAMPTZ;

-- From 045
ALTER TABLE conversas ADD COLUMN IF NOT EXISTS whatsapp_number_id UUID REFERENCES whatsapp_numbers(id) ON DELETE SET NULL;

-- From 046
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS api_key_hash VARCHAR(64);

-- From 047
ALTER TABLE agentes ADD COLUMN IF NOT EXISTS fila_id UUID REFERENCES filas_atendimento(id) ON DELETE SET NULL;
ALTER TABLE agentes ADD COLUMN IF NOT EXISTS is_triagem BOOLEAN DEFAULT false;
ALTER TABLE tools ADD COLUMN IF NOT EXISTS tipo_tool VARCHAR(20) DEFAULT 'http';
ALTER TABLE tools ADD COLUMN IF NOT EXISTS agente_destino_id UUID REFERENCES agentes(id) ON DELETE CASCADE;

-- From 048
ALTER TABLE tools ADD COLUMN IF NOT EXISTS fila_destino_id UUID REFERENCES filas_atendimento(id) ON DELETE CASCADE;

-- From 050
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS todos_agentes BOOLEAN NOT NULL DEFAULT false;
