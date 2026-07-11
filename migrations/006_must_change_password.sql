-- Migration 006: Add must_change_password flag
-- Generated credentials (first-boot admin) force rotation on first login.

ALTER TABLE users ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN NOT NULL DEFAULT false;
