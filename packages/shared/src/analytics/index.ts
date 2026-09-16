import { getPool } from "../db.js";
import pino from "pino";

const logger = pino({ level: process.env.LOG_LEVEL || "info" });

// ── Types ───────────────────────────────────────────────────────────────────

export interface ExecutionPattern {
  hour: number;
  dayOfWeek: string;
  executionCount: number;
  avgLatencyMs: number;
  errorRate: number;
}

export interface ModelDistribution {
  model: string;
  requestCount: number;
  totalTokens: number;
  totalCostUsd: number;
  avgTokensPerRequest: number;
}

export interface NamespaceActivity {
  namespace: string;
  agentCount: number;
  executionCount24h: number;
  executionCount7d: number;
  totalCostUsd24h: number;
  totalCostUsd7d: number;
  activeUsers: number;
}

export interface UsageSummary {
  totalExecutions24h: number;
  totalExecutions7d: number;
  totalCostUsd24h: number;
  totalCostUsd7d: number;
  uniqueUsers24h: number;
  uniqueUsers7d: number;
  topModels: ModelDistribution[];
  peakHour: number;
  avgExecutionLatencyMs: number;
}

// ── LLM Usage Table Bootstrap ───────────────────────────────────────────────

export async function ensureLLMUsageTable(): Promise<void> {
  const pool = await getPool();
  await pool.query(`
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
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function dayOfWeekName(d: Date): string {
  return ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][d.getDay()] ?? "Unknown";
}
export { dayOfWeekName };

// ── Functions ───────────────────────────────────────────────────────────────

export async function getExecutionPatterns(days: number = 7): Promise<ExecutionPattern[]> {
  try {
    const pool = await getPool();
    const cutoff = new Date(Date.now() - days * 86400000).toISOString();

    const result = await pool.query(
      `SELECT
         EXTRACT(HOUR FROM created_at)::int AS hour,
         EXTRACT(DOW FROM created_at)::int AS dow,
         COUNT(*) AS execution_count,
         COALESCE(AVG((context->>'latency_ms')::int), 0) AS avg_latency_ms,
         CASE WHEN COUNT(*) > 0 THEN
           ROUND((COUNT(*) FILTER (WHERE action->>'result' = 'error')::numeric / COUNT(*)) * 100, 2)
         ELSE 0 END AS error_rate
       FROM audit_entries
       WHERE event_type IN ('agent.execution_start', 'agent.execution_end')
         AND created_at >= $1
       GROUP BY EXTRACT(HOUR FROM created_at), EXTRACT(DOW FROM created_at)
       ORDER BY hour, dow`,
      [cutoff],
    );

    const dayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
    return result.rows.map((row) => ({
      hour: row.hour,
      dayOfWeek: dayNames[row.dow] ?? "Unknown",
      executionCount: parseInt(row.execution_count, 10),
      avgLatencyMs: parseFloat(row.avg_latency_ms) || 0,
      errorRate: parseFloat(row.error_rate) || 0,
    }));
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err: msg, days }, "Failed to get execution patterns");
    return [];
  }
}

export async function getModelDistribution(days: number = 7): Promise<ModelDistribution[]> {
  try {
    const pool = await getPool();
    const cutoff = new Date(Date.now() - days * 86400000).toISOString();

    const result = await pool.query(
      `SELECT
         model,
         COUNT(*) AS request_count,
         COALESCE(SUM(total_tokens), 0) AS total_tokens,
         COALESCE(SUM(cost_usd), 0) AS total_cost_usd,
         CASE WHEN COUNT(*) > 0 THEN ROUND(COALESCE(SUM(total_tokens), 0)::numeric / COUNT(*)) ELSE 0 END AS avg_tokens_per_request
       FROM llm_usage
       WHERE created_at >= $1
       GROUP BY model
       ORDER BY request_count DESC`,
      [cutoff],
    );

    return result.rows.map((row) => ({
      model: row.model,
      requestCount: parseInt(row.request_count, 10),
      totalTokens: parseInt(row.total_tokens, 10),
      totalCostUsd: parseFloat(row.total_cost_usd) || 0,
      avgTokensPerRequest: parseInt(row.avg_tokens_per_request, 10),
    }));
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err: msg, days }, "Failed to get model distribution");
    return [];
  }
}

export async function getNamespaceActivity(namespace?: string): Promise<NamespaceActivity[]> {
  try {
    const pool = await getPool();
    const now = new Date();
    const cutoff24h = new Date(now.getTime() - 86400000).toISOString();
    const cutoff7d = new Date(now.getTime() - 7 * 86400000).toISOString();

    const nsFilter = namespace ? `WHERE a.namespace = $1 AND a.deleted_at IS NULL` : `WHERE a.deleted_at IS NULL`;
    const nsParams = namespace ? [namespace] : [];

    const agentCounts = await pool.query(
      `SELECT namespace, COUNT(*) AS cnt FROM agents ${nsFilter} GROUP BY namespace`,
      nsParams,
    );

    const nsList = agentCounts.rows.map((r) => r.namespace);
    if (nsList.length === 0) return [];

    const activities: NamespaceActivity[] = [];

    for (const ns of nsList) {
      const agentCount = parseInt(
        agentCounts.rows.find((r) => r.namespace === ns)?.cnt ?? "0",
        10,
      );

      const exec24h = await pool.query(
        `SELECT COUNT(*) AS cnt FROM audit_entries
         WHERE event_type IN ('agent.execution_start', 'agent.execution_end')
           AND actor->>'namespace' = $1 AND created_at >= $2`,
        [ns, cutoff24h],
      );

      const exec7d = await pool.query(
        `SELECT COUNT(*) AS cnt FROM audit_entries
         WHERE event_type IN ('agent.execution_start', 'agent.execution_end')
           AND actor->>'namespace' = $1 AND created_at >= $2`,
        [ns, cutoff7d],
      );

      const cost24h = await pool.query(
        `SELECT COALESCE(SUM(cost_usd), 0) AS total FROM llm_usage
         WHERE namespace = $1 AND created_at >= $2`,
        [ns, cutoff24h],
      );

      const cost7d = await pool.query(
        `SELECT COALESCE(SUM(cost_usd), 0) AS total FROM llm_usage
         WHERE namespace = $1 AND created_at >= $2`,
        [ns, cutoff7d],
      );

      const users = await pool.query(
        `SELECT COUNT(DISTINCT actor->>'id') AS cnt FROM audit_entries
         WHERE actor->>'namespace' = $1 AND created_at >= $2`,
        [ns, cutoff7d],
      );

      activities.push({
        namespace: ns,
        agentCount,
        executionCount24h: parseInt(exec24h.rows[0]?.cnt ?? "0", 10),
        executionCount7d: parseInt(exec7d.rows[0]?.cnt ?? "0", 10),
        totalCostUsd24h: parseFloat(cost24h.rows[0]?.total ?? "0") || 0,
        totalCostUsd7d: parseFloat(cost7d.rows[0]?.total ?? "0") || 0,
        activeUsers: parseInt(users.rows[0]?.cnt ?? "0", 10),
      });
    }

    return activities;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err: msg, namespace }, "Failed to get namespace activity");
    return [];
  }
}

export async function getUsageSummary(): Promise<UsageSummary> {
  try {
    const pool = await getPool();
    const now = new Date();
    const cutoff24h = new Date(now.getTime() - 86400000).toISOString();
    const cutoff7d = new Date(now.getTime() - 7 * 86400000).toISOString();

    const exec24h = await pool.query(
      `SELECT COUNT(*) AS cnt FROM audit_entries
       WHERE event_type IN ('agent.execution_start', 'agent.execution_end')
         AND created_at >= $1`,
      [cutoff24h],
    );

    const exec7d = await pool.query(
      `SELECT COUNT(*) AS cnt FROM audit_entries
       WHERE event_type IN ('agent.execution_start', 'agent.execution_end')
         AND created_at >= $1`,
      [cutoff7d],
    );

    const cost24h = await pool.query(
      `SELECT COALESCE(SUM(cost_usd), 0) AS total FROM llm_usage WHERE created_at >= $1`,
      [cutoff24h],
    );

    const cost7d = await pool.query(
      `SELECT COALESCE(SUM(cost_usd), 0) AS total FROM llm_usage WHERE created_at >= $1`,
      [cutoff7d],
    );

    const users24h = await pool.query(
      `SELECT COUNT(DISTINCT actor->>'id') AS cnt FROM audit_entries WHERE created_at >= $1`,
      [cutoff24h],
    );

    const users7d = await pool.query(
      `SELECT COUNT(DISTINCT actor->>'id') AS cnt FROM audit_entries WHERE created_at >= $1`,
      [cutoff7d],
    );

    const topModels = await pool.query(
      `SELECT
         model,
         COUNT(*) AS request_count,
         COALESCE(SUM(total_tokens), 0) AS total_tokens,
         COALESCE(SUM(cost_usd), 0) AS total_cost_usd,
         CASE WHEN COUNT(*) > 0 THEN ROUND(COALESCE(SUM(total_tokens), 0)::numeric / COUNT(*)) ELSE 0 END AS avg_tokens_per_request
       FROM llm_usage
       WHERE created_at >= $1
       GROUP BY model
       ORDER BY request_count DESC
       LIMIT 10`,
      [cutoff7d],
    );

    const peakHourResult = await pool.query(
      `SELECT
         EXTRACT(HOUR FROM created_at)::int AS hour,
         COUNT(*) AS cnt
       FROM audit_entries
       WHERE event_type IN ('agent.execution_start', 'agent.execution_end')
         AND created_at >= $1
       GROUP BY EXTRACT(HOUR FROM created_at)
       ORDER BY cnt DESC
       LIMIT 1`,
      [cutoff7d],
    );

    const avgLatency = await pool.query(
      `SELECT COALESCE(AVG((context->>'latency_ms')::int), 0) AS avg_lat
       FROM audit_entries
       WHERE event_type IN ('agent.execution_start', 'agent.execution_end')
         AND context ? 'latency_ms'
         AND created_at >= $1`,
      [cutoff7d],
    );

    return {
      totalExecutions24h: parseInt(exec24h.rows[0]?.cnt ?? "0", 10),
      totalExecutions7d: parseInt(exec7d.rows[0]?.cnt ?? "0", 10),
      totalCostUsd24h: parseFloat(cost24h.rows[0]?.total ?? "0") || 0,
      totalCostUsd7d: parseFloat(cost7d.rows[0]?.total ?? "0") || 0,
      uniqueUsers24h: parseInt(users24h.rows[0]?.cnt ?? "0", 10),
      uniqueUsers7d: parseInt(users7d.rows[0]?.cnt ?? "0", 10),
      topModels: topModels.rows.map((row) => ({
        model: row.model,
        requestCount: parseInt(row.request_count, 10),
        totalTokens: parseInt(row.total_tokens, 10),
        totalCostUsd: parseFloat(row.total_cost_usd) || 0,
        avgTokensPerRequest: parseInt(row.avg_tokens_per_request, 10),
      })),
      peakHour: peakHourResult.rows[0]?.hour ?? 0,
      avgExecutionLatencyMs: parseFloat(avgLatency.rows[0]?.avg_lat ?? "0") || 0,
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err: msg }, "Failed to get usage summary");
    return {
      totalExecutions24h: 0,
      totalExecutions7d: 0,
      totalCostUsd24h: 0,
      totalCostUsd7d: 0,
      uniqueUsers24h: 0,
      uniqueUsers7d: 0,
      topModels: [],
      peakHour: 0,
      avgExecutionLatencyMs: 0,
    };
  }
}

export async function getTopAgents(
  limit: number = 10,
): Promise<{ agentId: string; executions: number; cost: number }[]> {
  try {
    const pool = await getPool();
    const cutoff = new Date(Date.now() - 7 * 86400000).toISOString();

    const result = await pool.query(
      `SELECT
         actor->>'id' AS agent_id,
         COUNT(*) AS executions,
         COALESCE(
           (SELECT SUM(lu.cost_usd) FROM llm_usage lu WHERE lu.agent_id = actor->>'id' AND lu.created_at >= $1),
           0
         ) AS cost
       FROM audit_entries
       WHERE event_type IN ('agent.execution_start', 'agent.execution_end')
         AND actor->>'type' = 'agent'
         AND created_at >= $1
       GROUP BY actor->>'id'
       ORDER BY executions DESC
       LIMIT $2`,
      [cutoff, limit],
    );

    return result.rows.map((row) => ({
      agentId: row.agent_id ?? "",
      executions: parseInt(row.executions, 10),
      cost: parseFloat(row.cost) || 0,
    }));
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err: msg, limit }, "Failed to get top agents");
    return [];
  }
}

export async function getCostTrend(
  days: number = 30,
): Promise<{ date: string; cost: number }[]> {
  try {
    const pool = await getPool();
    const cutoff = new Date(Date.now() - days * 86400000).toISOString();

    const result = await pool.query(
      `SELECT
         DATE(created_at) AS date,
         COALESCE(SUM(cost_usd), 0) AS cost
       FROM llm_usage
       WHERE created_at >= $1
       GROUP BY DATE(created_at)
       ORDER BY date ASC`,
      [cutoff],
    );

    return result.rows.map((row) => ({
      date: typeof row.date === "string" ? row.date : new Date(row.date).toISOString().slice(0, 10),
      cost: parseFloat(row.cost) || 0,
    }));
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err: msg, days }, "Failed to get cost trend");
    return [];
  }
}

export async function getPeakHours(
  days: number = 7,
): Promise<{ hour: number; avgRequests: number }[]> {
  try {
    const pool = await getPool();
    const cutoff = new Date(Date.now() - days * 86400000).toISOString();

    const result = await pool.query(
      `SELECT
         EXTRACT(HOUR FROM created_at)::int AS hour,
         COUNT(*)::numeric / GREATEST($1::int, 1) AS avg_requests
       FROM audit_entries
       WHERE event_type IN ('agent.execution_start', 'agent.execution_end')
         AND created_at >= $2
       GROUP BY EXTRACT(HOUR FROM created_at)
       ORDER BY hour ASC`,
      [days, cutoff],
    );

    const hoursMap = new Map<number, number>();
    for (const row of result.rows) {
      hoursMap.set(row.hour, parseFloat(row.avg_requests) || 0);
    }

    const output: { hour: number; avgRequests: number }[] = [];
    for (let h = 0; h < 24; h++) {
      output.push({ hour: h, avgRequests: hoursMap.get(h) ?? 0 });
    }
    return output;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err: msg, days }, "Failed to get peak hours");
    return Array.from({ length: 24 }, (_, i) => ({ hour: i, avgRequests: 0 }));
  }
}
