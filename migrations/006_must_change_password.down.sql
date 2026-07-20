-- Migration 006 rollback: must_change_password
ALTER TABLE users DROP COLUMN IF EXISTS must_change_password;
