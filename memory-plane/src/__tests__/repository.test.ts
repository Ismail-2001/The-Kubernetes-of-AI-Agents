import { MemoryPlaneRepository } from "../repository";

const mockPool = {
  query: jest.fn(),
  end: jest.fn().mockResolvedValue(undefined),
  connect: jest.fn().mockResolvedValue({ query: jest.fn(), release: jest.fn() }),
};

jest.mock("pg", () => ({
  Pool: jest.fn(() => mockPool),
}));

function makeMemoryRow(overrides?: Record<string, unknown>) {
  return {
    id: "mock-id",
    namespace: "ns-1",
    agent_id: "agent-1",
    key: "key-1",
    value: { data: "test" },
    embedding: null,
    created_at: new Date(),
    updated_at: new Date(),
    expires_at: null,
    ...overrides,
  };
}

const pool = mockPool as unknown as any;
let repo: MemoryPlaneRepository;

beforeAll(() => {
  repo = new MemoryPlaneRepository(pool);
});

afterAll(async () => {
  await pool.end();
});

describe("MemoryPlaneRepository", () => {
  describe("set / get round-trip", () => {
    it("should persist and retrieve a memory entry", async () => {
      const value = { message: "Hello, world" };

      mockPool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });
      mockPool.query.mockResolvedValueOnce({
        rows: [makeMemoryRow({ key: "key-1", value })],
        rowCount: 1,
      });

      await repo.set("ns-1", "agent-1", "key-1", value);

      const result = await repo.get("ns-1", "agent-1", "key-1");

      expect(result).not.toBeNull();
      expect(result!.namespace).toBe("ns-1");
      expect(result!.agentId).toBe("agent-1");
      expect(result!.key).toBe("key-1");
      expect(result!.value).toEqual(value);
      expect(result!.id).toBeDefined();
      expect(result!.createdAt).toBeInstanceOf(Date);
    });

    it("should persist across new repository instance", async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });
      await repo.set("ns-1", "agent-1", "key-1", { data: "persistent" });

      const newRepo = new MemoryPlaneRepository(pool);

      mockPool.query.mockResolvedValueOnce({
        rows: [makeMemoryRow({ key: "key-1", value: { data: "persistent" } })],
        rowCount: 1,
      });

      const result = await newRepo.get("ns-1", "agent-1", "key-1");

      expect(result).not.toBeNull();
      expect(result!.value).toEqual({ data: "persistent" });
    });

    it("should upsert on conflict", async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });
      mockPool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });
      mockPool.query.mockResolvedValueOnce({
        rows: [makeMemoryRow({ key: "key-1", value: { version: 2 } })],
        rowCount: 1,
      });

      await repo.set("ns-1", "agent-1", "key-1", { version: 1 });
      await repo.set("ns-1", "agent-1", "key-1", { version: 2 });

      const result = await repo.get("ns-1", "agent-1", "key-1");
      expect(result!.value).toEqual({ version: 2 });
    });
  });

  describe("TTL expiry", () => {
    it("should return null for expired entries", async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });
      await repo.set("ns-1", "agent-1", "ttl-key", { data: "temp" }, 1);

      mockPool.query.mockResolvedValueOnce({
        rows: [makeMemoryRow({ key: "ttl-key", value: { data: "temp" } })],
        rowCount: 1,
      });

      const before = await repo.get("ns-1", "agent-1", "ttl-key");
      expect(before).not.toBeNull();

      await new Promise((resolve) => setTimeout(resolve, 2100));

      mockPool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

      const after = await repo.get("ns-1", "agent-1", "ttl-key");
      expect(after).toBeNull();
    });

    it("should not return entries without expiry", async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });
      await repo.set("ns-1", "agent-1", "permanent", { data: "forever" });

      mockPool.query.mockResolvedValueOnce({
        rows: [makeMemoryRow({ key: "permanent", value: { data: "forever" } })],
        rowCount: 1,
      });

      const result = await repo.get("ns-1", "agent-1", "permanent");
      expect(result).not.toBeNull();
    });
  });

  describe("delete", () => {
    it("should soft delete an entry", async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });
      await repo.set("ns-1", "agent-1", "to-delete", { data: "bye" });

      mockPool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });
      const deleted = await repo.delete("ns-1", "agent-1", "to-delete");
      expect(deleted).toBe(true);

      mockPool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
      const result = await repo.get("ns-1", "agent-1", "to-delete");
      expect(result).toBeNull();
    });

    it("should return false for non-existent entry", async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

      const deleted = await repo.delete("ns-1", "agent-1", "nonexistent");
      expect(deleted).toBe(false);
    });
  });

  describe("searchSimilar", () => {
    it("should return nearest embeddings by cosine similarity", async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });
      mockPool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });
      mockPool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });

      await repo.set("ns-1", "agent-1", "vec-1", { label: "a" }, undefined, [1, 0, 0]);
      await repo.set("ns-1", "agent-1", "vec-2", { label: "b" }, undefined, [0, 1, 0]);
      await repo.set("ns-1", "agent-1", "vec-3", { label: "c" }, undefined, [0.9, 0.1, 0]);

      mockPool.query.mockResolvedValueOnce({
        rows: [
          { ...makeMemoryRow({ id: "v1", key: "vec-1", value: { label: "a" }, embedding: [1, 0, 0] }), similarity: "1" },
          { ...makeMemoryRow({ id: "v3", key: "vec-3", value: { label: "c" }, embedding: [0.9, 0.1, 0] }), similarity: "0.9" },
          { ...makeMemoryRow({ id: "v2", key: "vec-2", value: { label: "b" }, embedding: [0, 1, 0] }), similarity: "0" },
        ],
        rowCount: 3,
      });

      const results = await repo.searchSimilar("ns-1", [1, 0, 0], 3);

      expect(results.length).toBe(3);
      expect(results[0]!.entry.key).toBe("vec-1");
      expect(results[0]!.similarity).toBeCloseTo(1.0, 2);
      expect(results[1]!.entry.key).toBe("vec-3");
    });

    it("should only search within namespace", async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });
      mockPool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });

      await repo.set("ns-1", "agent-1", "vec-1", { label: "a" }, undefined, [1, 0, 0]);
      await repo.set("ns-2", "agent-1", "vec-2", { label: "b" }, undefined, [1, 0, 0]);

      mockPool.query.mockResolvedValueOnce({
        rows: [
          { ...makeMemoryRow({ id: "v1", namespace: "ns-1", key: "vec-1", value: { label: "a" }, embedding: [1, 0, 0] }), similarity: "1" },
        ],
        rowCount: 1,
      });

      const results = await repo.searchSimilar("ns-1", [1, 0, 0], 10);
      expect(results.length).toBe(1);
      expect(results[0]!.entry.key).toBe("vec-1");
    });

    it("should exclude expired entries", async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });
      mockPool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });

      await repo.set("ns-1", "agent-1", "expired-vec", { label: "x" }, 1, [1, 0, 0]);
      await repo.set("ns-1", "agent-1", "valid-vec", { label: "y" }, undefined, [1, 0, 0]);

      await new Promise((resolve) => setTimeout(resolve, 1500));

      mockPool.query.mockResolvedValueOnce({
        rows: [
          { ...makeMemoryRow({ id: "vy", key: "valid-vec", value: { label: "y" }, embedding: [1, 0, 0] }), similarity: "1" },
        ],
        rowCount: 1,
      });

      const results = await repo.searchSimilar("ns-1", [1, 0, 0], 10);
      expect(results.length).toBe(1);
      expect(results[0]!.entry.key).toBe("valid-vec");
    });
  });

  describe("clearExpired", () => {
    it("should delete expired entries", async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });
      mockPool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });

      await repo.set("ns-1", "agent-1", "exp-1", { data: 1 }, 1);
      await repo.set("ns-1", "agent-1", "keep-1", { data: 2 });

      await new Promise((resolve) => setTimeout(resolve, 1500));

      mockPool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });

      const cleared = await repo.clearExpired();
      expect(cleared).toBe(1);

      mockPool.query.mockResolvedValueOnce({
        rows: [makeMemoryRow({ key: "keep-1", value: { data: 2 } })],
        rowCount: 1,
      });

      const result = await repo.get("ns-1", "agent-1", "keep-1");
      expect(result).not.toBeNull();
    });
  });

  describe("list", () => {
    it("should list entries for an agent", async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });
      mockPool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });
      mockPool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });

      await repo.set("ns-1", "agent-1", "k1", { v: 1 });
      await repo.set("ns-1", "agent-1", "k2", { v: 2 });
      await repo.set("ns-1", "agent-2", "k3", { v: 3 });

      mockPool.query.mockResolvedValueOnce({
        rows: [
          makeMemoryRow({ id: "e1", key: "k1", value: { v: 1 } }),
          makeMemoryRow({ id: "e2", key: "k2", value: { v: 2 } }),
        ],
        rowCount: 2,
      });

      const entries = await repo.list("ns-1", "agent-1");
      expect(entries).toHaveLength(2);
    });

    it("should respect limit and offset", async () => {
      for (let i = 0; i < 10; i++) {
        mockPool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });
        await repo.set("ns-1", "agent-1", `k${i}`, { v: i });
      }

      mockPool.query.mockResolvedValueOnce({
        rows: Array.from({ length: 3 }, (_, i) => makeMemoryRow({ id: `ki${i}`, key: `k${i}`, value: { v: i } })),
        rowCount: 3,
      });

      const page1 = await repo.list("ns-1", "agent-1", 3, 0);
      expect(page1).toHaveLength(3);

      mockPool.query.mockResolvedValueOnce({
        rows: Array.from({ length: 3 }, (_, i) => makeMemoryRow({ id: `ki${i + 3}`, key: `k${i + 3}`, value: { v: i + 3 } })),
        rowCount: 3,
      });

      const page2 = await repo.list("ns-1", "agent-1", 3, 3);
      expect(page2).toHaveLength(3);
    });
  });
});
