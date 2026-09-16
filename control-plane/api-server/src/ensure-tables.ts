import { getPool } from "@e-gaop/shared";
import pino from "pino";

const logger = pino({ level: process.env.LOG_LEVEL || "info" });

export async function ensureTables(): Promise<void> {
  const pool = await getPool();

  await pool.query(`
    CREATE TABLE IF NOT EXISTS notification_channels (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT NOT NULL CHECK (type IN ('webhook', 'email', 'slack', 'pagerduty')),
      config JSONB NOT NULL DEFAULT '{}',
      active BOOLEAN NOT NULL DEFAULT true,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS notification_rules (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT DEFAULT '',
      condition JSONB NOT NULL DEFAULT '{}',
      channel_id TEXT NOT NULL REFERENCES notification_channels(id) ON DELETE CASCADE,
      enabled BOOLEAN NOT NULL DEFAULT true,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS webhook_deliveries (
      id TEXT PRIMARY KEY,
      channel_id TEXT NOT NULL REFERENCES notification_channels(id) ON DELETE CASCADE,
      url TEXT NOT NULL,
      payload JSONB NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'delivered', 'failed', 'retrying')),
      attempts INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL DEFAULT 5,
      next_retry_at TIMESTAMPTZ,
      last_error TEXT,
      response_code INTEGER,
      response_time_ms INTEGER,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      delivered_at TIMESTAMPTZ
    );

    CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_status
      ON webhook_deliveries (status, next_retry_at)
      WHERE status IN ('pending', 'retrying');

    CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_channel
      ON webhook_deliveries (channel_id, status);

    CREATE TABLE IF NOT EXISTS policies (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      description TEXT DEFAULT '',
      type TEXT NOT NULL CHECK (type IN ('rate_limit', 'access_control', 'content_filter', 'cost_control', 'custom')),
      config JSONB NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('active', 'inactive', 'draft')),
      version INTEGER NOT NULL DEFAULT 1,
      created_by TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS llm_usage (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      model VARCHAR(255) NOT NULL,
      namespace VARCHAR(255) NOT NULL,
      agent_id VARCHAR(255) NOT NULL,
      execution_id VARCHAR(255),
      prompt_tokens INT NOT NULL DEFAULT 0,
      completion_tokens INT NOT NULL DEFAULT 0,
      total_tokens INT NOT NULL DEFAULT 0,
      cost_usd NUMERIC(12,8) NOT NULL DEFAULT 0,
      latency_ms INT NOT NULL DEFAULT 0,
      success BOOLEAN NOT NULL DEFAULT true,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_llm_usage_created_at ON llm_usage (created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_llm_usage_model ON llm_usage (model, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_llm_usage_namespace ON llm_usage (namespace, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_llm_usage_agent ON llm_usage (agent_id, created_at DESC);
  `);

  logger.info("Notification, policy, and analytics tables ensured");
}
