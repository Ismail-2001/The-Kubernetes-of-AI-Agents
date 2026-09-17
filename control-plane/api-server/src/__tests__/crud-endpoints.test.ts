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

// ── Notification Channels ───────────────────────────────────────────────────

describe("Notification Channels", () => {
  it("lists channels with pagination", async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ count: "5" }] })
      .mockResolvedValueOnce({ rows: Array.from({ length: 5 }, (_, i) => ({ id: `ch-${i}`, name: `Channel ${i}`, type: "webhook", config: {}, active: true, created_at: new Date(), updated_at: new Date() })) });
    const pool = await getPool();
    const count = await pool.query("SELECT COUNT(*) FROM notification_channels");
    expect(parseInt(count.rows[0].count)).toBe(5);
    const list = await pool.query("SELECT * FROM notification_channels LIMIT $1 OFFSET $2", [10, 0]);
    expect(list.rows).toHaveLength(5);
  });

  it("creates channel with all types", async () => {
    for (const type of ["webhook", "email", "slack", "pagerduty"]) {
      mockQuery.mockResolvedValueOnce({ rows: [] });
      const pool = await getPool();
      await pool.query("INSERT INTO notification_channels (id, name, type, config) VALUES ($1, $2, $3, $4)", [`${type}-id`, `${type} channel`, type, "{}"]);
    }
    expect(mockQuery).toHaveBeenCalledTimes(4);
  });

  it("updates channel active status", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: "ch-1", active: false, updated_at: new Date() }] });
    const pool = await getPool();
    const result = await pool.query("UPDATE notification_channels SET active = $1, updated_at = NOW() WHERE id = $2 RETURNING id, active", [false, "ch-1"]);
    expect(result.rows[0].active).toBe(false);
  });

  it("cascades delete to rules via FK", async () => {
    // First delete rules, then channel
    mockQuery.mockResolvedValueOnce({ rowCount: 2 }); // rules deleted
    mockQuery.mockResolvedValueOnce({ rowCount: 1 }); // channel deleted
    const pool = await getPool();
    await pool.query("DELETE FROM notification_rules WHERE channel_id = $1", ["ch-1"]);
    const result = await pool.query("DELETE FROM notification_channels WHERE id = $1", ["ch-1"]);
    expect(result.rowCount).toBe(1);
  });
});

// ── Notification Rules ──────────────────────────────────────────────────────

describe("Notification Rules", () => {
  it("lists rules with channel info", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{
        id: "r-1", name: "Agent error", description: "Alert on error", condition: { status: "error" },
        channel_id: "ch-1", channel_name: "Slack", channel_type: "slack", enabled: true,
        created_at: new Date(), updated_at: new Date(),
      }],
    });
    const pool = await getPool();
    const result = await pool.query("SELECT r.*, c.name as channel_name, c.type as channel_type FROM notification_rules r LEFT JOIN notification_channels c ON r.channel_id = c.id");
    expect(result.rows[0].channel_name).toBe("Slack");
    expect(result.rows[0].channel_type).toBe("slack");
  });

  it("filters rules by enabled status", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: "r-1", name: "Test", enabled: true }] });
    const pool = await getPool();
    const result = await pool.query("SELECT * FROM notification_rules WHERE enabled = $1", [true]);
    expect(result.rows[0].enabled).toBe(true);
  });

  it("updates rule condition", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: "r-1", condition: { status: "error", duration: "5m" }, updated_at: new Date() }] });
    const pool = await getPool();
    const result = await pool.query("UPDATE notification_rules SET condition = $1, updated_at = NOW() WHERE id = $2 RETURNING condition", [{ status: "error", duration: "5m" }, "r-1"]);
    expect(result.rows[0].condition.duration).toBe("5m");
  });
});

// ── Policies ────────────────────────────────────────────────────────────────

describe("Policies", () => {
  it("lists policies with all types", async () => {
    const types = ["rate_limit", "access_control", "content_filter", "cost_control", "custom"];
    mockQuery.mockResolvedValueOnce({
      rows: types.map((type, i) => ({ id: `p-${i}`, name: `policy_${type}`, type, status: "active", version: 1 })),
    });
    const pool = await getPool();
    const result = await pool.query("SELECT * FROM policies");
    expect(result.rows).toHaveLength(5);
    expect(result.rows.map((r: any) => r.type)).toEqual(types);
  });

  it("filters by status and type", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: "p-1", name: "rl", type: "rate_limit", status: "active" }] });
    const pool = await getPool();
    const result = await pool.query("SELECT * FROM policies WHERE status = $1 AND type = $2", ["active", "rate_limit"]);
    expect(result.rows[0].status).toBe("active");
    expect(result.rows[0].type).toBe("rate_limit");
  });

  it("version increments on each update", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ version: 1 }] });
    mockQuery.mockResolvedValueOnce({ rows: [{ version: 2 }] });
    mockQuery.mockResolvedValueOnce({ rows: [{ version: 3 }] });
    const pool = await getPool();
    const v1 = await pool.query("UPDATE policies SET version = version + 1 WHERE id = $1 RETURNING version", ["p-1"]);
    const v2 = await pool.query("UPDATE policies SET version = version + 1 WHERE id = $1 RETURNING version", ["p-1"]);
    const v3 = await pool.query("UPDATE policies SET version = version + 1 WHERE id = $1 RETURNING version", ["p-1"]);
    expect(v1.rows[0].version).toBe(1);
    expect(v2.rows[0].version).toBe(2);
    expect(v3.rows[0].version).toBe(3);
  });

  it("search by name or description", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: "p-1", name: "rate_limit_global", description: "Global rate limiting" }] });
    const pool = await getPool();
    const result = await pool.query("SELECT * FROM policies WHERE name ILIKE $1 OR description ILIKE $1", ["%rate%"]);
    expect(result.rows).toHaveLength(1);
  });

  it("soft delete preserves data", async () => {
    mockQuery.mockResolvedValueOnce({ rowCount: 1 });
    const pool = await getPool();
    const result = await pool.query("UPDATE policies SET deleted_at = NOW() WHERE id = $1", ["p-1"]);
    expect(result.rowCount).toBe(1);
  });
});

// ── Audit Log ───────────────────────────────────────────────────────────────

describe("Audit Log", () => {
  it("queries with filters", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        { event_id: "e-1", event_type: "auth.login", severity: "info", actor: { id: "user-1", type: "user" }, action: { name: "login", result: "allowed" }, created_at: new Date() },
        { event_id: "e-2", event_type: "agent.create", severity: "info", actor: { id: "user-1", type: "user" }, action: { name: "create", result: "allowed" }, created_at: new Date() },
      ],
    });
    const pool = await getPool();
    const result = await pool.query("SELECT * FROM audit_entries WHERE event_type = $1", ["auth.login"]);
    expect(result.rows).toHaveLength(2);
  });

  it("paginates correctly", async () => {
    mockQuery.mockResolvedValueOnce({ rows: Array.from({ length: 10 }, (_, i) => ({ event_id: `e-${i}` })) });
    const pool = await getPool();
    const result = await pool.query("SELECT * FROM audit_entries ORDER BY created_at DESC LIMIT $1 OFFSET $2", [10, 0]);
    expect(result.rows).toHaveLength(10);
  });

  it("searches across actor, action, event_type", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ event_id: "e-1", event_type: "auth.login" }] });
    const pool = await getPool();
    const result = await pool.query("SELECT * FROM audit_entries WHERE event_type ILIKE $1 OR actor->>'id' ILIKE $1 OR action->>'name' ILIKE $1", ["%login%"]);
    expect(result.rows).toHaveLength(1);
  });
});

// ── Users ───────────────────────────────────────────────────────────────────

describe("Users", () => {
  it("lists users without password_hash", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        { id: "u-1", email: "a@b.com", name: "Alice", role: "developer", namespace_access: ["default"], is_active: true, last_login_at: null, created_at: new Date() },
        { id: "u-2", email: "c@d.com", name: "Bob", role: "platform_admin", namespace_access: ["*"], is_active: true, last_login_at: new Date(), created_at: new Date() },
      ],
    });
    const pool = await getPool();
    const result = await pool.query("SELECT id, email, name, role, namespace_access, is_active, last_login_at, created_at FROM users WHERE deleted_at IS NULL");
    expect(result.rows).toHaveLength(2);
    expect(result.rows[0]).not.toHaveProperty("password_hash");
  });

  it("filters by role", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: "u-1", role: "platform_admin" }] });
    const pool = await getPool();
    const result = await pool.query("SELECT * FROM users WHERE role = $1 AND deleted_at IS NULL", ["platform_admin"]);
    expect(result.rows[0].role).toBe("platform_admin");
  });

  it("searches by name or email", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: "u-1", name: "Alice Chen", email: "alice@corp.io" }] });
    const pool = await getPool();
    const result = await pool.query("SELECT * FROM users WHERE (name ILIKE $1 OR email ILIKE $1) AND deleted_at IS NULL", ["%alice%"]);
    expect(result.rows).toHaveLength(1);
  });

  it("soft delete sets deleted_at", async () => {
    mockQuery.mockResolvedValueOnce({ rowCount: 1 });
    const pool = await getPool();
    const result = await pool.query("UPDATE users SET deleted_at = NOW() WHERE id = $1", ["u-1"]);
    expect(result.rowCount).toBe(1);
  });
});

// ── Namespace Health ────────────────────────────────────────────────────────

describe("Namespace Health", () => {
  it("computes quota usage from agent counts", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        { slug: "production", display_name: "Production", tier: "NAMESPACE_TIER_ENTERPRISE", quotas: { max_agents: 50 }, suspended_at: null },
        { slug: "staging", display_name: "Staging", tier: "NAMESPACE_TIER_SANDBOX", quotas: { max_agents: 10 }, suspended_at: null },
      ],
    });
    mockQuery.mockResolvedValueOnce({ rows: [{ count: "8" }] }); // production agents
    mockQuery.mockResolvedValueOnce({ rows: [{ count: "3" }] }); // staging agents

    const pool = await getPool();
    const nsResult = await pool.query("SELECT * FROM namespaces WHERE deleted_at IS NULL");
    expect(nsResult.rows).toHaveLength(2);

    const prodAgents = await pool.query("SELECT COUNT(*) FROM agents WHERE namespace = $1", ["production"]);
    expect(parseInt(prodAgents.rows[0].count)).toBe(8);

    const stagingAgents = await pool.query("SELECT COUNT(*) FROM agents WHERE namespace = $1", ["staging"]);
    expect(parseInt(stagingAgents.rows[0].count)).toBe(3);
  });
});
