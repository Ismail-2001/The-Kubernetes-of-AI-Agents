import { AgentRepository, resetAgentRepository } from "../agents/repository";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { GenericContainer, Wait } = require("testcontainers");

let pgContainer: any = null;
let repo: AgentRepository | null = null;
let postgresPort = 0;

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

  repo = new AgentRepository({
    host: "127.0.0.1",
    port: postgresPort,
    database: "testdb",
    user: "testuser",
    password: "testpass",
  });
}, 180000);

afterAll(async () => {
  if (repo) await repo.close();
  if (pgContainer) await pgContainer.stop();
  resetAgentRepository();
});

describe("AgentRepository — PostgreSQL persistence", () => {
  it("should create and retrieve an agent", async () => {
    if (!repo) return;

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

    const found = await repo.findByNamespaceAndName("default", "test-agent");
    expect(found).not.toBeNull();
    expect(found!.id).toBe(agent.id);
  });

  it("should enforce unique namespace+name constraint", async () => {
    if (!repo) return;

    await repo.create({
      namespace: "default",
      name: "dup-agent",
    });

    await expect(
      repo.create({
        namespace: "default",
        name: "dup-agent",
      })
    ).rejects.toThrow();
  });

  it("should list agents by namespace", async () => {
    if (!repo) return;

    const ns = "list-ns";
    await repo.create({ namespace: ns, name: "alpha" });
    await repo.create({ namespace: ns, name: "beta" });

    const result = await repo.listByNamespace(ns);
    expect(result.agents).toHaveLength(2);
    expect(result.totalCount).toBe(2);
  });

  it("should not leak agents between namespaces", async () => {
    if (!repo) return;

    await repo.create({ namespace: "ns-a", name: "leak-test" });

    const result = await repo.listByNamespace("ns-b");
    expect(result.agents).toHaveLength(0);
    expect(result.totalCount).toBe(0);

    const found = await repo.findByNamespaceAndName("ns-b", "leak-test");
    expect(found).toBeNull();
  });

  it("should update spec, labels, and version", async () => {
    if (!repo) return;

    const ns = "update-ns";
    await repo.create({
      namespace: ns,
      name: "update-me",
      spec: { description: "original" },
      labels: { env: "dev" },
    });

    const updated = await repo.update(ns, "update-me", {
      spec: { description: "updated" },
      labels: { env: "prod" },
    });

    expect(updated).not.toBeNull();
    expect(updated!.spec).toEqual({ description: "updated" });
    expect(updated!.labels).toEqual({ env: "prod" });
    expect(updated!.version).toBe(2);
  });

  it("should soft delete and exclude from queries", async () => {
    if (!repo) return;

    await repo.create({ namespace: "default", name: "soft-delete-me" });

    const deleted = await repo.softDelete("default", "soft-delete-me");
    expect(deleted).not.toBeNull();
    expect(deleted!.deleted_at).not.toBeNull();

    const found = await repo.findByNamespaceAndName("default", "soft-delete-me");
    expect(found).toBeNull();
  });

  it("should return null for non-existent agent", async () => {
    if (!repo) return;

    const found = await repo.findByNamespaceAndName("default", "no-such-agent");
    expect(found).toBeNull();
  });

  it("should filter by phase", async () => {
    if (!repo) return;

    const ns = "filter-ns";
    await repo.create({
      namespace: ns,
      name: "running-agent",
      status: { phase: "Running", health_status: "Healthy" },
    });
    await repo.create({
      namespace: ns,
      name: "pending-agent",
      status: { phase: "Pending", health_status: "Healthy" },
    });

    const result = await repo.listByNamespace(ns, { phase: "Running" });
    expect(result.agents).toHaveLength(1);
    expect(result.agents[0]!.name).toBe("running-agent");
  });

  it("should filter by label", async () => {
    if (!repo) return;

    const ns = "label-filter-ns";
    await repo.create({
      namespace: ns,
      name: "prod-agent",
      labels: { env: "prod", team: "platform" },
    });
    await repo.create({
      namespace: ns,
      name: "dev-agent",
      labels: { env: "dev", team: "platform" },
    });

    const result = await repo.listByNamespace(ns, { labels: { env: "prod" } });
    expect(result.agents).toHaveLength(1);
    expect(result.agents[0]!.name).toBe("prod-agent");
  });

  it("should search by name", async () => {
    if (!repo) return;

    const ns = "search-ns";
    await repo.create({ namespace: ns, name: "my-special-agent" });
    await repo.create({ namespace: ns, name: "other-agent" });

    const result = await repo.listByNamespace(ns, { search: "special" });
    expect(result.agents).toHaveLength(1);
    expect(result.agents[0]!.name).toBe("my-special-agent");
  });

  it("should paginate with cursor", async () => {
    if (!repo) return;

    const ns = "page-ns";
    for (let i = 0; i < 5; i++) {
      await repo.create({ namespace: ns, name: `page-${i}` });
    }

    const page1 = await repo.listByNamespace(ns, { pageSize: 2 });
    expect(page1.agents).toHaveLength(2);
    expect(page1.nextCursor).toBeTruthy();

    const page2 = await repo.listByNamespace(ns, { cursor: page1.nextCursor, pageSize: 2 });
    expect(page2.agents).toHaveLength(2);
    expect(page2.nextCursor).toBeTruthy();
  });

  it("should persist data across repository instances (restart simulation)", async () => {
    if (!repo) return;

    const ns = "restart-ns";
    const agent = await repo.create({
      namespace: ns,
      name: "restart-survivor",
      spec: { persistent: true },
    });

    // Simulate restart: create new repository instance (same DB)
    const repo2 = new AgentRepository({
      host: "127.0.0.1",
      port: postgresPort,
      database: "testdb",
      user: "testuser",
      password: "testpass",
    });

    try {
      // 1. Agent survives restart in its own namespace
      const found = await repo2.findByNamespaceAndName(ns, "restart-survivor");
      expect(found).not.toBeNull();
      expect(found!.id).toBe(agent.id);
      expect(found!.name).toBe("restart-survivor");
      expect(found!.spec).toEqual({ persistent: true });

      // 2. Namespace scoping survives restart: agent in ns "restart-ns"
      //    should NOT be visible from a different namespace
      const crossNs = await repo2.findByNamespaceAndName("other-ns", "restart-survivor");
      expect(crossNs).toBeNull();
    } finally {
      await repo2.close();
    }
  });
});
