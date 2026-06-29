-- Migration 002: Observability Plane
-- Creates spans table (partitioned by range) and replay_sessions table

CREATE TABLE IF NOT EXISTS spans (
    trace_id VARCHAR(64) NOT NULL,
    span_id VARCHAR(32) PRIMARY KEY,
    parent_span_id VARCHAR(32),
    service_name VARCHAR(255) NOT NULL,
    operation_name VARCHAR(512) NOT NULL,
    namespace VARCHAR(255) NOT NULL,
    start_time TIMESTAMPTZ NOT NULL,
    end_time TIMESTAMPTZ,
    status VARCHAR(32) DEFAULT 'ok',
    attributes JSONB DEFAULT '{}',
    events JSONB DEFAULT '[]'
) PARTITION BY RANGE (start_time);

-- Create partitions for current and next 2 months
CREATE TABLE IF NOT EXISTS spans_2026_06 PARTITION OF spans
    FOR VALUES FROM ('2026-06-01') TO ('2026-07-01');

CREATE TABLE IF NOT EXISTS spans_2026_07 PARTITION OF spans
    FOR VALUES FROM ('2026-07-01') TO ('2026-08-01');

CREATE TABLE IF NOT EXISTS spans_2026_08 PARTITION OF spans
    FOR VALUES FROM ('2026-08-01') TO ('2026-09-01');

-- Index on trace_id for trace retrieval
CREATE INDEX IF NOT EXISTS idx_spans_trace_id
    ON spans (trace_id);

-- Composite index for namespace + time range queries (descending for recent-first)
CREATE INDEX IF NOT EXISTS idx_spans_namespace_start_time
    ON spans (namespace, start_time DESC);

-- Replay sessions table
CREATE TABLE IF NOT EXISTS replay_sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    trace_id VARCHAR(64) NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    metadata JSONB DEFAULT '{}'
);

-- Index on trace_id for replay session lookups
CREATE INDEX IF NOT EXISTS idx_replay_sessions_trace_id
    ON replay_sessions (trace_id);
