-- UP
-- Migration 060: Adicionar acao 'reaberta' ao controle_historico

ALTER TABLE controle_historico DROP CONSTRAINT IF EXISTS controle_historico_acao_check;
ALTER TABLE controle_historico ADD CONSTRAINT controle_historico_acao_check
  CHECK (acao IN (
    'humano_assumiu', 'humano_devolveu', 'timeout_ia_reassumiu', 'admin_forcou',
    'operador_assumiu', 'desatribuido', 'transferencia_fila', 'auto_assignment',
    'transferencia_agente', 'transferencia_operador', 'finalizado', 'criada_manual',
    'reaberta'
  ));
