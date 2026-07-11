import { SecretRepository } from "../repository";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { GenericContainer, Wait } = require("testcontainers");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let pgContainer: any = null;
let repo: SecretRepository | null = null;
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

  // Run migration
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

  await client.query(`
    CREATE TABLE IF NOT EXISTS secrets (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        namespace VARCHAR(255) NOT NULL,
        name VARCHAR(255) NOT NULL,
        encrypted_data TEXT NOT NULL,
        type VARCHAR(100) NOT NULL DEFAULT 'api_key',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(namespace, name)
    );

    CREATE INDEX IF NOT EXISTS idx_secrets_namespace_name
        ON secrets (namespace, name);
  `);
  await client.end();

  repo = new SecretRepository({
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
});

describe("SecretRepository — PostgreSQL persistence", () => {
  it("should store and retrieve an encrypted secret", async () => {
    if (!repo) return;

    const encryptedPayload = JSON.stringify({ iv: "aabb", tag: "ccdd", ciphertext: "eeff" });
    await repo.upsert({
      namespace: "default",
      name: "api-key",
      encryptedData: encryptedPayload,
      type: "api_key",
    });

    const found = await repo.get("default", "api-key");
    expect(found).not.toBeNull();
    expect(found!.namespace).toBe("default");
    expect(found!.name).toBe("api-key");
    expect(found!.encryptedData).toBe(encryptedPayload);
    expect(found!.type).toBe("api_key");
  });

  it("should overwrite existing secret on upsert", async () => {
    if (!repo) return;

    const payload1 = JSON.stringify({ iv: "11", tag: "22", ciphertext: "33" });
    const payload2 = JSON.stringify({ iv: "44", tag: "55", ciphertext: "66" });

    await repo.upsert({ namespace: "prod", name: "db-pass", encryptedData: payload1, type: "password" });
    await repo.upsert({ namespace: "prod", name: "db-pass", encryptedData: payload2, type: "password" });

    const found = await repo.get("prod", "db-pass");
    expect(found).not.toBeNull();
    expect(found!.encryptedData).toBe(payload2);
  });

  it("should return null for non-existent secret", async () => {
    if (!repo) return;

    const found = await repo.get("default", "nonexistent");
    expect(found).toBeNull();
  });

  it("should namespace secrets independently", async () => {
    if (!repo) return;

    const payloadA = JSON.stringify({ iv: "aa", tag: "bb", ciphertext: "cc" });
    const payloadB = JSON.stringify({ iv: "dd", tag: "ee", ciphertext: "ff" });

    await repo.upsert({ namespace: "team-a", name: "shared-key", encryptedData: payloadA, type: "api_key" });
    await repo.upsert({ namespace: "team-b", name: "shared-key", encryptedData: payloadB, type: "api_key" });

    const a = await repo.get("team-a", "shared-key");
    const b = await repo.get("team-b", "shared-key");
    expect(a!.encryptedData).toBe(payloadA);
    expect(b!.encryptedData).toBe(payloadB);
    expect(a!.encryptedData).not.toBe(b!.encryptedData);
  });

  it("should delete a secret", async () => {
    if (!repo) return;

    await repo.upsert({ namespace: "del", name: "to-delete", encryptedData: "x", type: "api_key" });
    const deleted = await repo.delete("del", "to-delete");
    expect(deleted).toBe(true);

    const found = await repo.get("del", "to-delete");
    expect(found).toBeNull();
  });

  it("should return false when deleting non-existent secret", async () => {
    if (!repo) return;

    const deleted = await repo.delete("default", "no-such-thing");
    expect(deleted).toBe(false);
  });

  it("should list secrets for a namespace", async () => {
    if (!repo) return;

    await repo.upsert({ namespace: "list-ns", name: "key-1", encryptedData: "a", type: "api_key" });
    await repo.upsert({ namespace: "list-ns", name: "key-2", encryptedData: "b", type: "password" });
    await repo.upsert({ namespace: "other-ns", name: "key-3", encryptedData: "c", type: "api_key" });

    const keys = await repo.list("list-ns");
    expect(keys).toHaveLength(2);
    expect(keys).toContain("key-1");
    expect(keys).toContain("key-2");
    expect(keys).not.toContain("key-3");
  });

  // ─── THIS IS THE FAILING TEST ──────────────────────────────────────────
  // It proves the current in-memory Map loses data on restart.
  // After we wire in the pg-backed repository, this test will pass.
  it("should persist data across repository instances (restart simulation)", async () => {
    if (!repo) return;

    // Store a secret with the first repository instance
    const payload = JSON.stringify({ iv: "restart-iv", tag: "restart-tag", ciphertext: "restart-data" });
    await repo.upsert({
      namespace: "restart-test",
      name: "critical-api-key",
      encryptedData: payload,
      type: "api_key",
    });

    // Simulate restart: create a new repository instance pointing at the same DB
    const repo2 = new SecretRepository({
      host: "127.0.0.1",
      port: postgresPort,
      database: "testdb",
      user: "testuser",
      password: "testpass",
    });

    try {
      // Data MUST survive restart — this is the whole point of durability
      const found = await repo2.get("restart-test", "critical-api-key");
      expect(found).not.toBeNull();
      expect(found!.encryptedData).toBe(payload);
      expect(found!.type).toBe("api_key");
    } finally {
      await repo2.close();
    }
  });

  it("should throw when database is unreachable", async () => {
    // Point at a port that doesn't exist
    const badRepo = new SecretRepository({
      host: "127.0.0.1",
      port: 1,
      database: "testdb",
      user: "testuser",
      password: "testpass",
    });

    try {
      await expect(badRepo.get("default", "any")).rejects.toThrow();
    } finally {
      await badRepo.close();
    }
  });

  it("should throw on upsert when database is unreachable", async () => {
    const badRepo = new SecretRepository({
      host: "127.0.0.1",
      port: 1,
      database: "testdb",
      user: "testuser",
      password: "testpass",
    });

    try {
      await expect(
        badRepo.upsert({ namespace: "x", name: "y", encryptedData: "z", type: "api_key" })
      ).rejects.toThrow();
    } finally {
      await badRepo.close();
    }
  });
});
