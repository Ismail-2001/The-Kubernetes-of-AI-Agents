-- Migration 001: Memory Plane
-- Creates agent_memory table with pgvector embedding support

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS agent_memory (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    namespace VARCHAR(255) NOT NULL,
    agent_id VARCHAR(255) NOT NULL,
    key VARCHAR(512) NOT NULL,
    value JSONB NOT NULL,
    embedding vector(1536),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    expires_at TIMESTAMPTZ
);

-- Unique index on namespace + agent_id + key
CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_memory_namespace_agent_key
    ON agent_memory (namespace, agent_id, key);

-- ANN index for cosine similarity on embeddings is intentionally omitted here.
-- ivfflat/hnsw require AVX2 CPU instructions; on AVX-less VMs the CREATE INDEX
-- crashes the backend with SIGILL (uncatchable). Create it manually on
-- production hardware: CREATE INDEX idx_agent_memory_embedding ON agent_memory
-- USING hnsw (embedding vector_cosine_ops);

-- Index for expired entry cleanup
CREATE INDEX IF NOT EXISTS idx_agent_memory_expires_at
    ON agent_memory (expires_at)
    WHERE expires_at IS NOT NULL;

-- Index for listing by namespace + agent_id
CREATE INDEX IF NOT EXISTS idx_agent_memory_namespace_agent
    ON agent_memory (namespace, agent_id);
