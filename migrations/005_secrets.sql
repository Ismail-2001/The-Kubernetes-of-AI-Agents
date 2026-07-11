-- Migration 005: Secrets (durable secret-store backend)
-- Replaces in-memory Map with PostgreSQL-backed encrypted blob storage.

CREATE TABLE IF NOT EXISTS secrets (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    namespace VARCHAR(255) NOT NULL,
    name VARCHAR(255) NOT NULL,
    encrypted_data TEXT NOT NULL,
    type VARCHAR(100) NOT NULL DEFAULT 'api_key',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(namespace, name)
);

-- Unique lookup by namespace + name
CREATE INDEX IF NOT EXISTS idx_secrets_namespace_name
    ON secrets (namespace, name);

-- Fast listing by namespace
CREATE INDEX IF NOT EXISTS idx_secrets_namespace
    ON secrets (namespace);
