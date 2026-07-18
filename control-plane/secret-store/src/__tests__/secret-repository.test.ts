import { SecretRepository } from "../repository";

const mockPool = {
  query: jest.fn(),
  end: jest.fn().mockResolvedValue(undefined),
  connect: jest.fn().mockResolvedValue({ query: jest.fn(), release: jest.fn() }),
};

jest.mock("pg", () => ({
  Pool: jest.fn(() => mockPool),
}));

let repo: SecretRepository;

beforeAll(() => {
  repo = new SecretRepository({
    host: "127.0.0.1",
    port: 5432,
    database: "testdb",
    user: "testuser",
    password: "testpass",
  });
});

afterAll(async () => {
  await repo.close();
});

describe("SecretRepository — PostgreSQL persistence", () => {
  it("should store and retrieve an encrypted secret", async () => {
    const encryptedPayload = JSON.stringify({ iv: "aabb", tag: "ccdd", ciphertext: "eeff" });

    mockPool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });
    mockPool.query.mockResolvedValueOnce({
      rows: [{
        id: "mock-id",
        namespace: "default",
        name: "api-key",
        encrypted_data: encryptedPayload,
        type: "api_key",
        created_at: new Date(),
        updated_at: new Date(),
      }],
      rowCount: 1,
    });

    await repo.upsert({ namespace: "default", name: "api-key", encryptedData: encryptedPayload, type: "api_key" });

    const found = await repo.get("default", "api-key");
    expect(found).not.toBeNull();
    expect(found!.namespace).toBe("default");
    expect(found!.name).toBe("api-key");
    expect(found!.encryptedData).toBe(encryptedPayload);
    expect(found!.type).toBe("api_key");
  });

  it("should overwrite existing secret on upsert", async () => {
    const payload1 = JSON.stringify({ iv: "11", tag: "22", ciphertext: "33" });
    const payload2 = JSON.stringify({ iv: "44", tag: "55", ciphertext: "66" });

    mockPool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });
    mockPool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });
    mockPool.query.mockResolvedValueOnce({
      rows: [{
        id: "mock-id", namespace: "prod", name: "db-pass",
        encrypted_data: payload2, type: "password",
        created_at: new Date(), updated_at: new Date(),
      }],
      rowCount: 1,
    });

    await repo.upsert({ namespace: "prod", name: "db-pass", encryptedData: payload1, type: "password" });
    await repo.upsert({ namespace: "prod", name: "db-pass", encryptedData: payload2, type: "password" });

    const found = await repo.get("prod", "db-pass");
    expect(found).not.toBeNull();
    expect(found!.encryptedData).toBe(payload2);
  });

  it("should return null for non-existent secret", async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const found = await repo.get("default", "nonexistent");
    expect(found).toBeNull();
  });

  it("should namespace secrets independently", async () => {
    const payloadA = JSON.stringify({ iv: "aa", tag: "bb", ciphertext: "cc" });
    const payloadB = JSON.stringify({ iv: "dd", tag: "ee", ciphertext: "ff" });

    mockPool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });
    mockPool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });
    mockPool.query.mockResolvedValueOnce({
      rows: [{ id: "id-a", namespace: "team-a", name: "shared-key", encrypted_data: payloadA, type: "api_key", created_at: new Date(), updated_at: new Date() }],
      rowCount: 1,
    });
    mockPool.query.mockResolvedValueOnce({
      rows: [{ id: "id-b", namespace: "team-b", name: "shared-key", encrypted_data: payloadB, type: "api_key", created_at: new Date(), updated_at: new Date() }],
      rowCount: 1,
    });

    await repo.upsert({ namespace: "team-a", name: "shared-key", encryptedData: payloadA, type: "api_key" });
    await repo.upsert({ namespace: "team-b", name: "shared-key", encryptedData: payloadB, type: "api_key" });

    const a = await repo.get("team-a", "shared-key");
    const b = await repo.get("team-b", "shared-key");
    expect(a!.encryptedData).toBe(payloadA);
    expect(b!.encryptedData).toBe(payloadB);
    expect(a!.encryptedData).not.toBe(b!.encryptedData);
  });

  it("should delete a secret", async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });
    mockPool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });
    mockPool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    await repo.upsert({ namespace: "del", name: "to-delete", encryptedData: "x", type: "api_key" });
    const deleted = await repo.delete("del", "to-delete");
    expect(deleted).toBe(true);

    const found = await repo.get("del", "to-delete");
    expect(found).toBeNull();
  });

  it("should return false when deleting non-existent secret", async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const deleted = await repo.delete("default", "no-such-thing");
    expect(deleted).toBe(false);
  });

  it("should list secrets for a namespace", async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });
    mockPool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });
    mockPool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });
    mockPool.query.mockResolvedValueOnce({
      rows: [{ name: "key-1" }, { name: "key-2" }],
      rowCount: 2,
    });

    await repo.upsert({ namespace: "list-ns", name: "key-1", encryptedData: "a", type: "api_key" });
    await repo.upsert({ namespace: "list-ns", name: "key-2", encryptedData: "b", type: "password" });
    await repo.upsert({ namespace: "other-ns", name: "key-3", encryptedData: "c", type: "api_key" });

    const keys = await repo.list("list-ns");
    expect(keys).toHaveLength(2);
    expect(keys).toContain("key-1");
    expect(keys).toContain("key-2");
    expect(keys).not.toContain("key-3");
  });

  it("should persist data across repository instances (restart simulation)", async () => {
    const payload = JSON.stringify({ iv: "restart-iv", tag: "restart-tag", ciphertext: "restart-data" });

    mockPool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });
    mockPool.query.mockResolvedValueOnce({
      rows: [{
        id: "persist-id", namespace: "restart-test", name: "critical-api-key",
        encrypted_data: payload, type: "api_key",
        created_at: new Date(), updated_at: new Date(),
      }],
      rowCount: 1,
    });

    await repo.upsert({ namespace: "restart-test", name: "critical-api-key", encryptedData: payload, type: "api_key" });

    const repo2 = new SecretRepository({
      host: "127.0.0.1", port: 5432, database: "testdb",
      user: "testuser", password: "testpass",
    });

    try {
      const found = await repo2.get("restart-test", "critical-api-key");
      expect(found).not.toBeNull();
      expect(found!.encryptedData).toBe(payload);
      expect(found!.type).toBe("api_key");
    } finally {
      await repo2.close();
    }
  });

  it("should throw when database is unreachable", async () => {
    mockPool.query.mockRejectedValueOnce(new Error("connection error"));

    const badRepo = new SecretRepository({
      host: "127.0.0.1", port: 1, database: "testdb",
      user: "testuser", password: "testpass",
    });

    try {
      await expect(badRepo.get("default", "any")).rejects.toThrow();
    } finally {
      await badRepo.close();
    }
  });

  it("should throw on upsert when database is unreachable", async () => {
    mockPool.query.mockRejectedValueOnce(new Error("connection error"));

    const badRepo = new SecretRepository({
      host: "127.0.0.1", port: 1, database: "testdb",
      user: "testuser", password: "testpass",
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
