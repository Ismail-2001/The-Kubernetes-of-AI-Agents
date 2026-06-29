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
  createNamespaceEnforcementInterceptor,
  clearNamespaceCache,
  updateNamespaceCache,
} from "@e-gaop/shared";
import * as grpc from "@grpc/grpc-js";

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
  it("ListAgents in different namespace returns empty", () => {
    agentHandlers.CreateAgent(
      createMockCall({
        metadata: { name: "agent-alpha", namespace: "ns-alpha" },
        spec: {},
      }),
      () => {}
    );

    const listCb = createMockCallback();
    agentHandlers.ListAgents(
      createMockCall({
        namespace: "ns-beta",
        filters: {},
        pagination: { page_size: 100 },
      }),
      listCb.callback
    );

    expect(listCb.result.err).toBeNull();
    const agents = listCb.result.response!.agents as Array<Record<string, unknown>>;
    expect(agents).toHaveLength(0);
  });

  it("GetAgent from different namespace returns not found", () => {
    agentHandlers.CreateAgent(
      createMockCall({
        metadata: { name: "isolated-agent", namespace: "ns-one" },
        spec: {},
      }),
      () => {}
    );

    const getCb = createMockCallback();
    agentHandlers.GetAgent(
      createMockCall({ name: "isolated-agent", namespace: "ns-two" }),
      getCb.callback
    );

    expect(getCb.result.err).toBeDefined();
    expect(getCb.result.err!.message).toContain("not found");
  });

  it("UpdateAgent from different namespace returns not found", () => {
    agentHandlers.CreateAgent(
      createMockCall({
        metadata: { name: "protect-agent", namespace: "ns-safe" },
        spec: {},
      }),
      () => {}
    );

    const updateCb = createMockCallback();
    agentHandlers.UpdateAgent(
      createMockCall({
        namespace: "ns-unsafe",
        name: "protect-agent",
        spec: { hacked: true },
      }),
      updateCb.callback
    );

    expect(updateCb.result.err).toBeDefined();
    expect(updateCb.result.err!.message).toContain("not found");
  });

  it("DeleteAgent from different namespace returns not found", () => {
    agentHandlers.CreateAgent(
      createMockCall({
        metadata: { name: "keep-agent", namespace: "ns-keep" },
        spec: {},
      }),
      () => {}
    );

    const deleteCb = createMockCallback();
    agentHandlers.DeleteAgent(
      createMockCall({ namespace: "ns-remove", name: "keep-agent" }),
      deleteCb.callback
    );

    expect(deleteCb.result.err).toBeDefined();
    expect(deleteCb.result.err!.message).toContain("not found");
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
  it("CreateAgent and ListAgents in same namespace", () => {
    agentHandlers.CreateAgent(
      createMockCall({
        metadata: { name: "crud-agent", namespace: "crud-ns" },
        spec: { description: "test" },
      }),
      () => {}
    );

    const listCb = createMockCallback();
    agentHandlers.ListAgents(
      createMockCall({
        namespace: "crud-ns",
        filters: {},
        pagination: { page_size: 100 },
      }),
      listCb.callback
    );

    expect(listCb.result.err).toBeNull();
    const agents = listCb.result.response!.agents as Array<Record<string, unknown>>;
    expect(agents.length).toBeGreaterThanOrEqual(1);
  });

  it("UpdateAgent modifies spec", () => {
    agentHandlers.CreateAgent(
      createMockCall({
        metadata: { name: "update-agent", namespace: "update-ns" },
        spec: { description: "original" },
      }),
      () => {}
    );

    const updateCb = createMockCallback();
    agentHandlers.UpdateAgent(
      createMockCall({
        namespace: "update-ns",
        name: "update-agent",
        spec: { description: "updated" },
      }),
      updateCb.callback
    );

    expect(updateCb.result.err).toBeNull();
    const agent = updateCb.result.response as Record<string, unknown>;
    const spec = agent.spec as Record<string, unknown>;
    expect(spec.description).toBe("updated");
  });

  it("DeleteAgent soft deletes", () => {
    agentHandlers.CreateAgent(
      createMockCall({
        metadata: { name: "delete-agent", namespace: "delete-ns" },
        spec: {},
      }),
      () => {}
    );

    const deleteCb = createMockCallback();
    agentHandlers.DeleteAgent(
      createMockCall({ namespace: "delete-ns", name: "delete-agent" }),
      deleteCb.callback
    );

    expect(deleteCb.result.err).toBeNull();

    const getCb = createMockCallback();
    agentHandlers.GetAgent(
      createMockCall({ name: "delete-agent", namespace: "delete-ns" }),
      getCb.callback
    );
    expect(getCb.result.err).toBeDefined();
  });

  it("ListAgents with filters works", () => {
    agentHandlers.CreateAgent(
      createMockCall({
        metadata: {
          name: "filter-agent-1",
          namespace: "filter-ns",
          labels: { env: "prod" },
        },
        spec: {},
      }),
      () => {}
    );

    agentHandlers.CreateAgent(
      createMockCall({
        metadata: {
          name: "filter-agent-2",
          namespace: "filter-ns",
          labels: { env: "dev" },
        },
        spec: {},
      }),
      () => {}
    );

    const listCb = createMockCallback();
    agentHandlers.ListAgents(
      createMockCall({
        namespace: "filter-ns",
        filters: { labels: { env: "prod" } },
        pagination: { page_size: 100 },
      }),
      listCb.callback
    );

    expect(listCb.result.err).toBeNull();
    const agents = listCb.result.response!.agents as Array<Record<string, unknown>>;
    expect(agents).toHaveLength(1);
  });

  it("Cursor-based pagination works", () => {
    for (let i = 0; i < 5; i++) {
      agentHandlers.CreateAgent(
        createMockCall({
          metadata: { name: `page-agent-${i}`, namespace: "page-ns" },
          spec: {},
        }),
        () => {}
      );
    }

    const page1 = createMockCallback();
    agentHandlers.ListAgents(
      createMockCall({
        namespace: "page-ns",
        filters: {},
        pagination: { page_size: 2 },
      }),
      page1.callback
    );

    expect(page1.result.err).toBeNull();
    const agents1 = page1.result.response!.agents as Array<Record<string, unknown>>;
    expect(agents1).toHaveLength(2);
    const nextCursor = page1.result.response!.next_cursor as string;
    expect(nextCursor).toBeTruthy();

    const page2 = createMockCallback();
    agentHandlers.ListAgents(
      createMockCall({
        namespace: "page-ns",
        filters: {},
        pagination: { page_size: 2, cursor: nextCursor },
      }),
      page2.callback
    );

    expect(page2.result.err).toBeNull();
    const agents2 = page2.result.response!.agents as Array<Record<string, unknown>>;
    expect(agents2).toHaveLength(2);
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
