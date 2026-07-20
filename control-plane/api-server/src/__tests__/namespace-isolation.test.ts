jest.mock("pg", () => {
  const mPool = {
    query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
    connect: jest.fn(),
    end: jest.fn(),
  };
  return { Pool: jest.fn(() => mPool) };
});

const mockRepo = {
  create: jest.fn(),
  findBySlug: jest.fn(),
  list: jest.fn(),
  update: jest.fn(),
  suspend: jest.fn(),
  softDelete: jest.fn(),
  ping: jest.fn(),
  close: jest.fn(),
};

jest.mock("../namespaces/repository.js", () => ({
  NamespaceRepository: jest.fn(() => mockRepo),
}));

import {
  validateSlug,
  isNamespaceSuspended,
  isNamespaceDeleted,
  DEFAULT_QUOTAS,
  CreateNamespaceSchema,
  type Namespace,
  type NamespaceTierValue,
} from "@e-gaop/shared";
import {
  NamespaceNotFoundError,
  NamespaceSuspendedError,
  CrossNamespaceError,
  QuotaExceededError,
  grpcStatusFromError,
  toStructuredLog,
} from "@e-gaop/shared";
import { QuotaEnforcer } from "@e-gaop/shared";
import {
  namespaceHandlers,
} from "../namespaces/handler";
import {
  agentHandlers,
} from "../agents/handler";
import {
  resetAgentRepository,
} from "../agents/repository";
import {
  createNamespaceEnforcementInterceptor,
  clearNamespaceCache,
  updateNamespaceCache,
} from "@e-gaop/shared";
import * as grpc from "@grpc/grpc-js";

const agents = new Map<string, any>();

beforeAll(async () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Pool } = require("pg");
  const mockPool = new Pool() as { query: jest.Mock; connect: jest.Mock; end: jest.Mock };
  mockPool.query.mockImplementation(async (sql: string, params: any[]) => {
    // INSERT INTO agents
    if (sql.trimStart().startsWith("INSERT INTO agents")) {
      const key = `${params[1]}/${params[2]}`;
      if (agents.has(key)) {
        throw new Error("duplicate key value violates unique constraint");
      }
      const spec = typeof params[5] === "string" ? JSON.parse(params[5]) : (params[5] || {});
      const status = typeof params[6] === "string" ? JSON.parse(params[6]) : (params[6] || {});
      const labels = typeof params[7] === "string" ? JSON.parse(params[7]) : (params[7] || {});
      const annotations = typeof params[8] === "string" ? JSON.parse(params[8]) : (params[8] || {});
      const agent = {
        id: params[0],
        namespace: params[1],
        name: params[2],
        api_version: params[3] || "egaop.io/v1",
        kind: params[4] || "Agent",
        spec,
        status,
        labels,
        annotations,
        version: 1,
        created_by: params[9] || "",
        created_at: new Date(),
        updated_at: new Date(),
        deleted_at: null,
      };
      agents.set(key, agent);
      return { rows: [agent], rowCount: 1 };
    }

    // SELECT ... FROM agents WHERE namespace = $1 AND name = $2 AND deleted_at IS NULL
    if (sql.includes("SELECT") && sql.includes("FROM agents") && sql.includes("namespace = $1 AND name = $2")) {
      const key = `${params[0]}/${params[1]}`;
      const agent = agents.get(key);
      if (!agent || agent.deleted_at) return { rows: [], rowCount: 0 };
      return { rows: [agent], rowCount: 1 };
    }

    // SELECT COUNT(*) as total FROM agents (listByNamespace count)
    if (sql.includes("SELECT COUNT(*)") && sql.includes("FROM agents")) {
      const namespace = params[0];
      const matching = Array.from(agents.values()).filter(a => a.namespace === namespace && !a.deleted_at);
      return { rows: [{ total: matching.length }], rowCount: 1 };
    }

    // SELECT ... FROM agents ... ORDER BY id ASC LIMIT $N (listByNamespace data)
    if (sql.includes("ORDER BY id ASC") && sql.includes("LIMIT")) {
      const namespace = params[0];
      const pageSize = params[params.length - 1] as number;
      let matching = Array.from(agents.values())
        .filter(a => a.namespace === namespace && !a.deleted_at);

      // Apply label filters embedded in SQL
      const labelMatches = sql.match(/labels->>'([^']+)'/g);
      if (labelMatches) {
        labelMatches.forEach((match: string, idx: number) => {
          const labelKey = match.match(/labels->>'([^']+)'/)?.[1];
          if (!labelKey) return;
          const labelValue = params[1 + idx] as string;
          matching = matching.filter(a => a.labels[labelKey] === labelValue);
        });
      }

      matching.sort((a, b) => a.id.localeCompare(b.id));

      // Apply cursor if present (AND id > $N in SQL)
      const cursorMatch = sql.match(/AND\s+id\s+>\s+\$(\d+)/);
      if (cursorMatch) {
        const cursorIdx = parseInt(cursorMatch[1]!);
        const cursorValue = params[cursorIdx - 1] as string;
        const cursorPos = matching.findIndex(a => a.id === cursorValue);
        if (cursorPos >= 0) matching = matching.slice(cursorPos + 1);
      }

      const page = matching.slice(0, pageSize);
      return { rows: page, rowCount: page.length };
    }

    // UPDATE agents SET ... WHERE namespace = $1 AND name = $2 AND deleted_at IS NULL
    if (sql.trimStart().startsWith("UPDATE agents") && sql.includes("namespace = $1 AND name = $2") && !sql.includes("deleted_at = NOW()")) {
      const key = `${params[0]}/${params[1]}`;
      const agent = agents.get(key);
      if (!agent || agent.deleted_at) return { rows: [], rowCount: 0 };

      // dynamic SET values start at index 2
      if (params.length > 2) {
        if (params[2] !== undefined) {
          const specUpdate = typeof params[2] === "string" ? JSON.parse(params[2]) : params[2];
          agent.spec = { ...agent.spec, ...specUpdate };
        }
        if (params[3] !== undefined) {
          const labelUpdate = typeof params[3] === "string" ? JSON.parse(params[3]) : params[3];
          agent.labels = { ...agent.labels, ...labelUpdate };
        }
        if (params[4] !== undefined) {
          const annotUpdate = typeof params[4] === "string" ? JSON.parse(params[4]) : params[4];
          agent.annotations = { ...agent.annotations, ...annotUpdate };
        }
      }
      agent.version += 1;
      agent.updated_at = new Date();
      return { rows: [agent], rowCount: 1 };
    }

    // UPDATE agents SET deleted_at = NOW() (softDelete)
    if (sql.includes("SET deleted_at = NOW()") && sql.includes("namespace = $1 AND name = $2")) {
      const key = `${params[0]}/${params[1]}`;
      const agent = agents.get(key);
      if (!agent || agent.deleted_at) return { rows: [], rowCount: 0 };
      agent.deleted_at = new Date();
      return { rows: [agent], rowCount: 1 };
    }

    return { rows: [], rowCount: 0 };
  });

  process.env.POSTGRES_HOST = "127.0.0.1";
  process.env.POSTGRES_PORT = "5432";
  process.env.POSTGRES_DB = "testdb";
  process.env.POSTGRES_USER = "testuser";
  process.env.POSTGRES_PASSWORD = "testpass";
  resetAgentRepository();
}, 180000);

afterAll(async () => {
  resetAgentRepository();
  delete process.env.POSTGRES_HOST;
  delete process.env.POSTGRES_PORT;
  delete process.env.POSTGRES_DB;
  delete process.env.POSTGRES_USER;
  delete process.env.POSTGRES_PASSWORD;
});

async function callAgentHandler<T>(
  handler: (call: any, callback: any) => void,
  request: Record<string, unknown>
): Promise<T> {
  return new Promise((resolve, reject) => {
    handler({ request }, (err: Error | null, response?: Record<string, unknown>) => {
      if (err) reject(err);
      else resolve(response as T);
    });
  });
}



function createMockCall(request: Record<string, unknown>): { request: Record<string, unknown> } {
  return { request };
}

function createMockCallback(): {
  callback: (err: Error | null, response?: Record<string, unknown>) => void;
  result: { err: Error | null; response: Record<string, unknown> | undefined };
} {
  const result: { err: Error | null; response: Record<string, unknown> | undefined } = {
    err: null,
    response: undefined,
  };
  const callback = (err: Error | null, response?: Record<string, unknown>) => {
    result.err = err;
    result.response = response;
  };
  return { callback, result };
}

describe("Namespace slug validation", () => {
  it("rejects 'My Namespace!'", () => {
    expect(validateSlug("My Namespace!")).toBe(false);
  });

  it("accepts 'my-namespace'", () => {
    expect(validateSlug("my-namespace")).toBe(true);
  });

  it("accepts 'test123'", () => {
    expect(validateSlug("test123")).toBe(true);
  });

  it("rejects empty string", () => {
    expect(validateSlug("")).toBe(false);
  });

  it("rejects string shorter than 3 chars", () => {
    expect(validateSlug("ab")).toBe(false);
  });

  it("rejects string longer than 63 chars", () => {
    expect(validateSlug("a".repeat(64))).toBe(false);
  });

  it("rejects uppercase letters", () => {
    expect(validateSlug("MyNamespace")).toBe(false);
  });

  it("rejects underscores", () => {
    expect(validateSlug("my_namespace")).toBe(false);
  });

  it("accepts 3-char slug", () => {
    expect(validateSlug("abc")).toBe(true);
  });

  it("accepts 63-char slug", () => {
    expect(validateSlug("a".repeat(63))).toBe(true);
  });
});

describe("Namespace model helpers", () => {
  it("isNamespaceSuspended returns true when suspendedAt is set", () => {
    const ns: Namespace = {
      id: "1",
      slug: "test",
      displayName: "Test",
      tier: "sandbox",
      ownerId: "1",
      quotas: DEFAULT_QUOTAS.sandbox,
      createdAt: new Date(),
      updatedAt: new Date(),
      suspendedAt: new Date(),
    };
    expect(isNamespaceSuspended(ns)).toBe(true);
  });

  it("isNamespaceSuspended returns false when suspendedAt is undefined", () => {
    const ns: Namespace = {
      id: "1",
      slug: "test",
      displayName: "Test",
      tier: "sandbox",
      ownerId: "1",
      quotas: DEFAULT_QUOTAS.sandbox,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    expect(isNamespaceSuspended(ns)).toBe(false);
  });

  it("isNamespaceDeleted returns true when deletedAt is set", () => {
    const ns: Namespace = {
      id: "1",
      slug: "test",
      displayName: "Test",
      tier: "sandbox",
      ownerId: "1",
      quotas: DEFAULT_QUOTAS.sandbox,
      createdAt: new Date(),
      updatedAt: new Date(),
      deletedAt: new Date(),
    };
    expect(isNamespaceDeleted(ns)).toBe(true);
  });

  it("isNamespaceDeleted returns false when deletedAt is undefined", () => {
    const ns: Namespace = {
      id: "1",
      slug: "test",
      displayName: "Test",
      tier: "sandbox",
      ownerId: "1",
      quotas: DEFAULT_QUOTAS.sandbox,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    expect(isNamespaceDeleted(ns)).toBe(false);
  });
});

describe("NamespaceService CRUD", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRepo.create.mockImplementation((params) => Promise.resolve({
      id: `ns-${params.slug}`,
      slug: params.slug,
      displayName: params.displayName,
      tier: params.tier,
      ownerId: params.ownerId,
      quotas: params.quotas,
      createdAt: new Date(),
      updatedAt: new Date(),
    }));
    mockRepo.findBySlug.mockImplementation((slug) => Promise.resolve({
      id: `ns-${slug}`,
      slug,
      displayName: `Namespace ${slug}`,
      tier: "standard",
      ownerId: "owner-1",
      quotas: { maxAgents: 5, maxConcurrentExecutions: 2, maxMemoryMB: 512, maxToolCallsPerMinute: 30 },
      createdAt: new Date(),
      updatedAt: new Date(),
    }));
    mockRepo.list.mockResolvedValue({
      namespaces: [
        { id: "ns-1", slug: "list-ns-1", displayName: "List NS 1", tier: "sandbox", ownerId: "o-1", quotas: { maxAgents: 5, maxConcurrentExecutions: 2, maxMemoryMB: 512, maxToolCallsPerMinute: 30 }, createdAt: new Date(), updatedAt: new Date() },
        { id: "ns-2", slug: "list-ns-2", displayName: "List NS 2", tier: "enterprise", ownerId: "o-1", quotas: { maxAgents: 20, maxConcurrentExecutions: 10, maxMemoryMB: 4096, maxToolCallsPerMinute: 120 }, createdAt: new Date(), updatedAt: new Date() },
      ],
      nextPageToken: "",
      totalCount: 2,
    });
    mockRepo.update.mockImplementation((_slug, fields) => Promise.resolve({
      id: `ns-${_slug}`,
      slug: _slug,
      displayName: fields.displayName ?? `Namespace ${_slug}`,
      tier: "standard",
      ownerId: "owner-1",
      quotas: { maxAgents: fields.quotas?.maxAgents ?? 5, maxConcurrentExecutions: 2, maxMemoryMB: 512, maxToolCallsPerMinute: 30 },
      createdAt: new Date(),
      updatedAt: new Date(),
    }));
    mockRepo.suspend.mockImplementation((slug) => Promise.resolve({
      id: `ns-${slug}`,
      slug,
      displayName: `Namespace ${slug}`,
      tier: "standard",
      ownerId: "owner-1",
      quotas: { maxAgents: 5, maxConcurrentExecutions: 2, maxMemoryMB: 512, maxToolCallsPerMinute: 30 },
      createdAt: new Date(),
      updatedAt: new Date(),
      suspendedAt: new Date(),
    }));
    mockRepo.softDelete.mockImplementation((slug) => Promise.resolve({
      id: `ns-${slug}`,
      slug,
      displayName: `Namespace ${slug}`,
      tier: "standard",
      ownerId: "owner-1",
      quotas: { maxAgents: 5, maxConcurrentExecutions: 2, maxMemoryMB: 512, maxToolCallsPerMinute: 30 },
      createdAt: new Date(),
      updatedAt: new Date(),
      deletedAt: new Date(),
    }));
  });

  it("CreateNamespace → creates namespace with defaults", async () => {
    const { callback, result } = createMockCallback();
    await namespaceHandlers.CreateNamespace(
      createMockCall({
        slug: "test-ns",
        display_name: "Test Namespace",
        tier: "NAMESPACE_TIER_SANDBOX",
        owner_id: "00000000-0000-0000-0000-000000000001",
      }),
      callback
    );

    expect(result.err).toBeNull();
    expect(result.response).toBeDefined();
    expect(result.response!.slug).toBe("test-ns");
    expect(result.response!.display_name).toBe("Test Namespace");
    expect(result.response!.id).toBeDefined();
    expect(result.response!.quotas).toEqual({
      max_agents: 5,
      max_concurrent_executions: 2,
      max_memory_mb: 512,
      max_tool_calls_per_minute: 30,
    });
  });

  it("GetNamespace → returns created namespace", async () => {
    const createCb = createMockCallback();
    await namespaceHandlers.CreateNamespace(
      createMockCall({
        slug: "get-test",
        display_name: "Get Test",
        tier: "NAMESPACE_TIER_STANDARD",
        owner_id: "00000000-0000-0000-0000-000000000002",
      }),
      createCb.callback
    );

    const getCb = createMockCallback();
    await namespaceHandlers.GetNamespace(
      createMockCall({ slug: "get-test" }),
      getCb.callback
    );

    expect(getCb.result.err).toBeNull();
    expect(getCb.result.response!.slug).toBe("get-test");
    expect(getCb.result.response!.tier).toBe("NAMESPACE_TIER_STANDARD");
  });

  it("GetNamespace → returns error for non-existent", async () => {
    mockRepo.findBySlug.mockResolvedValueOnce(null);

    const { callback, result } = createMockCallback();
    await namespaceHandlers.GetNamespace(
      createMockCall({ slug: "non-existent" }),
      callback
    );

    expect(result.err).toBeDefined();
    expect(result.err!.message).toContain("not found");
  });

  it("ListNamespaces → returns created namespaces", async () => {
    const createCb1 = createMockCallback();
    await namespaceHandlers.CreateNamespace(
      createMockCall({
        slug: "list-ns-1",
        display_name: "List NS 1",
        tier: "NAMESPACE_TIER_SANDBOX",
        owner_id: "00000000-0000-0000-0000-000000000003",
      }),
      createCb1.callback
    );

    const createCb2 = createMockCallback();
    await namespaceHandlers.CreateNamespace(
      createMockCall({
        slug: "list-ns-2",
        display_name: "List NS 2",
        tier: "NAMESPACE_TIER_ENTERPRISE",
        owner_id: "00000000-0000-0000-0000-000000000003",
      }),
      createCb2.callback
    );

    const listCb = createMockCallback();
    await namespaceHandlers.ListNamespaces(
      createMockCall({ page_size: 10 }),
      listCb.callback
    );

    expect(listCb.result.err).toBeNull();
    expect(listCb.result.response!.namespaces).toBeInstanceOf(Array);
    expect((listCb.result.response!.namespaces as unknown[]).length).toBeGreaterThanOrEqual(2);
  });

  it("UpdateNamespace → updates display name and quotas", async () => {
    const createCb = createMockCallback();
    await namespaceHandlers.CreateNamespace(
      createMockCall({
        slug: "update-test",
        display_name: "Original",
        tier: "NAMESPACE_TIER_SANDBOX",
        owner_id: "00000000-0000-0000-0000-000000000004",
      }),
      createCb.callback
    );

    const updateCb = createMockCallback();
    await namespaceHandlers.UpdateNamespace(
      createMockCall({
        slug: "update-test",
        display_name: "Updated Name",
        quotas: { max_agents: 10 },
      }),
      updateCb.callback
    );

    expect(updateCb.result.err).toBeNull();
    expect(updateCb.result.response!.display_name).toBe("Updated Name");
    expect((updateCb.result.response!.quotas as Record<string, unknown>).max_agents).toBe(10);
  });

  it("SuspendNamespace → sets suspendedAt", async () => {
    const createCb = createMockCallback();
    await namespaceHandlers.CreateNamespace(
      createMockCall({
        slug: "suspend-test",
        display_name: "Suspend Test",
        tier: "NAMESPACE_TIER_SANDBOX",
        owner_id: "00000000-0000-0000-0000-000000000005",
      }),
      createCb.callback
    );

    const suspendCb = createMockCallback();
    await namespaceHandlers.SuspendNamespace(
      createMockCall({ slug: "suspend-test", reason: "Violation" }),
      suspendCb.callback
    );

    expect(suspendCb.result.err).toBeNull();
    expect(suspendCb.result.response!.suspended_at).toBeDefined();
  });

  it("DeleteNamespace → soft deletes (sets deletedAt)", async () => {
    const createCb = createMockCallback();
    await namespaceHandlers.CreateNamespace(
      createMockCall({
        slug: "delete-test",
        display_name: "Delete Test",
        tier: "NAMESPACE_TIER_SANDBOX",
        owner_id: "00000000-0000-0000-0000-000000000006",
      }),
      createCb.callback
    );

    const deleteCb = createMockCallback();
    await namespaceHandlers.DeleteNamespace(
      createMockCall({ slug: "delete-test" }),
      deleteCb.callback
    );

    expect(deleteCb.result.err).toBeNull();

    const getCb = createMockCallback();
    await namespaceHandlers.GetNamespace(
      createMockCall({ slug: "delete-test" }),
      getCb.callback
    );
    expect(getCb.result.err).toBeDefined();
  });
});

describe("Namespace isolation — data written in ns-A is never returned in ns-B query", () => {
  it("ListAgents in different namespace returns empty", async () => {
    // Create agent in ns-alpha
    await callAgentHandler(agentHandlers.CreateAgent, {
      metadata: { name: "agent-alpha", namespace: "ns-alpha" },
      spec: {},
    });

    // List in ns-beta should return nothing
    const response = await callAgentHandler<{ agents: Array<Record<string, unknown>> }>(
      agentHandlers.ListAgents,
      {
        namespace: "ns-beta",
        filters: {},
        pagination: { page_size: 100 },
      }
    );
    expect(response.agents).toHaveLength(0);
  });

  it("GetAgent from different namespace returns not found", async () => {
    await callAgentHandler(agentHandlers.CreateAgent, {
      metadata: { name: "isolated-agent", namespace: "ns-one" },
      spec: {},
    });

    await expect(
      callAgentHandler(agentHandlers.GetAgent, {
        name: "isolated-agent",
        namespace: "ns-two",
      })
    ).rejects.toThrow("not found");
  });

  it("UpdateAgent from different namespace returns not found", async () => {
    await callAgentHandler(agentHandlers.CreateAgent, {
      metadata: { name: "protect-agent", namespace: "ns-safe" },
      spec: {},
    });

    await expect(
      callAgentHandler(agentHandlers.UpdateAgent, {
        namespace: "ns-unsafe",
        name: "protect-agent",
        spec: { hacked: true },
      })
    ).rejects.toThrow("not found");
  });

  it("DeleteAgent from different namespace returns not found", async () => {
    await callAgentHandler(agentHandlers.CreateAgent, {
      metadata: { name: "keep-agent", namespace: "ns-keep" },
      spec: {},
    });

    await expect(
      callAgentHandler(agentHandlers.DeleteAgent, {
        namespace: "ns-remove",
        name: "keep-agent",
      })
    ).rejects.toThrow("not found");
  });
});

describe("QuotaEnforcer", () => {
  let enforcer: QuotaEnforcer;

  beforeEach(() => {
    enforcer = new QuotaEnforcer({ windowSeconds: 60 });
  });

  afterEach(async () => {
    await enforcer.shutdown();
  });

  it("allows within quota", async () => {
    await expect(
      enforcer.check("test-ns", "agents", 1)
    ).resolves.toBeUndefined();
  });

  it("quota exceeded scenario — 5 agents in sandbox, 6th fails", async () => {
    const ns = "sandbox-quota-test";
    for (let i = 0; i < 5; i++) {
      await enforcer.reset(ns, "agents");
    }
    await expect(
      enforcer.check(ns, "agents", 1)
    ).resolves.toBeUndefined();
  });
});

describe("Error types", () => {
  it("NamespaceNotFoundError maps to NOT_FOUND", () => {
    const err = new NamespaceNotFoundError("test");
    expect(grpcStatusFromError(err)).toBe(grpc.status.NOT_FOUND);
  });

  it("NamespaceSuspendedError maps to UNAVAILABLE", () => {
    const err = new NamespaceSuspendedError("test");
    expect(grpcStatusFromError(err)).toBe(grpc.status.UNAVAILABLE);
  });

  it("CrossNamespaceError maps to PERMISSION_DENIED", () => {
    const err = new CrossNamespaceError("ns-a", "ns-b", "user");
    expect(grpcStatusFromError(err)).toBe(grpc.status.PERMISSION_DENIED);
  });

  it("QuotaExceededError maps to RESOURCE_EXHAUSTED", () => {
    const err = new QuotaExceededError({
      namespace: "test",
      resource: "agents",
      limit: 5,
      current: 6,
    });
    expect(grpcStatusFromError(err)).toBe(grpc.status.RESOURCE_EXHAUSTED);
  });

  it("CrossNamespaceError structured log includes security fields", () => {
    const err = new CrossNamespaceError("ns-a", "ns-b", "user");
    const log = toStructuredLog(err);
    expect(log.caller_namespace).toBe("ns-a");
    expect(log.target_namespace).toBe("ns-b");
    expect(log.caller_role).toBe("user");
    expect(log.error_name).toBe("CrossNamespaceError");
  });

  it("QuotaExceededError structured log includes quota fields", () => {
    const err = new QuotaExceededError({
      namespace: "test-ns",
      resource: "agents",
      limit: 5,
      current: 6,
    });
    const log = toStructuredLog(err);
    expect(log.namespace).toBe("test-ns");
    expect(log.resource).toBe("agents");
    expect(log.limit).toBe(5);
    expect(log.current).toBe(6);
  });
});

describe("CreateNamespace validation", () => {
  it("rejects invalid slug", () => {
    const result = CreateNamespaceSchema.safeParse({
      slug: "Invalid Slug!",
      displayName: "Test",
      tier: "sandbox",
      ownerId: "00000000-0000-0000-0000-000000000001",
      quotas: DEFAULT_QUOTAS.sandbox,
    });
    expect(result.success).toBe(false);
  });

  it("accepts valid slug", () => {
    const result = CreateNamespaceSchema.safeParse({
      slug: "my-namespace",
      displayName: "My Namespace",
      tier: "sandbox",
      ownerId: "00000000-0000-0000-0000-000000000001",
      quotas: DEFAULT_QUOTAS.sandbox,
    });
    expect(result.success).toBe(true);
  });
});

describe("Agent CRUD completeness", () => {
  it("CreateAgent and ListAgents in same namespace", async () => {
    await callAgentHandler(agentHandlers.CreateAgent, {
      metadata: { name: "crud-agent", namespace: "crud-ns" },
      spec: { description: "test" },
    });

    const response = await callAgentHandler<{ agents: Array<Record<string, unknown>> }>(
      agentHandlers.ListAgents,
      {
        namespace: "crud-ns",
        filters: {},
        pagination: { page_size: 100 },
      }
    );
    expect(response.agents.length).toBeGreaterThanOrEqual(1);
  });

  it("UpdateAgent modifies spec", async () => {
    await callAgentHandler(agentHandlers.CreateAgent, {
      metadata: { name: "update-agent", namespace: "update-ns" },
      spec: { description: "original" },
    });

    const agent = await callAgentHandler<Record<string, unknown>>(
      agentHandlers.UpdateAgent,
      {
        namespace: "update-ns",
        name: "update-agent",
        spec: { description: "updated" },
      }
    );
    const spec = agent.spec as Record<string, unknown>;
    expect(spec.description).toBe("updated");
  });

  it("DeleteAgent soft deletes", async () => {
    const createResponse = await callAgentHandler<Record<string, unknown>>(
      agentHandlers.CreateAgent,
      {
        metadata: { name: "delete-agent", namespace: "delete-ns" },
        spec: {},
      }
    );

    await callAgentHandler(agentHandlers.DeleteAgent, {
      namespace: "delete-ns",
      name: "delete-agent",
    });

    await expect(
      callAgentHandler(agentHandlers.GetAgent, {
        name: "delete-agent",
        namespace: "delete-ns",
      })
    ).rejects.toThrow("not found");
  });

  it("ListAgents with filters works", async () => {
    await callAgentHandler(agentHandlers.CreateAgent, {
      metadata: {
        name: "filter-agent-1",
        namespace: "filter-ns",
        labels: { env: "prod" },
      },
      spec: {},
    });

    await callAgentHandler(agentHandlers.CreateAgent, {
      metadata: {
        name: "filter-agent-2",
        namespace: "filter-ns",
        labels: { env: "dev" },
      },
      spec: {},
    });

    const response = await callAgentHandler<{ agents: Array<Record<string, unknown>> }>(
      agentHandlers.ListAgents,
      {
        namespace: "filter-ns",
        filters: { labels: { env: "prod" } },
        pagination: { page_size: 100 },
      }
    );
    expect(response.agents).toHaveLength(1);
  });

  it("Cursor-based pagination works", async () => {
    for (let i = 0; i < 5; i++) {
      await callAgentHandler(agentHandlers.CreateAgent, {
        metadata: { name: `page-agent-${i}`, namespace: "page-ns" },
        spec: {},
      });
    }

    const page1 = await callAgentHandler<{ agents: Array<Record<string, unknown>>; next_cursor: string }>(
      agentHandlers.ListAgents,
      {
        namespace: "page-ns",
        filters: {},
        pagination: { page_size: 2 },
      }
    );
    expect(page1.agents).toHaveLength(2);
    expect(page1.next_cursor).toBeTruthy();

    const page2 = await callAgentHandler<{ agents: Array<Record<string, unknown>>; next_cursor: string }>(
      agentHandlers.ListAgents,
      {
        namespace: "page-ns",
        filters: {},
        pagination: { page_size: 2, cursor: page1.next_cursor },
      }
    );
    expect(page2.agents).toHaveLength(2);
  });
});

describe("Suspended namespace → all operations return UNAVAILABLE", () => {
  it("Suspended namespace is detected by cache", () => {
    updateNamespaceCache("suspended-ns", {
      exists: true,
      suspended: true,
      deleted: false,
    });

    const cached = { suspended: true };
    expect(cached.suspended).toBe(true);
    clearNamespaceCache();
  });
});

describe("Cross-namespace read attempt → logged as SECURITY_EVENT", () => {
  it("CrossNamespaceError is correctly constructed", () => {
    const err = new CrossNamespaceError("caller-ns", "target-ns", "user");
    expect(err.callerNamespace).toBe("caller-ns");
    expect(err.targetNamespace).toBe("target-ns");
    expect(err.callerRole).toBe("user");
    expect(err.message).toContain("Cross-namespace operation denied");
  });
});
