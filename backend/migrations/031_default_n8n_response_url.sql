-- Migration 031: Definir default para n8n_response_url em novas empresas

-- UP
ALTER TABLE empresas
  ALTER COLUMN n8n_response_url SET DEFAULT 'https://santanacred-n8n-webhook.fldxjw.easypanel.host/webhook/api_responde_mensagem_whatsapp';

-- DOWN
ALTER TABLE empresas
  ALTER COLUMN n8n_response_url DROP DEFAULT;
