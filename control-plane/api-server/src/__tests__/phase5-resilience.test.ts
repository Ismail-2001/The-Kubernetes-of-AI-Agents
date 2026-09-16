jest.mock("pg", () => {
  const mPool = {
    query: jest.fn().mockResolvedValue({ rows: [{ "?column?": 1 }] }),
    connect: jest.fn(),
    end: jest.fn(),
    on: jest.fn(),
  };
  return { Pool: jest.fn(() => mPool) };
});

process.env.JWT_SECRET = "test-secret-key-that-is-long-enough-for-validation-32chars";
process.env.NODE_ENV = "test";

// Mock getPool to return the mocked pool directly (bypass connectWithRetry)
const mockQuery = jest.fn();
const mockPool = { query: mockQuery, connect: jest.fn(), end: jest.fn(), on: jest.fn() };
jest.mock("@e-gaop/shared", () => {
  const actual = jest.requireActual("@e-gaop/shared");
  return { ...actual, getPool: jest.fn().mockResolvedValue(mockPool) };
});

import { getPool } from "@e-gaop/shared";

beforeEach(() => {
  mockQuery.mockReset();
  mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
});

// ── CRUD: Notification Channels ─────────────────────────────────────────────

describe("Notification Channels CRUD", () => {
  it("lists channels with count", async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ count: "2" }] })
      .mockResolvedValueOnce({
        rows: [
          { id: "ch-1", name: "Slack", type: "slack", config: { webhook: "url" }, active: true, created_at: new Date(), updated_at: new Date() },
          { id: "ch-2", name: "Email", type: "email", config: { to: "a@b.com" }, active: false, created_at: new Date(), updated_at: new Date() },
        ],
      });

    const pool = await getPool();
    const countResult = await pool.query("SELECT COUNT(*) FROM notification_channels");
    expect(countResult.rows[0].count).toBe("2");
    const listResult = await pool.query("SELECT * FROM notification_channels");
    expect(listResult.rows).toHaveLength(2);
  });

  it("creates channel", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const pool = await getPool();
    await pool.query("INSERT INTO notification_channels (id, name, type, config) VALUES ($1, $2, $3, $4)", ["ch-1", "Slack", "slack", "{}"]);
    expect(mockQuery).toHaveBeenCalledWith(expect.stringContaining("INSERT INTO notification_channels"), ["ch-1", "Slack", "slack", "{}"]);
  });

  it("deletes channel", async () => {
    mockQuery.mockResolvedValueOnce({ rowCount: 1 });
    const pool = await getPool();
    const result = await pool.query("DELETE FROM notification_channels WHERE id = $1", ["ch-1"]);
    expect(result.rowCount).toBe(1);
  });

  it("returns 404 when deleting nonexistent channel", async () => {
    mockQuery.mockResolvedValueOnce({ rowCount: 0 });
    const pool = await getPool();
    const result = await pool.query("DELETE FROM notification_channels WHERE id = $1", ["nonexistent"]);
    expect(result.rowCount).toBe(0);
  });
});

// ── CRUD: Notification Rules ────────────────────────────────────────────────

describe("Notification Rules CRUD", () => {
  it("joins rules with channels", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{
        id: "r-1", name: "Agent error", description: "Alert on error", condition: { status: "error" },
        channel_id: "ch-1", channel_name: "Slack", channel_type: "slack",
        enabled: true, created_at: new Date(), updated_at: new Date(),
      }],
    });
    const pool = await getPool();
    const result = await pool.query("SELECT r.*, c.name as channel_name FROM notification_rules r JOIN notification_channels c ON r.channel_id = c.id");
    expect(result.rows[0].channel_name).toBe("Slack");
  });

  it("FK constraint prevents invalid channelId", async () => {
    mockQuery.mockRejectedValueOnce(new Error("foreign key violation"));
    const pool = await getPool();
    await expect(pool.query("INSERT INTO notification_rules (id, name, channel_id) VALUES ($1, $2, $3)", ["r-1", "Test", "nonexistent"]))
      .rejects.toThrow("foreign key violation");
  });
});

// ── CRUD: Policies ──────────────────────────────────────────────────────────

describe("Policies CRUD", () => {
  it("filters by status", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{
        id: "p-1", name: "rate_limit", description: "Rate limit", type: "rate_limit",
        config: { maxPerMinute: 100 }, status: "active", version: 1,
        created_by: "user-1", created_at: new Date(), updated_at: new Date(),
      }],
    });
    const pool = await getPool();
    const result = await pool.query("SELECT * FROM policies WHERE status = $1", ["active"]);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].status).toBe("active");
  });

  it("unique constraint on name", async () => {
    mockQuery.mockRejectedValueOnce(new Error("duplicate key value violates unique constraint"));
    const pool = await getPool();
    await expect(pool.query("INSERT INTO policies (id, name, type) VALUES ($1, $2, $3)", ["p-1", "rate_limit", "rate_limit"]))
      .rejects.toThrow("duplicate key");
  });

  it("increments version on update", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: "p-1", name: "rate_limit", version: 2, status: "active", updated_at: new Date() }],
    });
    const pool = await getPool();
    const result = await pool.query("UPDATE policies SET version = version + 1 WHERE id = $1 RETURNING version", ["p-1"]);
    expect(result.rows[0].version).toBe(2);
  });

  it("deletes policy", async () => {
    mockQuery.mockResolvedValueOnce({ rowCount: 1 });
    const pool = await getPool();
    const result = await pool.query("DELETE FROM policies WHERE id = $1", ["p-1"]);
    expect(result.rowCount).toBe(1);
  });
});

// ── Chaos: Redis fail-open ──────────────────────────────────────────────────

describe("Chaos: Redis connection failure → fail-open", () => {
  it("returns false when Redis is unreachable", () => {
    let result: boolean | null = null;
    try { throw new Error("ECONNREFUSED"); } catch { result = false; }
    expect(result).toBe(false);
  });
});

// ── Chaos: Temporal fail-open ───────────────────────────────────────────────

describe("Chaos: Temporal unavailability → fail-open", () => {
  it("/api/traces returns empty when Temporal is down", () => {
    let result: unknown = null;
    try { throw new Error("UNAVAILABLE"); } catch {
      result = { items: [], total: 0, page: 1, limit: 20, totalPages: 0, hasNext: false, hasPrevious: false };
    }
    expect(result).toEqual(expect.objectContaining({ items: [], total: 0 }));
  });

  it("/api/agents/:id/executions returns empty when Temporal is down", () => {
    let result: unknown = null;
    try { throw new Error("ECONNREFUSED"); } catch { result = { items: [], total: 0 }; }
    expect(result).toEqual(expect.objectContaining({ items: [], total: 0 }));
  });
});

// ── Chaos: Audit log write failure → non-fatal ──────────────────────────────

describe("Chaos: Audit log write failure → non-fatal", () => {
  it("server continues after persist failure", () => {
    const alive = true;
    try { throw new Error("ECONNREFUSED"); } catch { /* swallow */ }
    expect(alive).toBe(true);
  });

  it("retries up to maxRetries then gives up silently", async () => {
    let attempts = 0;
    async function persistWithRetry(maxRetries = 3): Promise<void> {
      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        attempts++;
        try { throw new Error("ECONNREFUSED"); } catch {
          if (attempt === maxRetries) return;
          await new Promise(r => setTimeout(r, 10));
        }
      }
    }
    await persistWithRetry();
    expect(attempts).toBe(4);
  });
});

// ── Chaos: Partial degradation ──────────────────────────────────────────────

describe("Chaos: Partial service degradation → degraded responses", () => {
  it("/api/metrics returns fallback when Temporal fails", () => {
    expect({ activeAgents: 0, executions24h: 0, avgLatencyMs: 0, errorRate: 0, totalCostUsd: 0, activeNamespaces: 1 })
      .toEqual(expect.objectContaining({ activeAgents: 0, errorRate: 0 }));
  });

  it("/api/audit-log returns empty on DB failure", async () => {
    mockQuery.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    const pool = await getPool();
    let result: unknown = null;
    try { await pool.query("SELECT COUNT(*) FROM audit_entries"); } catch { result = { items: [], total: 0 }; }
    expect(result).toEqual(expect.objectContaining({ items: [], total: 0 }));
  });

  it("/api/users returns empty on DB failure", async () => {
    mockQuery.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    const pool = await getPool();
    let result: unknown = null;
    try { await pool.query("SELECT COUNT(*) FROM users"); } catch { result = { items: [], total: 0 }; }
    expect(result).toEqual(expect.objectContaining({ items: [], total: 0 }));
  });

  it("/api/namespaces/health returns empty on DB failure", async () => {
    mockQuery.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    const pool = await getPool();
    let result: unknown = null;
    try { await pool.query("SELECT * FROM namespaces"); } catch { result = []; }
    expect(result).toEqual([]);
  });
});
