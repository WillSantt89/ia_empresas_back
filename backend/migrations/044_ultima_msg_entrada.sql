-- Migration 044: Adicionar campo ultima_msg_entrada_em para validação janela 24h WhatsApp
-- UP

ALTER TABLE conversas ADD COLUMN IF NOT EXISTS ultima_msg_entrada_em TIMESTAMPTZ;

-- Backfill com a mensagem de entrada mais recente de cada conversa
UPDATE conversas c
SET ultima_msg_entrada_em = sub.ultima
FROM (
  SELECT conversa_id, MAX(criado_em) as ultima
  FROM mensagens_log
  WHERE direcao = 'entrada'
  GROUP BY conversa_id
) sub
WHERE c.id = sub.conversa_id AND c.ultima_msg_entrada_em IS NULL;

-- Trigger para atualizar automaticamente em cada nova mensagem de entrada
CREATE OR REPLACE FUNCTION update_ultima_msg_entrada()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.direcao = 'entrada' THEN
    UPDATE conversas SET ultima_msg_entrada_em = NEW.criado_em WHERE id = NEW.conversa_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_update_ultima_msg_entrada ON mensagens_log;
CREATE TRIGGER trg_update_ultima_msg_entrada
  AFTER INSERT ON mensagens_log
  FOR EACH ROW
  EXECUTE FUNCTION update_ultima_msg_entrada();

-- Índice para consultas
CREATE INDEX IF NOT EXISTS idx_conversas_ultima_msg_entrada ON conversas (ultima_msg_entrada_em);

-- DOWN
-- DROP TRIGGER IF EXISTS trg_update_ultima_msg_entrada ON mensagens_log;
-- DROP FUNCTION IF EXISTS update_ultima_msg_entrada();
-- ALTER TABLE conversas DROP COLUMN IF EXISTS ultima_msg_entrada_em;
