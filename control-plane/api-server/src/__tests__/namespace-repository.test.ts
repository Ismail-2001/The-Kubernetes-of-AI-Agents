import { NamespaceRepository } from "../namespaces/repository";

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

interface StoreRow {
  id: string;
  slug: string;
  display_name: string;
  tier: string;
  owner_id: string;
  max_agents: number;
  max_concurrent_executions: number;
  max_memory_mb: number;
  max_tool_calls_per_minute: number;
  created_at: Date;
  updated_at: Date;
  suspended_at: Date | null;
  deleted_at: Date | null;
}

const store = new Map<string, StoreRow>();

function makeRow(ns: {
  slug: string;
  displayName?: string;
  tier?: string;
  ownerId?: string;
  quotas?: Record<string, number>;
  suspendedAt?: Date;
  deletedAt?: Date;
}): StoreRow {
  return {
    id: `ns-${ns.slug}`,
    slug: ns.slug,
    display_name: ns.displayName ?? `Namespace ${ns.slug}`,
    tier: ns.tier ?? "sandbox",
    owner_id: ns.ownerId ?? "owner-1",
    max_agents: ns.quotas?.maxAgents ?? 5,
    max_concurrent_executions: ns.quotas?.maxConcurrentExecutions ?? 2,
    max_memory_mb: ns.quotas?.maxMemoryMB ?? 512,
    max_tool_calls_per_minute: ns.quotas?.maxToolCallsPerMinute ?? 30,
    created_at: new Date(),
    updated_at: new Date(),
    suspended_at: ns.suspendedAt ?? null,
    deleted_at: ns.deletedAt ?? null,
  };
}

let repo: NamespaceRepository;

beforeAll(() => {
  process.env.POSTGRES_HOST = "127.0.0.1";
  process.env.POSTGRES_PORT = "5432";
  process.env.POSTGRES_DB = "testdb";
  process.env.POSTGRES_USER = "testuser";
  process.env.POSTGRES_PASSWORD = "testpass";
  repo = new NamespaceRepository();
});

beforeEach(() => {
  store.clear();
  mockPool.query.mockReset();
  mockPool.query.mockImplementation(async (sql: string, params: unknown[] = []) => {
    if (sql.includes("INSERT INTO namespaces")) {
      const row = makeRow({
        slug: params[0] as string,
        displayName: params[1] as string,
        tier: params[2] as string,
        ownerId: params[3] as string,
        quotas: {
          maxAgents: params[4] as number,
          maxConcurrentExecutions: params[5] as number,
          maxMemoryMB: params[6] as number,
          maxToolCallsPerMinute: params[7] as number,
        },
      });
      store.set(row.slug, row);
      return { rows: [row], rowCount: 1 };
    }

    if (sql.includes("SELECT COUNT(*)") && sql.includes("FROM namespaces")) {
      let rows = Array.from(store.values()).filter((r) => !r.deleted_at);
      if (sql.includes("owner_id = $1")) {
        rows = rows.filter((r) => r.owner_id === params[0]);
      }
      return { rows: [{ count: String(rows.length) }], rowCount: 1 };
    }

    if (sql.trimStart().startsWith("SELECT * FROM namespaces ns")) {
      let rows = Array.from(store.values()).filter((r) => !r.deleted_at);
      if (sql.includes("owner_id = $1")) {
        rows = rows.filter((r) => r.owner_id === params[0]);
      }
      const tokenMatch = sql.match(/WHERE id = \$(\d+)\) < ns\.created_at/);
      if (tokenMatch) {
        const tokenParamIdx = parseInt(tokenMatch[1]!, 10) - 1;
        const tokenRow = store.get(params[tokenParamIdx] as string);
        if (tokenRow) {
          rows = rows.filter((r) => new Date(r.created_at).getTime() > new Date(tokenRow.created_at).getTime());
        }
      }
      rows.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
      const limit = params[params.length - 1] as number;
      const page = rows.slice(0, limit);
      return { rows: page, rowCount: page.length };
    }

    if (sql.includes("SELECT * FROM namespaces")) {
      const row = store.get(params[0] as string);
      if (!row || row.deleted_at) return { rows: [], rowCount: 0 };
      return { rows: [row], rowCount: 1 };
    }

    if (sql.includes("UPDATE namespaces") && sql.includes("suspended_at = NOW()")) {
      const row = store.get(params[0] as string);
      if (!row || row.deleted_at) return { rows: [], rowCount: 0 };
      row.suspended_at = new Date();
      row.updated_at = new Date();
      return { rows: [row], rowCount: 1 };
    }

    if (sql.includes("UPDATE namespaces") && sql.includes("deleted_at = NOW()")) {
      const row = store.get(params[0] as string);
      if (!row || row.deleted_at) return { rows: [], rowCount: 0 };
      row.deleted_at = new Date();
      row.updated_at = new Date();
      return { rows: [row], rowCount: 1 };
    }

    if (sql.includes("UPDATE namespaces SET")) {
      const slug = params[params.length - 1] as string;
      const row = store.get(slug);
      if (!row || row.deleted_at) return { rows: [], rowCount: 0 };
      const setClause = sql.match(/SET\s+(.+?)\s+WHERE/)?.[1] ?? "";
      const colRegex = /([a-z_]+) = \$(\d+)/g;
      let m: RegExpExecArray | null;
      while ((m = colRegex.exec(setClause)) !== null) {
        const col = m[1];
        const idx = parseInt(m[2]!, 10) - 1;
        if (col === "display_name") row.display_name = params[idx] as string;
        if (col === "max_agents") row.max_agents = params[idx] as number;
        if (col === "max_concurrent_executions") row.max_concurrent_executions = params[idx] as number;
        if (col === "max_memory_mb") row.max_memory_mb = params[idx] as number;
        if (col === "max_tool_calls_per_minute") row.max_tool_calls_per_minute = params[idx] as number;
      }
      row.updated_at = new Date();
      return { rows: [row], rowCount: 1 };
    }

    if (sql.trim() === "SELECT 1") {
      return { rows: [{ "1": 1 }], rowCount: 1 };
    }

    return { rows: [], rowCount: 0 };
  });
});

afterAll(async () => {
  await repo.close();
  delete process.env.POSTGRES_HOST;
  delete process.env.POSTGRES_PORT;
  delete process.env.POSTGRES_DB;
  delete process.env.POSTGRES_USER;
  delete process.env.POSTGRES_PASSWORD;
});

describe("NamespaceRepository — PostgreSQL persistence", () => {
  it("should create a namespace and map quotas", async () => {
    const ns = await repo.create({
      slug: "prod-ns",
      displayName: "Prod Namespace",
      tier: "enterprise",
      ownerId: "owner-9",
      quotas: { maxAgents: 20, maxConcurrentExecutions: 10, maxMemoryMB: 4096, maxToolCallsPerMinute: 120 },
    });
    expect(ns.id).toBe("ns-prod-ns");
    expect(ns.slug).toBe("prod-ns");
    expect(ns.displayName).toBe("Prod Namespace");
    expect(ns.tier).toBe("enterprise");
    expect(ns.ownerId).toBe("owner-9");
    expect(ns.quotas).toEqual({
      maxAgents: 20,
      maxConcurrentExecutions: 10,
      maxMemoryMB: 4096,
      maxToolCallsPerMinute: 120,
    });
  });

  it("should find a namespace by slug", async () => {
    await repo.create({ slug: "find-ns", displayName: "Find", tier: "sandbox", ownerId: "o", quotas: { maxAgents: 5, maxConcurrentExecutions: 2, maxMemoryMB: 512, maxToolCallsPerMinute: 30 } });
    const ns = await repo.findBySlug("find-ns");
    expect(ns).not.toBeNull();
    expect(ns!.displayName).toBe("Find");
  });

  it("should return null for a missing namespace", async () => {
    const ns = await repo.findBySlug("does-not-exist");
    expect(ns).toBeNull();
  });

  it("should list namespaces with total count", async () => {
    await repo.create({ slug: "list-a", displayName: "A", tier: "sandbox", ownerId: "o", quotas: { maxAgents: 5, maxConcurrentExecutions: 2, maxMemoryMB: 512, maxToolCallsPerMinute: 30 } });
    await repo.create({ slug: "list-b", displayName: "B", tier: "sandbox", ownerId: "o", quotas: { maxAgents: 5, maxConcurrentExecutions: 2, maxMemoryMB: 512, maxToolCallsPerMinute: 30 } });
    const result = await repo.list({ pageSize: 10 });
    expect(result.totalCount).toBe(2);
    expect(result.namespaces).toHaveLength(2);
  });

  it("should filter namespaces by owner", async () => {
    await repo.create({ slug: "owner-a", displayName: "A", tier: "sandbox", ownerId: "alice", quotas: { maxAgents: 5, maxConcurrentExecutions: 2, maxMemoryMB: 512, maxToolCallsPerMinute: 30 } });
    await repo.create({ slug: "owner-b", displayName: "B", tier: "sandbox", ownerId: "bob", quotas: { maxAgents: 5, maxConcurrentExecutions: 2, maxMemoryMB: 512, maxToolCallsPerMinute: 30 } });
    const result = await repo.list({ ownerId: "alice" });
    expect(result.namespaces).toHaveLength(1);
    expect(result.namespaces[0]!.slug).toBe("owner-a");
  });

  it("should paginate and set nextPageToken when more results exist", async () => {
    for (let i = 0; i < 5; i++) {
      await repo.create({ slug: `page-${i}`, displayName: `P${i}`, tier: "sandbox", ownerId: "o", quotas: { maxAgents: 5, maxConcurrentExecutions: 2, maxMemoryMB: 512, maxToolCallsPerMinute: 30 } });
    }
    const page1 = await repo.list({ pageSize: 2 });
    expect(page1.namespaces).toHaveLength(2);
    expect(page1.nextPageToken).toBeTruthy();

    const page2 = await repo.list({ pageSize: 2, pageToken: page1.nextPageToken });
    expect(page2.namespaces).toHaveLength(2);
  });

  it("should update display name and quotas", async () => {
    await repo.create({ slug: "up-ns", displayName: "Old", tier: "sandbox", ownerId: "o", quotas: { maxAgents: 5, maxConcurrentExecutions: 2, maxMemoryMB: 512, maxToolCallsPerMinute: 30 } });
    const updated = await repo.update("up-ns", { displayName: "New", quotas: { maxAgents: 10 } });
    expect(updated).not.toBeNull();
    expect(updated!.displayName).toBe("New");
    expect(updated!.quotas.maxAgents).toBe(10);
  });

  it("should return null when updating a missing namespace", async () => {
    const updated = await repo.update("missing-ns", { displayName: "X" });
    expect(updated).toBeNull();
  });

  it("should suspend a namespace", async () => {
    await repo.create({ slug: "sus-ns", displayName: "Sus", tier: "sandbox", ownerId: "o", quotas: { maxAgents: 5, maxConcurrentExecutions: 2, maxMemoryMB: 512, maxToolCallsPerMinute: 30 } });
    const ns = await repo.suspend("sus-ns");
    expect(ns).not.toBeNull();
    expect(ns!.suspendedAt).toBeDefined();
  });

  it("should return null when suspending a missing namespace", async () => {
    const ns = await repo.suspend("missing-ns");
    expect(ns).toBeNull();
  });

  it("should soft delete a namespace and exclude from queries", async () => {
    await repo.create({ slug: "del-ns", displayName: "Del", tier: "sandbox", ownerId: "o", quotas: { maxAgents: 5, maxConcurrentExecutions: 2, maxMemoryMB: 512, maxToolCallsPerMinute: 30 } });
    const ns = await repo.softDelete("del-ns");
    expect(ns).not.toBeNull();
    expect(ns!.deletedAt).toBeDefined();

    const found = await repo.findBySlug("del-ns");
    expect(found).toBeNull();
  });

  it("should return null when deleting a missing namespace", async () => {
    const ns = await repo.softDelete("missing-ns");
    expect(ns).toBeNull();
  });

  it("should ping successfully", async () => {
    await expect(repo.ping()).resolves.toBe(true);
  });

  it("should return false when ping fails", async () => {
    mockPool.query.mockRejectedValueOnce(new Error("connection refused"));
    await expect(repo.ping()).resolves.toBe(false);
  });

  it("should close the pool", async () => {
    await repo.close();
    expect(mockPool.end).toHaveBeenCalled();
  });
});
