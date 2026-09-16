/*
  SQL for feature_flags table:

  CREATE TABLE IF NOT EXISTS feature_flags (
    name VARCHAR(128) PRIMARY KEY,
    enabled BOOLEAN DEFAULT false,
    description TEXT DEFAULT '',
    rollout_percentage INTEGER DEFAULT 0 CHECK (rollout_percentage >= 0 AND rollout_percentage <= 100),
    allowed_roles TEXT[] DEFAULT '{}',
    allowed_namespaces TEXT[] DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
  );
*/

import { getPool } from "../db.js";
import { createHash } from "crypto";

export interface FeatureFlag {
  name: string;
  enabled: boolean;
  description: string;
  rolloutPercentage: number;
  allowedRoles: string[];
  allowedNamespaces: string[];
  createdAt: string;
  updatedAt: string;
}

export interface FeatureFlagUpsert {
  name: string;
  enabled?: boolean;
  description?: string;
  rolloutPercentage?: number;
  allowedRoles?: string[];
  allowedNamespaces?: string[];
}

interface FeatureFlagRow {
  name: string;
  enabled: boolean;
  description: string;
  rollout_percentage: number;
  allowed_roles: string[];
  allowed_namespaces: string[];
  created_at: string;
  updated_at: string;
}

const cache: Map<string, FeatureFlag> = new Map();
let cacheTimer: ReturnType<typeof setInterval> | null = null;
let cacheTtlMs: number = parseInt(process.env.FEATURE_FLAG_CACHE_TTL_MS || "60000", 10);

function rowToFlag(row: FeatureFlagRow): FeatureFlag {
  return {
    name: row.name,
    enabled: row.enabled,
    description: row.description,
    rolloutPercentage: row.rollout_percentage,
    allowedRoles: row.allowed_roles,
    allowedNamespaces: row.allowed_namespaces,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function deterministicHash(flagName: string, userId: string): number {
  const hash = createHash("sha256")
    .update(`${flagName}:${userId}`)
    .digest("hex");
  return parseInt(hash.substring(0, 8), 16) % 100;
}

export function isEnabled(
  flagName: string,
  context?: { userId?: string; roles?: string[]; namespace?: string }
): boolean {
  const flag = cache.get(flagName);
  if (!flag) return false;
  if (!flag.enabled) return false;

  if (flag.rolloutPercentage === 100) {
    if (!checkAccess(flag, context)) return false;
    return true;
  }

  if (!context?.userId) return false;

  const hash = deterministicHash(flagName, context.userId);
  if (hash >= flag.rolloutPercentage) return false;

  if (!checkAccess(flag, context)) return false;

  return true;
}

function checkAccess(
  flag: FeatureFlag,
  context?: { userId?: string; roles?: string[]; namespace?: string }
): boolean {
  if (flag.allowedRoles.length > 0) {
    if (!context?.roles || !context.roles.some((r) => flag.allowedRoles.includes(r))) {
      return false;
    }
  }

  if (flag.allowedNamespaces.length > 0) {
    if (!context?.namespace || !flag.allowedNamespaces.includes(context.namespace)) {
      return false;
    }
  }

  return true;
}

export function getAllFlags(): FeatureFlag[] {
  return Array.from(cache.values());
}

export async function refreshFlags(): Promise<void> {
  try {
    const pool = await getPool();
    const result = await pool.query<FeatureFlagRow>(
      "SELECT name, enabled, description, rollout_percentage, allowed_roles, allowed_namespaces, created_at::text AS created_at, updated_at::text AS updated_at FROM feature_flags"
    );
    cache.clear();
    for (const row of result.rows) {
      cache.set(row.name, rowToFlag(row));
    }
  } catch {
    // degrade to existing cache
  }
}

export async function upsertFlag(input: FeatureFlagUpsert): Promise<FeatureFlag> {
  const pool = await getPool();
  const result = await pool.query<FeatureFlagRow>(
    `INSERT INTO feature_flags (name, enabled, description, rollout_percentage, allowed_roles, allowed_namespaces)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (name) DO UPDATE SET
       enabled = COALESCE(EXCLUDED.enabled, feature_flags.enabled),
       description = COALESCE(EXCLUDED.description, feature_flags.description),
       rollout_percentage = COALESCE(EXCLUDED.rollout_percentage, feature_flags.rollout_percentage),
       allowed_roles = COALESCE(EXCLUDED.allowed_roles, feature_flags.allowed_roles),
       allowed_namespaces = COALESCE(EXCLUDED.allowed_namespaces, feature_flags.allowed_namespaces),
       updated_at = NOW()
     RETURNING name, enabled, description, rollout_percentage, allowed_roles, allowed_namespaces, created_at::text AS created_at, updated_at::text AS updated_at`,
    [
      input.name,
      input.enabled ?? false,
      input.description ?? "",
      input.rolloutPercentage ?? 0,
      input.allowedRoles ?? [],
      input.allowedNamespaces ?? [],
    ]
  );

  const row = result.rows[0];
  if (!row) {
    throw new Error(`Upsert of flag "${input.name}" returned no rows`);
  }
  const flag = rowToFlag(row);
  cache.set(flag.name, flag);
  return flag;
}

export async function deleteFlag(flagName: string): Promise<void> {
  const pool = await getPool();
  await pool.query("DELETE FROM feature_flags WHERE name = $1", [flagName]);
  cache.delete(flagName);
}

export async function getFlag(flagName: string): Promise<FeatureFlag | null> {
  const pool = await getPool();
  const result = await pool.query<FeatureFlagRow>(
    `SELECT name, enabled, description, rollout_percentage, allowed_roles, allowed_namespaces, created_at::text AS created_at, updated_at::text AS updated_at
     FROM feature_flags WHERE name = $1`,
    [flagName]
  );
  return result.rows[0] ? rowToFlag(result.rows[0]) : null;
}

export function startCacheAutoRefresh(): void {
  if (cacheTimer) return;
  refreshFlags();
  cacheTimer = setInterval(() => {
    void refreshFlags();
  }, cacheTtlMs);
}

export function stopCacheAutoRefresh(): void {
  if (cacheTimer) {
    clearInterval(cacheTimer);
    cacheTimer = null;
  }
}

export function setCacheTtl(ms: number): void {
  cacheTtlMs = ms;
}
