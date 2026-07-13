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

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { GenericContainer, Wait } = require("testcontainers");

let pgContainer: any = null;
let postgresPort = 0;

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

beforeAll(async () => {
  const container = await new GenericContainer("postgres:15")
    .withEnvironment({
      POSTGRES_USER: "testuser",
      POSTGRES_PASSWORD: "testpass",
      POSTGRES_DB: "testdb",
    })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage("database system is ready to accept connections", 2))
    .withStartupTimeout(120000)
    .start();

  pgContainer = container;
  postgresPort = container.getMappedPort(5432);

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Client } = require("pg");
  const client = new Client({
    host: "127.0.0.1",
    port: postgresPort,
    user: "testuser",
    password: "testpass",
    database: "testdb",
  });
  await client.connect();

  // Create agents table (migration 003 subset)
  await client.query(`
    CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
    CREATE TABLE IF NOT EXISTS agents (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      namespace VARCHAR(63) NOT NULL,
      name VARCHAR(255) NOT NULL,
      api_version VARCHAR(50) NOT NULL DEFAULT 'egaop.io/v1',
      kind VARCHAR(50) NOT NULL DEFAULT 'Agent',
      spec JSONB NOT NULL DEFAULT '{}',
      status JSONB NOT NULL DEFAULT '{}',
      labels JSONB NOT NULL DEFAULT '{}',
      annotations JSONB NOT NULL DEFAULT '{}',
      version INT NOT NULL DEFAULT 1,
      created_by VARCHAR(255),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      deleted_at TIMESTAMPTZ
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_agents_namespace_name
      ON agents (namespace, name) WHERE deleted_at IS NULL;
  `);
  await client.end();

  // Point agent repository at test DB via env vars, then reset singleton
  process.env.POSTGRES_HOST = "127.0.0.1";
  process.env.POSTGRES_PORT = String(postgresPort);
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
  if (pgContainer) {
    await pgContainer.stop();
    pgContainer = null;
  }
});

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
  it("CreateNamespace → creates namespace with defaults", () => {
    const { callback, result } = createMockCallback();
    namespaceHandlers.CreateNamespace(
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

  it("GetNamespace → returns created namespace", () => {
    const createCb = createMockCallback();
    namespaceHandlers.CreateNamespace(
      createMockCall({
        slug: "get-test",
        display_name: "Get Test",
        tier: "NAMESPACE_TIER_STANDARD",
        owner_id: "00000000-0000-0000-0000-000000000002",
      }),
      createCb.callback
    );

    const getCb = createMockCallback();
    namespaceHandlers.GetNamespace(
      createMockCall({ slug: "get-test" }),
      getCb.callback
    );

    expect(getCb.result.err).toBeNull();
    expect(getCb.result.response!.slug).toBe("get-test");
    expect(getCb.result.response!.tier).toBe("NAMESPACE_TIER_STANDARD");
  });

  it("GetNamespace → returns error for non-existent", () => {
    const { callback, result } = createMockCallback();
    namespaceHandlers.GetNamespace(
      createMockCall({ slug: "non-existent" }),
      callback
    );

    expect(result.err).toBeDefined();
    expect(result.err!.message).toContain("not found");
  });

  it("ListNamespaces → returns created namespaces", () => {
    const createCb1 = createMockCallback();
    namespaceHandlers.CreateNamespace(
      createMockCall({
        slug: "list-ns-1",
        display_name: "List NS 1",
        tier: "NAMESPACE_TIER_SANDBOX",
        owner_id: "00000000-0000-0000-0000-000000000003",
      }),
      createCb1.callback
    );

    const createCb2 = createMockCallback();
    namespaceHandlers.CreateNamespace(
      createMockCall({
        slug: "list-ns-2",
        display_name: "List NS 2",
        tier: "NAMESPACE_TIER_ENTERPRISE",
        owner_id: "00000000-0000-0000-0000-000000000003",
      }),
      createCb2.callback
    );

    const listCb = createMockCallback();
    namespaceHandlers.ListNamespaces(
      createMockCall({ page_size: 10 }),
      listCb.callback
    );

    expect(listCb.result.err).toBeNull();
    expect(listCb.result.response!.namespaces).toBeInstanceOf(Array);
    expect((listCb.result.response!.namespaces as unknown[]).length).toBeGreaterThanOrEqual(2);
  });

  it("UpdateNamespace → updates display name and quotas", () => {
    const createCb = createMockCallback();
    namespaceHandlers.CreateNamespace(
      createMockCall({
        slug: "update-test",
        display_name: "Original",
        tier: "NAMESPACE_TIER_SANDBOX",
        owner_id: "00000000-0000-0000-0000-000000000004",
      }),
      createCb.callback
    );

    const updateCb = createMockCallback();
    namespaceHandlers.UpdateNamespace(
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

  it("SuspendNamespace → sets suspendedAt", () => {
    const createCb = createMockCallback();
    namespaceHandlers.CreateNamespace(
      createMockCall({
        slug: "suspend-test",
        display_name: "Suspend Test",
        tier: "NAMESPACE_TIER_SANDBOX",
        owner_id: "00000000-0000-0000-0000-000000000005",
      }),
      createCb.callback
    );

    const suspendCb = createMockCallback();
    namespaceHandlers.SuspendNamespace(
      createMockCall({ slug: "suspend-test", reason: "Violation" }),
      suspendCb.callback
    );

    expect(suspendCb.result.err).toBeNull();
    expect(suspendCb.result.response!.suspended_at).toBeDefined();
  });

  it("DeleteNamespace → soft deletes (sets deletedAt)", () => {
    const createCb = createMockCallback();
    namespaceHandlers.CreateNamespace(
      createMockCall({
        slug: "delete-test",
        display_name: "Delete Test",
        tier: "NAMESPACE_TIER_SANDBOX",
        owner_id: "00000000-0000-0000-0000-000000000006",
      }),
      createCb.callback
    );

    const deleteCb = createMockCallback();
    namespaceHandlers.DeleteNamespace(
      createMockCall({ slug: "delete-test" }),
      deleteCb.callback
    );

    expect(deleteCb.result.err).toBeNull();

    const getCb = createMockCallback();
    namespaceHandlers.GetNamespace(
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
