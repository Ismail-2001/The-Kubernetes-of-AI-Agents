import crypto from "crypto";
import pino from "pino";
import { getPool } from "../db.js";

const logger = pino({ level: process.env.LOG_LEVEL || "info" });

export interface RetentionConfig {
  auditLogDays: number;
  refreshTokenDays: number;
  spanDays: number;
}

export const DEFAULT_RETENTION_CONFIG: RetentionConfig = {
  auditLogDays: 90,
  refreshTokenDays: 30,
  spanDays: 30,
};

export async function purgeAuditEntries(maxAgeDays: number): Promise<number> {
  const pool = await getPool();
  try {
    const result = await pool.query(
      `DELETE FROM audit_entries WHERE timestamp < NOW() - ($1 || ' days')::interval`,
      [maxAgeDays],
    );
    const count = result.rowCount ?? 0;
    logger.info({ deletedCount: count, maxAgeDays }, "Purged audit entries");
    return count;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err: message, maxAgeDays }, "Failed to purge audit entries");
    return 0;
  }
}

export async function purgeExpiredRefreshTokens(): Promise<number> {
  const pool = await getPool();
  try {
    const result = await pool.query(
      `DELETE FROM refresh_tokens WHERE expires_at < NOW()`,
    );
    const count = result.rowCount ?? 0;
    logger.info({ deletedCount: count }, "Purged expired refresh tokens");
    return count;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err: message }, "Failed to purge expired refresh tokens");
    return 0;
  }
}

export async function anonymizeUser(userId: string): Promise<boolean> {
  const pool = await getPool();
  try {
    const hash = crypto.createHash("sha256").update(userId).digest("hex").slice(0, 12);
    const anonymizedEmail = `anonymized-${hash}@deleted.local`;

    const result = await pool.query(
      `UPDATE users
       SET email = $1,
           name = 'Deleted User',
           password_hash = ''
       WHERE id = $2`,
      [anonymizedEmail, userId],
    );

    const updated = (result.rowCount ?? 0) > 0;
    if (updated) {
      logger.info({ userId, anonymizedEmail }, "Anonymized user");
    } else {
      logger.warn({ userId }, "User not found for anonymization");
    }
    return updated;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err: message, userId }, "Failed to anonymize user");
    return false;
  }
}

export async function purgeExpiredSpans(maxAgeDays: number): Promise<number> {
  const pool = await getPool();
  try {
    const result = await pool.query(
      `DELETE FROM spans WHERE start_time < NOW() - ($1 || ' days')::interval`,
      [maxAgeDays],
    );
    const count = result.rowCount ?? 0;
    logger.info({ deletedCount: count, maxAgeDays }, "Purged expired spans");
    return count;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err: message, maxAgeDays }, "Failed to purge expired spans");
    return 0;
  }
}

export interface RetentionStats {
  auditEntriesEligible: number;
  expiredRefreshTokens: number;
  spansEligible: number;
}

export async function getRetentionStats(): Promise<RetentionStats> {
  const pool = await getPool();
  const stats: RetentionStats = {
    auditEntriesEligible: 0,
    expiredRefreshTokens: 0,
    spansEligible: 0,
  };

  try {
    const [auditResult, tokenResult, spanResult] = await Promise.all([
      pool.query(
        `SELECT COUNT(*)::int AS count FROM audit_entries WHERE timestamp < NOW() - INTERVAL '90 days'`,
      ),
      pool.query(
        `SELECT COUNT(*)::int AS count FROM refresh_tokens WHERE expires_at < NOW()`,
      ),
      pool.query(
        `SELECT COUNT(*)::int AS count FROM spans WHERE start_time < NOW() - INTERVAL '30 days'`,
      ),
    ]);

    stats.auditEntriesEligible = auditResult.rows[0]?.count ?? 0;
    stats.expiredRefreshTokens = tokenResult.rows[0]?.count ?? 0;
    stats.spansEligible = spanResult.rows[0]?.count ?? 0;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err: message }, "Failed to fetch retention stats");
  }

  logger.info({ stats }, "Retention stats fetched");
  return stats;
}

export interface RetentionCleanupSummary {
  auditEntriesDeleted: number;
  refreshTokensDeleted: number;
  spansDeleted: number;
  totalDeleted: number;
  timestamp: string;
}

export async function runRetentionCleanup(
  config: RetentionConfig = DEFAULT_RETENTION_CONFIG,
): Promise<RetentionCleanupSummary> {
  logger.info({ config }, "Starting retention cleanup");

  const [auditEntriesDeleted, refreshTokensDeleted, spansDeleted] =
    await Promise.all([
      purgeAuditEntries(config.auditLogDays),
      purgeExpiredRefreshTokens(),
      purgeExpiredSpans(config.spanDays),
    ]);

  const summary: RetentionCleanupSummary = {
    auditEntriesDeleted,
    refreshTokensDeleted,
    spansDeleted,
    totalDeleted: auditEntriesDeleted + refreshTokensDeleted + spansDeleted,
    timestamp: new Date().toISOString(),
  };

  logger.info({ summary }, "Retention cleanup completed");
  return summary;
}
