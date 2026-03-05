-- Migration 039: Índices para escalabilidade (200 operadores, 15k atendimentos/dia)
-- Executar com CONCURRENTLY para não bloquear tabelas em produção

-- Conversas por empresa+status (usado em quase toda query de listagem)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_conversas_empresa_status
  ON conversas(empresa_id, status);

-- Operadores disponíveis (usado no round-robin de filas)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_usuarios_empresa_disponibilidade
  ON usuarios(empresa_id, disponibilidade) WHERE ativo = true;

-- Membros de fila (lookup rápido por fila+usuario)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_fila_membros_fila_usuario
  ON fila_membros(fila_id, usuario_id);

-- Mensagens por conversa ordenadas por data (listagem de chat)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_mensagens_log_conversa_criado
  ON mensagens_log(conversa_id, criado_em DESC);

-- Conversas por empresa+fila+status (listagem de fila)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_conversas_empresa_fila_status
  ON conversas(empresa_id, fila_id, status) WHERE fila_id IS NOT NULL;
