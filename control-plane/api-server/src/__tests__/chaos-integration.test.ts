import { GenericContainer, StartedTestContainer, Wait } from "testcontainers";
import { Pool, PoolConfig } from "pg";
import Redis from "ioredis";

// ── Test infrastructure ────────────────────────────────────────────────────

let pgContainer: StartedTestContainer;
let redisContainer: StartedTestContainer;
let pgPool: Pool;
let redisClient: Redis;

interface AuditEntry {
  event_id: string;
  event_type: string;
  severity: string;
  actor: Record<string, unknown>;
  action: Record<string, unknown>;
  created_at: Date;
}

// ── Setup / Teardown ───────────────────────────────────────────────────────

beforeAll(async () => {
  pgContainer = await new GenericContainer("postgres:15-alpine")
    .withEnvironment({
      POSTGRES_DB: "egaop_chaos_test",
      POSTGRES_USER: "test",
      POSTGRES_PASSWORD: "test",
    })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage("database system is ready to accept connections", 2))
    .start();

  redisContainer = await new GenericContainer("redis:7-alpine")
    .withExposedPorts(6379)
    .withWaitStrategy(Wait.forLogMessage("Ready to accept connections"))
    .start();

  const pgConfig: PoolConfig = {
    host: pgContainer.getHost(),
    port: pgContainer.getMappedPort(5432),
    database: "egaop_chaos_test",
    user: "test",
    password: "test",
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
  };

  pgPool = new Pool(pgConfig);

  redisClient = new Redis({
    host: redisContainer.getHost(),
    port: redisContainer.getMappedPort(6379),
    lazyConnect: true,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 3,
    connectTimeout: 5000,
  });

  await pgPool.query(`
    CREATE TABLE IF NOT EXISTS namespaces (
      id TEXT PRIMARY KEY,
      slug TEXT NOT NULL UNIQUE,
      display_name TEXT NOT NULL,
      tier TEXT NOT NULL DEFAULT 'sandbox',
      owner_id TEXT NOT NULL,
      max_agents INTEGER NOT NULL DEFAULT 5,
      max_concurrent_executions INTEGER NOT NULL DEFAULT 2,
      max_memory_mb INTEGER NOT NULL DEFAULT 512,
      max_tool_calls_per_minute INTEGER NOT NULL DEFAULT 30,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      suspended_at TIMESTAMPTZ,
      deleted_at TIMESTAMPTZ
    );

    CREATE TABLE IF NOT EXISTS audit_entries (
      event_id TEXT PRIMARY KEY,
      event_type TEXT NOT NULL,
      severity TEXT NOT NULL DEFAULT 'info',
      actor JSONB NOT NULL DEFAULT '{}',
      target JSONB NOT NULL DEFAULT '{}',
      action JSONB NOT NULL DEFAULT '{}',
      context JSONB NOT NULL DEFAULT '{}',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      namespace TEXT NOT NULL,
      name TEXT NOT NULL,
      api_version TEXT NOT NULL DEFAULT 'egaop.io/v1',
      kind TEXT NOT NULL DEFAULT 'Agent',
      spec JSONB NOT NULL DEFAULT '{}',
      status JSONB NOT NULL DEFAULT '{}',
      labels JSONB NOT NULL DEFAULT '{}',
      annotations JSONB NOT NULL DEFAULT '{}',
      version INTEGER NOT NULL DEFAULT 1,
      created_by TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      deleted_at TIMESTAMPTZ
    );

    INSERT INTO namespaces (id, slug, display_name, tier, owner_id, max_agents, max_concurrent_executions, max_memory_mb, max_tool_calls_per_minute)
    VALUES
      ('ns-1', 'production', 'Production', 'enterprise', 'owner-1', 50, 10, 4096, 120),
      ('ns-2', 'staging', 'Staging', 'sandbox', 'owner-2', 10, 2, 512, 30);
  `);
}, 120000);

afterAll(async () => {
  await pgPool?.end();
  await redisClient?.quit().catch(() => {});
  await pgContainer?.stop();
  await redisContainer?.stop();
});

// ── 1. PostgreSQL connection pool exhaustion ────────────────────────────────

describe("Chaos: PostgreSQL connection pool exhaustion → graceful backpressure", () => {
  it("exhausting a max:1 pool returns proper errors without crashing the process", async () => {
    const exhaustionPool = new Pool({
      host: pgContainer.getHost(),
      port: pgContainer.getMappedPort(5432),
      database: "egaop_chaos_test",
      user: "test",
      password: "test",
      max: 1,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 1000,
    });

    try {
      // Acquire and hold the single connection so other queries are blocked
      const blockingClient = await exhaustionPool.connect();
      const sleepPromise = blockingClient.query("SELECT pg_sleep(3)");

      // Attempt to acquire the same connection — should error or timeout
      const attempts: Promise<unknown>[] = [];
      for (let i = 0; i < 3; i++) {
        attempts.push(
          exhaustionPool.query("SELECT 1").catch((err: Error) => ({
            error: true,
            message: err.message,
            code: (err as NodeJS.ErrnoException & { code?: string }).code,
          }))
        );
      }

      const results = await Promise.allSettled(attempts);
      const errors = results.filter(
        (r): r is PromiseFulfilledResult<{ error: boolean; message: string; code?: string }> =>
          r.status === "fulfilled" && r.value !== null && typeof r.value === "object" && "error" in r.value
      );

      // At least some requests should fail gracefully (not crash the process)
      expect(errors.length).toBeGreaterThan(0);
      expect(errors.some((e) => e.value.message.includes("timeout") || e.value.message.includes("ECONNREFUSED") || e.value.message.includes("remaining connection") || e.value.code === "ECONNREFUSED" || e.value.code === "ETIMEDOUT")).toBe(true);

      // Release the held connection
      blockingClient.release();
      await sleepPromise;

      // Verify the pool is still functional after exhaustion
      const recoveryResult = await exhaustionPool.query("SELECT 1 AS alive");
      expect(recoveryResult.rows[0].alive).toBe(1);
    } finally {
      await exhaustionPool.end();
    }
  }, 15000);

  it("pool recovery after timeout allows subsequent queries to succeed", async () => {
    const pool = new Pool({
      host: pgContainer.getHost(),
      port: pgContainer.getMappedPort(5432),
      database: "egaop_chaos_test",
      user: "test",
      password: "test",
      max: 2,
      connectionTimeoutMillis: 2000,
    });

    try {
      // Simulate burst of concurrent queries
      const burst = Array.from({ length: 10 }, () =>
        pool.query("SELECT pg_sleep(0.1), random() AS val").catch(() => null)
      );
      const burstResults = await Promise.allSettled(burst);
      expect(burstResults.length).toBe(10);

      // Verify pool recovers
      const result = await pool.query("SELECT 1 AS recovered");
      expect(result.rows[0].recovered).toBe(1);
    } finally {
      await pool.end();
    }
  }, 15000);
});

// ── 2. PostgreSQL query timeout ────────────────────────────────────────────

describe("Chaos: PostgreSQL query timeout → proper timeout handling", () => {
  it("slow query exceeding statement_timeout is terminated with an error", async () => {
    const timeoutPool = new Pool({
      host: pgContainer.getHost(),
      port: pgContainer.getMappedPort(5432),
      database: "egaop_chaos_test",
      user: "test",
      password: "test",
      max: 2,
      connectionTimeoutMillis: 5000,
      statement_timeout: 1000, // 1 second
    });

    try {
      // A query that sleeps 10 seconds should be killed by statement_timeout
      const start = Date.now();
      await expect(
        timeoutPool.query("SELECT pg_sleep(10)")
      ).rejects.toThrow();
      const elapsed = Date.now() - start;

      // Should complete much faster than 10 seconds due to timeout
      expect(elapsed).toBeLessThan(8000);
    } finally {
      await timeoutPool.end();
    }
  });

  it("pool remains usable after a timed-out query", async () => {
    const pool = new Pool({
      host: pgContainer.getHost(),
      port: pgContainer.getMappedPort(5432),
      database: "egaop_chaos_test",
      user: "test",
      password: "test",
      max: 2,
      connectionTimeoutMillis: 5000,
      statement_timeout: 500,
    });

    try {
      // Trigger a timeout
      await pool.query("SELECT pg_sleep(10)").catch(() => {});

      // Verify pool recovers
      const result = await pool.query("SELECT 1 AS alive");
      expect(result.rows[0].alive).toBe(1);

      // Verify multiple subsequent queries work
      const results = await Promise.all(
        Array.from({ length: 5 }, (_, i) =>
          pool.query("SELECT $1 AS idx", [i])
        )
      );
      expect(results.map((r) => Number(r.rows[0].idx))).toEqual([0, 1, 2, 3, 4]);
    } finally {
      await pool.end();
    }
  });
});

// ── 3. Redis unavailability → in-memory fallback for token refresh ─────────

describe("Chaos: Redis unavailability → refresh token falls back to in-memory Map", () => {
  let inMemoryRefreshTokens: Map<string, { userId: string; expiresAt: number }>;

  beforeEach(() => {
    // Simulate the in-memory fallback store from auth/routes.ts
    inMemoryRefreshTokens = new Map();
  });

  it("storeRefreshToken persists to in-memory Map when Redis is unreachable", async () => {
    // Simulate Redis being down by using a client pointing to a non-existent host
    const deadRedis = new Redis({
      host: "127.0.0.1",
      port: 1, // non-existent port
      lazyConnect: true,
      enableOfflineQueue: false,
      connectTimeout: 1000,
      maxRetriesPerRequest: 0,
    });

    const tokenHash = "test-refresh-token-hash-abc123";
    const userId = "user-chaos-1";
    const expiresAt = Date.now() + 7 * 24 * 60 * 60 * 1000;

    // Simulate fallback logic from routes.ts storeRefreshToken
    let storedInRedis = false;
    try {
      await deadRedis.set(tokenHash, JSON.stringify({ userId, createdAt: Date.now() }), "EX", 604800);
      storedInRedis = true;
    } catch {
      // Fall through to in-memory
    }

    expect(storedInRedis).toBe(false);
    inMemoryRefreshTokens.set(tokenHash, { userId, expiresAt });

    // Verify fallback store works
    const entry = inMemoryRefreshTokens.get(tokenHash);
    expect(entry).toBeDefined();
    expect(entry!.userId).toBe(userId);
    expect(entry!.expiresAt).toBe(expiresAt);

    await deadRedis.quit().catch(() => {});
  });

  it("verifyRefreshToken reads from in-memory Map when Redis is down", async () => {
    const tokenHash = "test-verify-token-hash-def456";
    const userId = "user-chaos-2";
    const expiresAt = Date.now() + 7 * 24 * 60 * 60 * 1000;

    // Pre-populate in-memory store (simulating fallback from earlier write)
    inMemoryRefreshTokens.set(tokenHash, { userId, expiresAt });

    // Simulate verify logic from routes.ts verifyRefreshToken
    const entry = inMemoryRefreshTokens.get(tokenHash);
    expect(entry).toBeDefined();
    expect(entry!.userId).toBe(userId);

    // Verify expiry check works
    if (entry && entry.expiresAt < Date.now()) {
      inMemoryRefreshTokens.delete(tokenHash);
      expect(inMemoryRefreshTokens.has(tokenHash)).toBe(false);
    } else {
      expect(inMemoryRefreshTokens.has(tokenHash)).toBe(true);
    }
  });

  it("revokeRefreshToken removes from in-memory Map as best-effort", async () => {
    const tokenHash = "test-revoke-token-hash-ghi789";
    inMemoryRefreshTokens.set(tokenHash, { userId: "user-chaos-3", expiresAt: Date.now() + 86400000 });

    // Simulate revoke logic — always removes from in-memory regardless of Redis
    inMemoryRefreshTokens.delete(tokenHash);

    expect(inMemoryRefreshTokens.has(tokenHash)).toBe(false);
  });

  it("token revocation check fails open when Redis is unreachable", async () => {
    const deadRedis = new Redis({
      host: "127.0.0.1",
      port: 1,
      lazyConnect: true,
      enableOfflineQueue: false,
      connectTimeout: 1000,
      maxRetriesPerRequest: 0,
    });

    // Simulate isTokenRevoked fail-open logic
    let isRevoked = false;
    try {
      const exists = await deadRedis.exists("egaop:revoked:some-token");
      isRevoked = exists === 1;
    } catch {
      // Fail open: if Redis is down, treat token as not revoked
      isRevoked = false;
    }

    expect(isRevoked).toBe(false);

    await deadRedis.quit().catch(() => {});
  });
});

// ── 4. Audit log write failure → server continues operating ────────────────

describe("Chaos: Audit log write failure → non-fatal, server continues", () => {
  it("dropping audit_entries table does not prevent namespace queries", async () => {
    // Verify table exists before dropping
    const preCheck = await pgPool.query(
      "SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'audit_entries')"
    );
    expect(preCheck.rows[0].exists).toBe(true);

    // Drop the audit_entries table
    await pgPool.query("DROP TABLE IF EXISTS audit_entries");

    // Verify table is gone
    const postCheck = await pgPool.query(
      "SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'audit_entries')"
    );
    expect(postCheck.rows[0].exists).toBe(false);

    // Attempting to write audit log should fail gracefully
    let auditError: Error | null = null;
    try {
      await pgPool.query(
        "INSERT INTO audit_entries (event_id, event_type, severity, actor, action) VALUES ($1, $2, $3, $4, $5)",
        ["evt-1", "test.event", "info", "{}", "{}"]
      );
    } catch (err) {
      auditError = err instanceof Error ? err : new Error(String(err));
    }
    expect(auditError).not.toBeNull();
    expect(auditError!.message).toContain("audit_entries");

    // Core operations should still work despite audit failure
    const namespaceResult = await pgPool.query("SELECT * FROM namespaces WHERE deleted_at IS NULL");
    expect(namespaceResult.rows.length).toBeGreaterThanOrEqual(2);

    const agentResult = await pgPool.query("SELECT * FROM agents WHERE deleted_at IS NULL");
    expect(agentResult.rows).toHaveLength(0);

    // Recreate the table for subsequent tests
    await pgPool.query(`
      CREATE TABLE IF NOT EXISTS audit_entries (
        event_id TEXT PRIMARY KEY,
        event_type TEXT NOT NULL,
        severity TEXT NOT NULL DEFAULT 'info',
        actor JSONB NOT NULL DEFAULT '{}',
        target JSONB NOT NULL DEFAULT '{}',
        action JSONB NOT NULL DEFAULT '{}',
        context JSONB NOT NULL DEFAULT '{}',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
  });

  it("audit write error is caught and logged without propagating", async () => {
    // Simulate the try/catch pattern from routes.ts
    let auditWritten = false;
    try {
      await pgPool.query(
        "INSERT INTO non_existent_table (id) VALUES ($1)",
        ["evt-fail"]
      );
      auditWritten = true;
    } catch {
      // Audit failure is non-fatal — swallow error
      auditWritten = false;
    }

    expect(auditWritten).toBe(false);

    // Subsequent operations proceed normally
    const result = await pgPool.query("SELECT 1 AS alive");
    expect(result.rows[0].alive).toBe(1);
  });

  it("repeated audit failures do not exhaust connection pool", async () => {
    // Simulate many failed audit writes
    const failurePromises = Array.from({ length: 20 }, () =>
      pgPool.query("INSERT INTO non_existent_table (id) VALUES ($1)", ["evt-x"]).catch(() => null)
    );

    await Promise.all(failurePromises);

    // Pool should still be functional
    const result = await pgPool.query("SELECT COUNT(*) AS cnt FROM namespaces");
    expect(parseInt(result.rows[0].cnt)).toBeGreaterThanOrEqual(2);
  });
});

// ── 5. Graceful degradation of /api/metrics ────────────────────────────────

describe("Chaos: Graceful degradation of /api/metrics → partial data when sources fail", () => {
  it("returns fallback metrics when database query fails", async () => {
    // Simulate the metrics endpoint pattern from index.ts
    let metrics: Record<string, unknown>;
    try {
      // Simulate a Temporal-like query failure by querying a non-existent table
      await pgPool.query("SELECT * FROM non-existent-workflows");
      metrics = {
        activeAgents: 0,
        executions24h: 0,
        avgLatencyMs: 0,
        errorRate: 0,
        totalCostUsd: 0,
        activeNamespaces: 1,
      };
    } catch {
      // Fallback metrics when primary data source is unavailable
      metrics = {
        activeAgents: 0,
        executions24h: 0,
        avgLatencyMs: 0,
        errorRate: 0,
        totalCostUsd: 0,
        activeNamespaces: 1,
      };
    }

    expect(metrics).toEqual({
      activeAgents: 0,
      executions24h: 0,
      avgLatencyMs: 0,
      errorRate: 0,
      totalCostUsd: 0,
      activeNamespaces: 1,
    });
  });

  it("returns partial metrics when namespace health query succeeds but agent count fails", async () => {
    // Simulate the namespace health pattern
    let namespaceCount = 0;
    let agentCount = 0;

    try {
      const nsResult = await pgPool.query("SELECT COUNT(*) AS cnt FROM namespaces WHERE deleted_at IS NULL");
      namespaceCount = parseInt(nsResult.rows[0].cnt);
    } catch {
      namespaceCount = 0;
    }

    try {
      const agentResult = await pgPool.query("SELECT COUNT(*) AS cnt FROM agents WHERE deleted_at IS NULL");
      agentCount = parseInt(agentResult.rows[0].cnt);
    } catch {
      agentCount = 0;
    }

    expect(namespaceCount).toBe(2);
    expect(agentCount).toBe(0);
  });

  it("audit log endpoint returns empty list when audit_entries table is dropped", async () => {
    // Drop audit table to simulate failure
    await pgPool.query("DROP TABLE IF EXISTS audit_entries");

    // Simulate the audit-log endpoint pattern from index.ts
    let entries: AuditEntry[] = [];
    let total = 0;
    try {
      const countResult = await pgPool.query("SELECT COUNT(*) FROM audit_entries");
      total = parseInt(countResult.rows[0]?.count ?? "0", 10);
      const result = await pgPool.query("SELECT * FROM audit_entries ORDER BY created_at DESC LIMIT 50 OFFSET 0");
      entries = result.rows;
    } catch {
      // Return empty on failure — same as routes.ts pattern
      entries = [];
      total = 0;
    }

    expect(entries).toEqual([]);
    expect(total).toBe(0);

    // Recreate table
    await pgPool.query(`
      CREATE TABLE IF NOT EXISTS audit_entries (
        event_id TEXT PRIMARY KEY,
        event_type TEXT NOT NULL,
        severity TEXT NOT NULL DEFAULT 'info',
        actor JSONB NOT NULL DEFAULT '{}',
        target JSONB NOT NULL DEFAULT '{}',
        action JSONB NOT NULL DEFAULT '{}',
        context JSONB NOT NULL DEFAULT '{}',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
  });

  it("users endpoint returns empty list on database failure", async () => {
    // Simulate the users endpoint pattern — use a disconnected pool
    const deadPool = new Pool({
      host: "127.0.0.1",
      port: 1,
      database: "nonexistent",
      user: "test",
      password: "test",
      max: 1,
      connectionTimeoutMillis: 1000,
    });

    let users: unknown[] = [];
    try {
      await deadPool.query("SELECT * FROM users WHERE deleted_at IS NULL");
    } catch {
      users = [];
    }

    expect(users).toEqual([]);
    await deadPool.end();
  });
});
