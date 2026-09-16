-- 009_audit_entries.sql
-- Create audit_entries table matching the schema in packages/shared/src/audit/index.ts
-- Migration 003 created audit_log (different schema). This migration creates the
-- audit_entries table that the application code actually writes to.

CREATE TABLE IF NOT EXISTS audit_entries (
    event_id UUID PRIMARY KEY,
    event_type VARCHAR(100) NOT NULL,
    severity VARCHAR(20) NOT NULL CHECK (severity IN ('info', 'warn', 'error', 'critical')),
    actor JSONB NOT NULL,
    target JSONB,
    action JSONB NOT NULL,
    context JSONB NOT NULL DEFAULT '{}',
    integrity JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_entries_event_type ON audit_entries (event_type);
CREATE INDEX IF NOT EXISTS idx_audit_entries_severity ON audit_entries (severity);
CREATE INDEX IF NOT EXISTS idx_audit_entries_created_at ON audit_entries (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_entries_actor ON audit_entries USING GIN (actor);

-- Prevent updates/deletes on audit_entries (append-only enforcement)
CREATE OR REPLACE FUNCTION prevent_audit_entries_modification()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'audit_entries is append-only: updates and deletes are not permitted';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_prevent_audit_entries_update ON audit_entries;
CREATE TRIGGER trg_prevent_audit_entries_update
    BEFORE UPDATE OR DELETE ON audit_entries
    FOR EACH ROW
    EXECUTE FUNCTION prevent_audit_entries_modification();
