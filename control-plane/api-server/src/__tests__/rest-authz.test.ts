jest.mock("pg", () => {
  const mPool = {
    query: jest.fn(),
    connect: jest.fn(),
    end: jest.fn(),
    on: jest.fn(),
  };
  return { Pool: jest.fn(() => mPool) };
});

process.env.JWT_SECRET = "test-secret-key-that-is-long-enough-for-validation-32chars";
process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "silent";

import { fastify } from "../index";
import { signJWT } from "@e-gaop/shared";

jest.setTimeout(20000);

const SECRET = "test-secret-key-that-is-long-enough-for-validation-32chars";

function token(overrides?: Record<string, unknown>): string {
  return signJWT(
    {
      sub: "u-1",
      email: "user@example.com",
      name: "Restricted User",
      role: "developer",
      namespace_access: ["team-a"],
      ...overrides,
    },
    SECRET,
    86400
  );
}

const agentRow = {
  id: "agent-x",
  namespace: "default",
  name: "agent-x",
  api_version: "egaop.io/v1",
  kind: "Agent",
  spec: { version: "v1" },
  status: { phase: "Pending", health_status: "Healthy" },
  labels: {},
  annotations: {},
  version: 1,
  created_by: "u-1",
  created_at: new Date(),
  updated_at: new Date(),
  deleted_at: null,
};

const nsRowA = {
  id: "ns-1",
  slug: "team-a",
  display_name: "Team A",
  tier: "NAMESPACE_TIER_SANDBOX",
  quotas: { max_agents: 10, max_concurrent_executions: 5, max_tool_calls_per_minute: 20 },
  owner_id: "u-1",
  created_at: new Date(),
  updated_at: new Date(),
  deleted_at: null,
  suspended_at: null,
};

const nsRowB = {
  id: "ns-2",
  slug: "team-b",
  display_name: "Team B",
  tier: "NAMESPACE_TIER_SANDBOX",
  quotas: { max_agents: 10, max_concurrent_executions: 5, max_tool_calls_per_minute: 20 },
  owner_id: "u-1",
  created_at: new Date(),
  updated_at: new Date(),
  deleted_at: null,
  suspended_at: null,
};

let queries: string[] = [];

beforeAll(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Pool } = require("pg");
  const mockPool = new Pool() as { query: jest.Mock; connect: jest.Mock; end: jest.Mock };
  mockPool.query.mockImplementation(async (sql: string, params: unknown[]) => {
    queries.push(sql);
    const s = sql.trimStart();
    if (s.startsWith("INSERT INTO namespaces")) {
      return {
        rows: [{ ...nsRowA, slug: String(params[0]), display_name: String(params[1]) }],
        rowCount: 1,
      };
    }
    if (s.startsWith("INSERT INTO agents")) {
      return { rows: [agentRow], rowCount: 1 };
    }
    if (sql.includes("FROM audit_entries")) {
      return sql.includes("COUNT")
        ? { rows: [{ count: "0" }], rowCount: 1 }
        : { rows: [], rowCount: 0 };
    }
    if (sql.includes("FROM users")) {
      return sql.includes("COUNT")
        ? { rows: [{ count: "1" }], rowCount: 1 }
        : {
            rows: [{
              id: "u-9",
              email: "other@example.com",
              name: "Other User",
              role: "developer",
              namespace_access: ["default"],
              is_active: true,
              last_login_at: null,
              created_at: new Date(),
            }],
            rowCount: 1,
          };
    }
    if (sql.includes("FROM namespaces")) {
      return sql.includes("COUNT")
        ? { rows: [{ count: "2" }], rowCount: 1 }
        : { rows: [nsRowA, nsRowB], rowCount: 2 };
    }
    if (sql.includes("FROM agents")) {
      if (sql.includes("COUNT")) return { rows: [{ total: "1" }], rowCount: 1 };
      if (sql.includes("ORDER BY id ASC")) return { rows: [agentRow], rowCount: 1 };
      if (sql.includes("name = $2") || params.length <= 2) {
        return { rows: [agentRow], rowCount: 1 };
      }
      return { rows: [agentRow], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  });
});

beforeEach(() => {
  queries = [];
});

describe("P1-1 REST authz fail-closed contract", () => {
  it("unauthenticated mutation is rejected and never reaches the handler", async () => {
    const res = await fastify.inject({
      method: "POST",
      url: "/api/namespaces",
      payload: { name: "sneaky" },
    });
    expect(res.statusCode).toBe(401);
    const inserts = queries.filter((q) => q.includes("INSERT INTO namespaces"));
    expect(inserts).toHaveLength(0);
  });

  it("unauthenticated read is rejected", async () => {
    const res = await fastify.inject({ method: "GET", url: "/api/agents?namespace=default" });
    expect(res.statusCode).toBe(401);
  });

  it("restricted user cannot fetch an agent outside their namespaces (effective default ns)", async () => {
    const res = await fastify.inject({
      method: "GET",
      url: "/api/agents/agent-x",
      headers: { authorization: `Bearer ${token()}` },
    });
    expect(res.statusCode).toBe(403);
  });

  it("restricted user cannot fetch an agent with an explicit foreign namespace", async () => {
    const res = await fastify.inject({
      method: "GET",
      url: "/api/agents/agent-x?namespace=team-b",
      headers: { authorization: `Bearer ${token()}` },
    });
    expect(res.statusCode).toBe(403);
  });

  it("restricted user cannot create a namespace outside their access (body name)", async () => {
    const res = await fastify.inject({
      method: "POST",
      url: "/api/namespaces",
      headers: { authorization: `Bearer ${token()}` },
      payload: { name: "sneaky" },
    });
    expect(res.statusCode).toBe(403);
    const inserts = queries.filter((q) => q.includes("INSERT INTO namespaces"));
    expect(inserts).toHaveLength(0);
  });

  it("user with no namespace access is denied everything", async () => {
    const res = await fastify.inject({
      method: "GET",
      url: "/api/agents?namespace=default",
      headers: { authorization: `Bearer ${token({ namespace_access: [] })}` },
    });
    expect(res.statusCode).toBe(403);
  });

  it("restricted user cannot list agents without an explicit namespace", async () => {
    const res = await fastify.inject({
      method: "GET",
      url: "/api/agents",
      headers: { authorization: `Bearer ${token()}` },
    });
    expect(res.statusCode).toBe(403);
  });

  it("wildcard admin can list agents in any namespace", async () => {
    const res = await fastify.inject({
      method: "GET",
      url: "/api/agents?namespace=anything",
      headers: { authorization: `Bearer ${token({ namespace_access: ["*"] })}` },
    });
    expect(res.statusCode).toBe(200);
  });

  it("GET /api/agents returns 200 with a valid ISO createdAt when an agent exists", async () => {
    const res = await fastify.inject({
      method: "GET",
      url: "/api/agents?namespace=default",
      headers: { authorization: `Bearer ${token({ namespace_access: ["*"] })}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data.items[0].createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("403 on namespace delete prevents any write side effect", async () => {
    const res = await fastify.inject({
      method: "DELETE",
      url: "/api/namespaces/team-b",
      headers: { authorization: `Bearer ${token()}` },
    });
    expect(res.statusCode).toBe(403);
    const writes = queries.filter((q) => q.startsWith("UPDATE namespaces") || q.startsWith("DELETE FROM namespaces"));
    expect(writes).toHaveLength(0);
  });

  it("developer cannot list users (admin-only route)", async () => {
    const res = await fastify.inject({
      method: "GET",
      url: "/api/users",
      headers: { authorization: `Bearer ${token()}` },
    });
    expect(res.statusCode).toBe(403);
  });

  it("restricted user cannot read the unscoped audit log", async () => {
    const res = await fastify.inject({
      method: "GET",
      url: "/api/audit-log",
      headers: { authorization: `Bearer ${token()}` },
    });
    expect(res.statusCode).toBe(403);
  });

  it("namespace list is filtered to the user's namespaces", async () => {
    const res = await fastify.inject({
      method: "GET",
      url: "/api/namespaces",
      headers: { authorization: `Bearer ${token()}` },
    });
    expect(res.statusCode).toBe(200);
    const items = res.json().data.items as Array<{ name: string }>;
    expect(items.map((i) => i.name)).toEqual(["team-a"]);
  });

  it("restricted user can read a namespace inside their access", async () => {
    const res = await fastify.inject({
      method: "GET",
      url: "/api/agents?namespace=team-a",
      headers: { authorization: `Bearer ${token()}` },
    });
    expect(res.statusCode).toBe(200);
  });
});
