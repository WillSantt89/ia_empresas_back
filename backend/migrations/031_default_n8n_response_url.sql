-- Migration 031: Definir default para n8n_response_url em novas empresas

-- UP
ALTER TABLE empresas
  ALTER COLUMN n8n_response_url SET DEFAULT 'http://santanacred_n8n-webhook:5678/webhook/api_responde_mensagem_whatsapp';

-- DOWN
ALTER TABLE empresas
  ALTER COLUMN n8n_response_url DROP DEFAULT;
