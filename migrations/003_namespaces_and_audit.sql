-- 003_namespaces_and_audit.sql
-- Multi-tenancy: namespaces, agents namespace column, audit_log

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Namespaces table
CREATE TABLE IF NOT EXISTS namespaces (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    slug VARCHAR(63) NOT NULL UNIQUE,
    display_name VARCHAR(255) NOT NULL,
    tier VARCHAR(20) NOT NULL CHECK (tier IN ('sandbox', 'standard', 'enterprise')),
    owner_id UUID NOT NULL,
    max_agents INT NOT NULL DEFAULT 5,
    max_concurrent_executions INT NOT NULL DEFAULT 2,
    max_memory_mb INT NOT NULL DEFAULT 512,
    max_tool_calls_per_minute INT NOT NULL DEFAULT 30,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    suspended_at TIMESTAMPTZ,
    deleted_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_namespaces_slug ON namespaces (slug) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_namespaces_owner_id ON namespaces (owner_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_namespaces_tier ON namespaces (tier) WHERE deleted_at IS NULL;

-- Add namespace column to agents table (if it doesn't exist)
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'agents' AND column_name = 'namespace'
    ) THEN
        CREATE TABLE IF NOT EXISTS agents (
            id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
            namespace VARCHAR(63) NOT NULL,
            name VARCHAR(255) NOT NULL,
            api_version VARCHAR(50) NOT NULL DEFAULT 'egaop.io/v1',
            kind VARCHAR(50) NOT NULL DEFAULT 'Agent',
            spec JSONB NOT NULL DEFAULT '{}',
            status JSONB NOT NULL DEFAULT '{}',
            labels JSONB NOT NULL DEFAULT '{}',
            annotations JSONB NOT NULL DEFAULT '{}',
            version INT NOT NULL DEFAULT 1,
            created_by VARCHAR(255),
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            deleted_at TIMESTAMPTZ
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_agents_namespace_name
            ON agents (namespace, name) WHERE deleted_at IS NULL;
        CREATE INDEX IF NOT EXISTS idx_agents_namespace_phase
            ON agents (namespace, (status->>'phase')) WHERE deleted_at IS NULL;
    END IF;
END $$;

-- Audit log (append-only)
CREATE TABLE IF NOT EXISTS audit_log (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    namespace_id UUID NOT NULL,
    actor_id UUID NOT NULL,
    action VARCHAR(50) NOT NULL,
    resource_type VARCHAR(100) NOT NULL,
    resource_id VARCHAR(255) NOT NULL,
    details JSONB NOT NULL DEFAULT '{}',
    timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_log_namespace_id ON audit_log (namespace_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_actor_id ON audit_log (actor_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_timestamp ON audit_log (timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_action ON audit_log (action);

-- Prevent updates/deletes on audit_log (append-only enforcement)
CREATE OR REPLACE FUNCTION prevent_audit_log_modification()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'audit_log is append-only: updates and deletes are not permitted';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_prevent_audit_log_update ON audit_log;
CREATE TRIGGER trg_prevent_audit_log_update
    BEFORE UPDATE OR DELETE ON audit_log
    FOR EACH ROW
    EXECUTE FUNCTION prevent_audit_log_modification();
