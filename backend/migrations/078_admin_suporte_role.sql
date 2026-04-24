-- Migration 078: Adicionar role admin_suporte + backfill
--
-- Hierarquia: master → admin_suporte → admin → supervisor → operador → viewer
--
-- admin_suporte = perfil interno wschat com acesso técnico em CADA empresa.
-- Email padrão por empresa: suportemaster+{slug}@wschat.com.br
-- Senha padrão (igual em todas): WSChat@Suporte2026!  (bcrypt cost 10)
-- Esse usuário só pode ser editado/excluído por master.

-- 1. Atualiza CHECK do role pra incluir admin_suporte
ALTER TABLE usuarios DROP CONSTRAINT IF EXISTS usuarios_role_check;
ALTER TABLE usuarios ADD CONSTRAINT usuarios_role_check
  CHECK (role IN ('master', 'admin_suporte', 'admin', 'supervisor', 'operador', 'viewer'));

-- 2. Backfill: cria 1 admin_suporte default por empresa que ainda não tem
--    (idempotente — re-rodar não duplica nem sobrescreve senha)
INSERT INTO usuarios (id, empresa_id, nome, email, senha_hash, role, ativo, criado_em)
SELECT
  gen_random_uuid(),
  e.id,
  'Suporte WSChat',
  'suportemaster+' || e.slug || '@wschat.com.br',
  '$2b$10$krvwyIrWH1s99knMGK0AWOLs7CKG4x8rcrZ3yCkxYUBqMVhHeEtF2',  -- bcrypt('WSChat@Suporte2026!')
  'admin_suporte',
  true,
  NOW()
FROM empresas e
WHERE NOT EXISTS (
  SELECT 1 FROM usuarios u
  WHERE u.empresa_id = e.id AND u.role = 'admin_suporte'
);

-- 3. Index para busca rápida por (empresa_id, role) — usado pra checar duplicatas
CREATE INDEX IF NOT EXISTS idx_usuarios_empresa_role
  ON usuarios(empresa_id, role);
