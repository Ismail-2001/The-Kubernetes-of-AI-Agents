import pino from "pino";
import { getPool } from "../db.js";

// CREATE TABLE IF NOT EXISTS namespace_budgets (
//   namespace VARCHAR(64) PRIMARY KEY,
//   daily_cost_limit_usd DECIMAL(10,2) DEFAULT 50.00,
//   daily_token_limit BIGINT DEFAULT 1000000,
//   monthly_cost_limit_usd DECIMAL(10,2) DEFAULT 1000.00,
//   monthly_token_limit BIGINT DEFAULT 30000000,
//   rpm_limit INTEGER DEFAULT 30,
//   created_at TIMESTAMPTZ DEFAULT NOW(),
//   updated_at TIMESTAMPTZ DEFAULT NOW()
// );
//
// CREATE TABLE IF NOT EXISTS namespace_usage (
//   id SERIAL PRIMARY KEY,
//   namespace VARCHAR(64) NOT NULL,
//   date DATE NOT NULL DEFAULT CURRENT_DATE,
//   tokens_used BIGINT DEFAULT 0,
//   cost_usd DECIMAL(10,6) DEFAULT 0,
//   request_count INTEGER DEFAULT 0,
//   UNIQUE(namespace, date)
// );

const logger = pino({
  level: process.env.NODE_ENV === "test" ? "silent" : (process.env.LOG_LEVEL || "info"),
  ...(process.env.NODE_ENV !== "production" && process.env.NODE_ENV !== "test" ? {
    transport: { target: "pino-pretty", options: { colorize: true } }
  } : {}),
});

const DEFAULT_DAILY_COST_LIMIT = 50.0;
const DEFAULT_DAILY_TOKEN_LIMIT = 1_000_000;
const DEFAULT_MONTHLY_COST_LIMIT = 1000.0;
const DEFAULT_MONTHLY_TOKEN_LIMIT = 30_000_000;
const DEFAULT_RPM_LIMIT = 30;

export interface BudgetConfig {
  namespace: string;
  dailyCostLimitUsd: number;
  dailyTokenLimit: number;
  monthlyCostLimitUsd: number;
  monthlyTokenLimit: number;
  rpmLimit: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface UsageStats {
  tokensUsed: number;
  costUsd: number;
  requestCount: number;
}

export interface UsageCheck {
  allowed: boolean;
  reason?: string;
  current: UsageStats;
  limits: BudgetConfig;
}

export interface NamespaceUsageSummary {
  namespace: string;
  dailyUsage: UsageStats;
  monthlyUsage: UsageStats;
  dailyCostPercent: number;
  monthlyCostPercent: number;
  dailyTokenPercent: number;
  monthlyTokenPercent: number;
}

export interface BudgetAlert {
  namespace: string;
  alertType: "daily_cost" | "daily_tokens" | "monthly_cost" | "monthly_tokens";
  currentPercent: number;
  currentValue: number;
  limitValue: number;
}

function defaultBudget(namespace: string): BudgetConfig {
  const now = new Date();
  return {
    namespace,
    dailyCostLimitUsd: DEFAULT_DAILY_COST_LIMIT,
    dailyTokenLimit: DEFAULT_DAILY_TOKEN_LIMIT,
    monthlyCostLimitUsd: DEFAULT_MONTHLY_COST_LIMIT,
    monthlyTokenLimit: DEFAULT_MONTHLY_TOKEN_LIMIT,
    rpmLimit: DEFAULT_RPM_LIMIT,
    createdAt: now,
    updatedAt: now,
  };
}

function rowToBudget(row: Record<string, unknown>): BudgetConfig {
  return {
    namespace: row.namespace as string,
    dailyCostLimitUsd: Number(row.daily_cost_limit_usd) || DEFAULT_DAILY_COST_LIMIT,
    dailyTokenLimit: Number(row.daily_token_limit) || DEFAULT_DAILY_TOKEN_LIMIT,
    monthlyCostLimitUsd: Number(row.monthly_cost_limit_usd) || DEFAULT_MONTHLY_COST_LIMIT,
    monthlyTokenLimit: Number(row.monthly_token_limit) || DEFAULT_MONTHLY_TOKEN_LIMIT,
    rpmLimit: Number(row.rpm_limit) || DEFAULT_RPM_LIMIT,
    createdAt: row.created_at instanceof Date ? row.created_at : new Date(row.created_at as string),
    updatedAt: row.updated_at instanceof Date ? row.updated_at : new Date(row.updated_at as string),
  };
}

function rowToUsage(row: Record<string, unknown> | null): UsageStats {
  if (!row) return { tokensUsed: 0, costUsd: 0, requestCount: 0 };
  return {
    tokensUsed: Number(row.tokens_used) || 0,
    costUsd: Number(row.cost_usd) || 0,
    requestCount: Number(row.request_count) || 0,
  };
}

export async function getBudget(namespace: string): Promise<BudgetConfig> {
  const pool = await getPool();
  const { rows } = await pool.query(
    "SELECT * FROM namespace_budgets WHERE namespace = $1",
    [namespace],
  );
  if (rows.length === 0) return defaultBudget(namespace);
  return rowToBudget(rows[0]);
}

export async function setBudget(namespace: string, config: Partial<BudgetConfig>): Promise<void> {
  const pool = await getPool();
  const existing = await getBudget(namespace);
  const merged = { ...existing, ...config, namespace };

  await pool.query(
    `INSERT INTO namespace_budgets (namespace, daily_cost_limit_usd, daily_token_limit, monthly_cost_limit_usd, monthly_token_limit, rpm_limit, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, NOW())
     ON CONFLICT (namespace) DO UPDATE SET
       daily_cost_limit_usd = $2, daily_token_limit = $3,
       monthly_cost_limit_usd = $4, monthly_token_limit = $5,
       rpm_limit = $6, updated_at = NOW()`,
    [
      namespace,
      merged.dailyCostLimitUsd,
      merged.dailyTokenLimit,
      merged.monthlyCostLimitUsd,
      merged.monthlyTokenLimit,
      merged.rpmLimit,
    ],
  );
  logger.info({ namespace }, "Budget config updated");
}

export async function recordUsage(
  namespace: string,
  tokens: number,
  costUsd: number,
): Promise<UsageCheck> {
  const pool = await getPool();
  const limits = await getBudget(namespace);
  const today = new Date().toISOString().slice(0, 10);
  const monthStart = new Date().toISOString().slice(0, 7) + "-01";

  // Upsert daily usage
  await pool.query(
    `INSERT INTO namespace_usage (namespace, date, tokens_used, cost_usd, request_count)
     VALUES ($1, $2, $3, $4, 1)
     ON CONFLICT (namespace, date) DO UPDATE SET
       tokens_used = namespace_usage.tokens_used + $3,
       cost_usd = namespace_usage.cost_usd + $4,
       request_count = namespace_usage.request_count + 1`,
    [namespace, today, tokens, costUsd],
  );

  // Get current daily usage
  const dailyRow = await pool.query(
    "SELECT tokens_used, cost_usd, request_count FROM namespace_usage WHERE namespace = $1 AND date = $2",
    [namespace, today],
  );
  const daily = rowToUsage(dailyRow.rows[0] ?? null);

  // Get current monthly usage
  const monthlyRow = await pool.query(
    "SELECT COALESCE(SUM(tokens_used), 0) AS tokens_used, COALESCE(SUM(cost_usd), 0) AS cost_usd, COALESCE(SUM(request_count), 0) AS request_count FROM namespace_usage WHERE namespace = $1 AND date >= $2",
    [namespace, monthStart],
  );
  const monthly = rowToUsage(monthlyRow.rows[0] ?? null);

  // Check RPM limit (requests in current minute)
  const minuteAgo = new Date(Date.now() - 60_000).toISOString();
  const rpmRow = await pool.query(
    "SELECT COALESCE(SUM(request_count), 0) AS rpm FROM namespace_usage WHERE namespace = $1 AND updated_at >= $2",
    [namespace, minuteAgo],
  );
  const recentRpm = Number(rpmRow.rows[0]?.rpm ?? 0);

  // Determine allowed
  if (recentRpm > limits.rpmLimit) {
    logger.warn({ namespace, recentRpm, rpmLimit: limits.rpmLimit }, "RPM limit exceeded");
    return { allowed: false, reason: "RPM_EXCEEDED", current: monthly, limits };
  }
  if (daily.costUsd > limits.dailyCostLimitUsd) {
    logger.warn({ namespace, cost: daily.costUsd, limit: limits.dailyCostLimitUsd }, "Daily cost exceeded");
    return { allowed: false, reason: "DAILY_COST_EXCEEDED", current: daily, limits };
  }
  if (daily.tokensUsed > limits.dailyTokenLimit) {
    logger.warn({ namespace, tokens: daily.tokensUsed, limit: limits.dailyTokenLimit }, "Daily token limit exceeded");
    return { allowed: false, reason: "DAILY_TOKEN_EXCEEDED", current: daily, limits };
  }
  if (monthly.costUsd > limits.monthlyCostLimitUsd) {
    logger.warn({ namespace, cost: monthly.costUsd, limit: limits.monthlyCostLimitUsd }, "Monthly cost exceeded");
    return { allowed: false, reason: "MONTHLY_COST_EXCEEDED", current: monthly, limits };
  }
  if (monthly.tokensUsed > limits.monthlyTokenLimit) {
    logger.warn({ namespace, tokens: monthly.tokensUsed, limit: limits.monthlyTokenLimit }, "Monthly token limit exceeded");
    return { allowed: false, reason: "MONTHLY_TOKEN_EXCEEDED", current: monthly, limits };
  }

  return { allowed: true, current: daily, limits };
}

export async function getUsage(
  namespace: string,
  period: "daily" | "monthly" = "daily",
): Promise<UsageStats> {
  const pool = await getPool();
  if (period === "daily") {
    const today = new Date().toISOString().slice(0, 10);
    const { rows } = await pool.query(
      "SELECT tokens_used, cost_usd, request_count FROM namespace_usage WHERE namespace = $1 AND date = $2",
      [namespace, today],
    );
    return rowToUsage(rows[0] ?? null);
  }
  const monthStart = new Date().toISOString().slice(0, 7) + "-01";
  const { rows } = await pool.query(
    "SELECT COALESCE(SUM(tokens_used), 0) AS tokens_used, COALESCE(SUM(cost_usd), 0) AS cost_usd, COALESCE(SUM(request_count), 0) AS request_count FROM namespace_usage WHERE namespace = $1 AND date >= $2",
    [namespace, monthStart],
  );
  return rowToUsage(rows[0] ?? null);
}

export async function getAllUsage(): Promise<NamespaceUsageSummary[]> {
  const pool = await getPool();
  const today = new Date().toISOString().slice(0, 10);
  const monthStart = new Date().toISOString().slice(0, 7) + "-01";

  const budgetRows = await pool.query("SELECT * FROM namespace_budgets");
  const budgets = new Map<string, BudgetConfig>();
  for (const row of budgetRows.rows) {
    const b = rowToBudget(row);
    budgets.set(b.namespace, b);
  }

  const usageRows = await pool.query(
    "SELECT namespace, tokens_used, cost_usd, request_count FROM namespace_usage WHERE date >= $1",
    [monthStart],
  );

  const monthlyMap = new Map<string, UsageStats>();
  const dailyMap = new Map<string, UsageStats>();

  for (const row of usageRows.rows) {
    const ns = row.namespace as string;
    const usage = rowToUsage(row);
    const existing = monthlyMap.get(ns) ?? { tokensUsed: 0, costUsd: 0, requestCount: 0 };
    monthlyMap.set(ns, {
      tokensUsed: existing.tokensUsed + usage.tokensUsed,
      costUsd: existing.costUsd + usage.costUsd,
      requestCount: existing.requestCount + usage.requestCount,
    });
  }

  const dailyRows = await pool.query(
    "SELECT namespace, tokens_used, cost_usd, request_count FROM namespace_usage WHERE date = $1",
    [today],
  );
  for (const row of dailyRows.rows) {
    dailyMap.set(row.namespace as string, rowToUsage(row));
  }

  const allNamespaces = new Set([...budgets.keys(), ...monthlyMap.keys(), ...dailyMap.keys()]);
  const summaries: NamespaceUsageSummary[] = [];

  for (const ns of allNamespaces) {
    const budget = budgets.get(ns) ?? defaultBudget(ns);
    const daily = dailyMap.get(ns) ?? { tokensUsed: 0, costUsd: 0, requestCount: 0 };
    const monthly = monthlyMap.get(ns) ?? { tokensUsed: 0, costUsd: 0, requestCount: 0 };

    summaries.push({
      namespace: ns,
      dailyUsage: daily,
      monthlyUsage: monthly,
      dailyCostPercent: budget.dailyCostLimitUsd > 0 ? (daily.costUsd / budget.dailyCostLimitUsd) * 100 : 0,
      monthlyCostPercent: budget.monthlyCostLimitUsd > 0 ? (monthly.costUsd / budget.monthlyCostLimitUsd) * 100 : 0,
      dailyTokenPercent: budget.dailyTokenLimit > 0 ? (daily.tokensUsed / budget.dailyTokenLimit) * 100 : 0,
      monthlyTokenPercent: budget.monthlyTokenLimit > 0 ? (monthly.tokensUsed / budget.monthlyTokenLimit) * 100 : 0,
    });
  }

  return summaries;
}

export async function resetUsage(
  namespace: string,
  period: "daily" | "monthly" = "daily",
): Promise<void> {
  const pool = await getPool();
  if (period === "daily") {
    const today = new Date().toISOString().slice(0, 10);
    await pool.query(
      "DELETE FROM namespace_usage WHERE namespace = $1 AND date = $2",
      [namespace, today],
    );
  } else {
    const monthStart = new Date().toISOString().slice(0, 7) + "-01";
    await pool.query(
      "DELETE FROM namespace_usage WHERE namespace = $1 AND date >= $2",
      [namespace, monthStart],
    );
  }
  logger.info({ namespace, period }, "Usage reset");
}

export async function getBudgetAlerts(): Promise<BudgetAlert[]> {
  const pool = await getPool();
  const today = new Date().toISOString().slice(0, 10);
  const monthStart = new Date().toISOString().slice(0, 7) + "-01";
  const alerts: BudgetAlert[] = [];

  const budgetRows = await pool.query("SELECT * FROM namespace_budgets");
  for (const row of budgetRows.rows) {
    const budget = rowToBudget(row);
    const ns = budget.namespace;

    const dailyRow = await pool.query(
      "SELECT tokens_used, cost_usd FROM namespace_usage WHERE namespace = $1 AND date = $2",
      [ns, today],
    );
    const daily = rowToUsage(dailyRow.rows[0] ?? null);

    const monthlyRow = await pool.query(
      "SELECT COALESCE(SUM(tokens_used), 0) AS tokens_used, COALESCE(SUM(cost_usd), 0) AS cost_usd FROM namespace_usage WHERE namespace = $1 AND date >= $2",
      [ns, monthStart],
    );
    const monthly = rowToUsage(monthlyRow.rows[0] ?? null);

    const dailyCostPct = budget.dailyCostLimitUsd > 0 ? (daily.costUsd / budget.dailyCostLimitUsd) * 100 : 0;
    const dailyTokenPct = budget.dailyTokenLimit > 0 ? (daily.tokensUsed / budget.dailyTokenLimit) * 100 : 0;
    const monthlyCostPct = budget.monthlyCostLimitUsd > 0 ? (monthly.costUsd / budget.monthlyCostLimitUsd) * 100 : 0;
    const monthlyTokenPct = budget.monthlyTokenLimit > 0 ? (monthly.tokensUsed / budget.monthlyTokenLimit) * 100 : 0;

    if (dailyCostPct > 80) {
      alerts.push({ namespace: ns, alertType: "daily_cost", currentPercent: dailyCostPct, currentValue: daily.costUsd, limitValue: budget.dailyCostLimitUsd });
    }
    if (dailyTokenPct > 80) {
      alerts.push({ namespace: ns, alertType: "daily_tokens", currentPercent: dailyTokenPct, currentValue: daily.tokensUsed, limitValue: budget.dailyTokenLimit });
    }
    if (monthlyCostPct > 90) {
      alerts.push({ namespace: ns, alertType: "monthly_cost", currentPercent: monthlyCostPct, currentValue: monthly.costUsd, limitValue: budget.monthlyCostLimitUsd });
    }
    if (monthlyTokenPct > 90) {
      alerts.push({ namespace: ns, alertType: "monthly_tokens", currentPercent: monthlyTokenPct, currentValue: monthly.tokensUsed, limitValue: budget.monthlyTokenLimit });
    }
  }

  return alerts;
}
