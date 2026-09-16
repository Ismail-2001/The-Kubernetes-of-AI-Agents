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
  `);

  logger.info("Notification and policy tables ensured");
}
