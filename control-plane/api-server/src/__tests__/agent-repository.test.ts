import { AgentRepository, resetAgentRepository } from "../agents/repository";

const mockPool = {
  query: jest.fn(),
  end: jest.fn().mockResolvedValue(undefined),
  connect: jest.fn().mockResolvedValue({ query: jest.fn(), release: jest.fn() }),
};

jest.mock("pg", () => ({
  Pool: jest.fn(() => mockPool),
  Client: jest.fn(() => ({
    connect: jest.fn(),
    query: jest.fn(),
    end: jest.fn(),
  })),
}));

function makeInsertRow(params?: unknown[]) {
  return {
    rows: [{
      id: params?.[0] ?? "mock-uuid",
      namespace: params?.[1] ?? "",
      name: params?.[2] ?? "",
      api_version: params?.[3] ?? "egaop.io/v1",
      kind: params?.[4] ?? "Agent",
      spec: typeof params?.[5] === "string" ? JSON.parse(params[5] as string) : (params?.[5] ?? {}),
      status: typeof params?.[6] === "string" ? JSON.parse(params[6] as string) : (params?.[6] ?? { phase: "Pending", health_status: "Healthy" }),
      labels: typeof params?.[7] === "string" ? JSON.parse(params[7] as string) : (params?.[7] ?? {}),
      annotations: typeof params?.[8] === "string" ? JSON.parse(params[8] as string) : (params?.[8] ?? {}),
      version: 1,
      created_by: params?.[9] ?? "",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      deleted_at: null,
    }],
    rowCount: 1,
  };
}

function makeSelectRow(overrides?: Record<string, unknown>) {
  const base = {
    id: "mock-id",
    namespace: "default",
    name: "test-agent",
    api_version: "egaop.io/v1",
    kind: "Agent",
    spec: {},
    status: { phase: "Pending", health_status: "Healthy" },
    labels: {},
    annotations: {},
    version: 1,
    created_by: "",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    deleted_at: null,
  };
  return { ...base, ...overrides };
}

let repo: AgentRepository;

beforeAll(() => {
  repo = new AgentRepository({
    host: "127.0.0.1",
    port: 5432,
    database: "testdb",
    user: "testuser",
    password: "testpass",
  });
});

afterAll(async () => {
  await repo.close();
  resetAgentRepository();
});

describe("AgentRepository — PostgreSQL persistence", () => {
  it("should create and retrieve an agent", async () => {
    mockPool.query.mockImplementation((_sql: string, params?: unknown[]) =>
      Promise.resolve(makeInsertRow(params))
    );

    const agent = await repo.create({
      namespace: "default",
      name: "test-agent",
      spec: { description: "test" },
    });

    expect(agent.id).toBeDefined();
    expect(agent.namespace).toBe("default");
    expect(agent.name).toBe("test-agent");
    expect(agent.api_version).toBe("egaop.io/v1");
    expect(agent.kind).toBe("Agent");
    expect(agent.version).toBe(1);
    expect(agent.spec).toEqual({ description: "test" });
    expect(agent.status).toEqual({ phase: "Pending", health_status: "Healthy" });
    expect(agent.deleted_at).toBeNull();

    mockPool.query.mockResolvedValueOnce({
      rows: [makeSelectRow({ id: agent.id, namespace: "default", name: "test-agent" })],
      rowCount: 1,
    });

    const found = await repo.findByNamespaceAndName("default", "test-agent");
    expect(found).not.toBeNull();
    expect(found!.id).toBe(agent.id);
  });

  it("should enforce unique namespace+name constraint", async () => {
    mockPool.query.mockImplementation((_sql: string, params?: unknown[]) =>
      Promise.resolve(makeInsertRow(params))
    );

    await repo.create({ namespace: "default", name: "dup-agent" });

    mockPool.query.mockRejectedValueOnce(new Error("duplicate key value violates unique constraint"));

    await expect(
      repo.create({ namespace: "default", name: "dup-agent" })
    ).rejects.toThrow();
  });

  it("should list agents by namespace", async () => {
    mockPool.query.mockImplementation((_sql: string, params?: unknown[]) =>
      Promise.resolve(makeInsertRow(params))
    );

    await repo.create({ namespace: "list-ns", name: "alpha" });
    await repo.create({ namespace: "list-ns", name: "beta" });

    mockPool.query.mockResolvedValueOnce({ rows: [{ total: "2" }], rowCount: 1 });
    mockPool.query.mockResolvedValueOnce({
      rows: [
        makeSelectRow({ id: "a1", namespace: "list-ns", name: "alpha" }),
        makeSelectRow({ id: "a2", namespace: "list-ns", name: "beta" }),
      ],
      rowCount: 2,
    });

    const result = await repo.listByNamespace("list-ns");
    expect(result.agents).toHaveLength(2);
    expect(result.totalCount).toBe(2);
  });

  it("should not leak agents between namespaces", async () => {
    mockPool.query.mockImplementation((_sql: string, params?: unknown[]) =>
      Promise.resolve(makeInsertRow(params))
    );

    await repo.create({ namespace: "ns-a", name: "leak-test" });

    mockPool.query.mockResolvedValueOnce({ rows: [{ total: "0" }], rowCount: 1 });
    mockPool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const result = await repo.listByNamespace("ns-b");
    expect(result.agents).toHaveLength(0);
    expect(result.totalCount).toBe(0);

    mockPool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const found = await repo.findByNamespaceAndName("ns-b", "leak-test");
    expect(found).toBeNull();
  });

  it("should update spec, labels, and version", async () => {
    mockPool.query.mockImplementation((_sql: string, params?: unknown[]) =>
      Promise.resolve(makeInsertRow(params))
    );

    await repo.create({ namespace: "update-ns", name: "update-me", spec: { description: "original" }, labels: { env: "dev" } });

    mockPool.query.mockResolvedValueOnce({
      rows: [makeSelectRow({
        id: "update-id", namespace: "update-ns", name: "update-me",
        spec: { description: "updated" }, labels: { env: "prod" }, version: 2,
      })],
      rowCount: 1,
    });

    const updated = await repo.update("update-ns", "update-me", {
      spec: { description: "updated" },
      labels: { env: "prod" },
    });

    expect(updated).not.toBeNull();
    expect(updated!.spec).toEqual({ description: "updated" });
    expect(updated!.labels).toEqual({ env: "prod" });
    expect(updated!.version).toBe(2);
  });

  it("should soft delete and exclude from queries", async () => {
    mockPool.query.mockImplementation((_sql: string, params?: unknown[]) =>
      Promise.resolve(makeInsertRow(params))
    );

    await repo.create({ namespace: "default", name: "soft-delete-me" });

    mockPool.query.mockResolvedValueOnce({
      rows: [makeSelectRow({ id: "del-id", namespace: "default", name: "soft-delete-me", deleted_at: new Date().toISOString() })],
      rowCount: 1,
    });

    const deleted = await repo.softDelete("default", "soft-delete-me");
    expect(deleted).not.toBeNull();
    expect(deleted!.deleted_at).not.toBeNull();

    mockPool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const found = await repo.findByNamespaceAndName("default", "soft-delete-me");
    expect(found).toBeNull();
  });

  it("should return null for non-existent agent", async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const found = await repo.findByNamespaceAndName("default", "no-such-agent");
    expect(found).toBeNull();
  });

  it("should filter by phase", async () => {
    mockPool.query.mockImplementation((_sql: string, params?: unknown[]) =>
      Promise.resolve(makeInsertRow(params))
    );

    await repo.create({ namespace: "filter-ns", name: "running-agent", status: { phase: "Running", health_status: "Healthy" } });
    await repo.create({ namespace: "filter-ns", name: "pending-agent", status: { phase: "Pending", health_status: "Healthy" } });

    mockPool.query.mockResolvedValueOnce({ rows: [{ total: "1" }], rowCount: 1 });
    mockPool.query.mockResolvedValueOnce({
      rows: [makeSelectRow({ id: "r1", namespace: "filter-ns", name: "running-agent", status: { phase: "Running", health_status: "Healthy" } })],
      rowCount: 1,
    });

    const result = await repo.listByNamespace("filter-ns", { phase: "Running" });
    expect(result.agents).toHaveLength(1);
    expect(result.agents[0]!.name).toBe("running-agent");
  });

  it("should filter by label", async () => {
    mockPool.query.mockImplementation((_sql: string, params?: unknown[]) =>
      Promise.resolve(makeInsertRow(params))
    );

    await repo.create({ namespace: "label-filter-ns", name: "prod-agent", labels: { env: "prod", team: "platform" } });
    await repo.create({ namespace: "label-filter-ns", name: "dev-agent", labels: { env: "dev", team: "platform" } });

    mockPool.query.mockResolvedValueOnce({ rows: [{ total: "1" }], rowCount: 1 });
    mockPool.query.mockResolvedValueOnce({
      rows: [makeSelectRow({ id: "p1", namespace: "label-filter-ns", name: "prod-agent" })],
      rowCount: 1,
    });

    const result = await repo.listByNamespace("label-filter-ns", { labels: { env: "prod" } });
    expect(result.agents).toHaveLength(1);
    expect(result.agents[0]!.name).toBe("prod-agent");
  });

  it("should search by name", async () => {
    mockPool.query.mockImplementation((_sql: string, params?: unknown[]) =>
      Promise.resolve(makeInsertRow(params))
    );

    await repo.create({ namespace: "search-ns", name: "my-special-agent" });
    await repo.create({ namespace: "search-ns", name: "other-agent" });

    mockPool.query.mockResolvedValueOnce({ rows: [{ total: "1" }], rowCount: 1 });
    mockPool.query.mockResolvedValueOnce({
      rows: [makeSelectRow({ id: "s1", namespace: "search-ns", name: "my-special-agent" })],
      rowCount: 1,
    });

    const result = await repo.listByNamespace("search-ns", { search: "special" });
    expect(result.agents).toHaveLength(1);
    expect(result.agents[0]!.name).toBe("my-special-agent");
  });

  it("should paginate with cursor", async () => {
    mockPool.query.mockImplementation((_sql: string, params?: unknown[]) =>
      Promise.resolve(makeInsertRow(params))
    );

    for (let i = 0; i < 5; i++) {
      await repo.create({ namespace: "page-ns", name: `page-${i}` });
    }

    mockPool.query.mockResolvedValueOnce({ rows: [{ total: "5" }], rowCount: 1 });
    mockPool.query.mockResolvedValueOnce({
      rows: [
        makeSelectRow({ id: "p0", namespace: "page-ns", name: "page-0" }),
        makeSelectRow({ id: "p1", namespace: "page-ns", name: "page-1" }),
      ],
      rowCount: 2,
    });

    const page1 = await repo.listByNamespace("page-ns", { pageSize: 2 });
    expect(page1.agents).toHaveLength(2);
    expect(page1.nextCursor).toBeTruthy();

    mockPool.query.mockResolvedValueOnce({ rows: [{ total: "5" }], rowCount: 1 });
    mockPool.query.mockResolvedValueOnce({
      rows: [
        makeSelectRow({ id: "p2", namespace: "page-ns", name: "page-2" }),
        makeSelectRow({ id: "p3", namespace: "page-ns", name: "page-3" }),
      ],
      rowCount: 2,
    });

    const page2 = await repo.listByNamespace("page-ns", { cursor: page1.nextCursor, pageSize: 2 });
    expect(page2.agents).toHaveLength(2);
    expect(page2.nextCursor).toBeTruthy();
  });

  it("should persist data across repository instances (restart simulation)", async () => {
    mockPool.query.mockImplementation((_sql: string, params?: unknown[]) =>
      Promise.resolve(makeInsertRow(params))
    );

    const agent = await repo.create({
      namespace: "restart-ns",
      name: "restart-survivor",
      spec: { persistent: true },
    });

    const repo2 = new AgentRepository({
      host: "127.0.0.1", port: 5432, database: "testdb",
      user: "testuser", password: "testpass",
    });

    try {
      mockPool.query.mockResolvedValueOnce({
        rows: [makeSelectRow({ id: agent.id, namespace: "restart-ns", name: "restart-survivor", spec: { persistent: true } })],
        rowCount: 1,
      });

      const found = await repo2.findByNamespaceAndName("restart-ns", "restart-survivor");
      expect(found).not.toBeNull();
      expect(found!.id).toBe(agent.id);
      expect(found!.name).toBe("restart-survivor");
      expect(found!.spec).toEqual({ persistent: true });

      mockPool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

      const crossNs = await repo2.findByNamespaceAndName("other-ns", "restart-survivor");
      expect(crossNs).toBeNull();
    } finally {
      await repo2.close();
    }
  });
});
