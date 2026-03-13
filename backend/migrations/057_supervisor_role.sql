-- Migration 057: Add supervisor role
-- Hierarchy: master → admin → supervisor → operador → viewer

-- Update the role CHECK constraint on usuarios table
ALTER TABLE usuarios DROP CONSTRAINT IF EXISTS usuarios_role_check;
ALTER TABLE usuarios ADD CONSTRAINT usuarios_role_check
  CHECK (role IN ('master', 'admin', 'supervisor', 'operador', 'viewer'));
