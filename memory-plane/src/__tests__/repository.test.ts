import { GenericContainer, StartedTestContainer, Wait } from "testcontainers";
import { Pool } from "pg";
import fs from "fs";
import path from "path";
import { MemoryPlaneRepository } from "../repository";

describe("MemoryPlaneRepository", () => {
  let container: StartedTestContainer;
  let pool: Pool;
  let repo: MemoryPlaneRepository;

  beforeAll(async () => {
    container = await new GenericContainer("pgvector/pgvector:pg16")
      .withEnvironment({
        POSTGRES_DB: "egaop_test",
        POSTGRES_USER: "test",
        POSTGRES_PASSWORD: "test",
      })
      .withExposedPorts(5432)
      .withWaitStrategy(Wait.forLogMessage("database system is ready to accept connections", 2))
      .start();

    const port = container.getMappedPort(5432);
    const host = container.getHost();

    pool = new Pool({
      host,
      port,
      database: "egaop_test",
      user: "test",
      password: "test",
    });

    const migrationSql = fs.readFileSync(
      path.resolve(__dirname, "../../../../migrations/001_memory_plane.sql"),
      "utf8"
    );
    await pool.query(migrationSql);

    repo = new MemoryPlaneRepository(pool);
  }, 120000);

  afterAll(async () => {
    await pool.end();
    await container.stop();
  });

  afterEach(async () => {
    await pool.query("DELETE FROM agent_memory");
  });

  describe("set / get round-trip", () => {
    it("should persist and retrieve a memory entry", async () => {
      const value = { message: "Hello, world" };
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
      await repo.set("ns-1", "agent-1", "key-1", { data: "persistent" });

      const newRepo = new MemoryPlaneRepository(pool);
      const result = await newRepo.get("ns-1", "agent-1", "key-1");

      expect(result).not.toBeNull();
      expect(result!.value).toEqual({ data: "persistent" });
    });

    it("should upsert on conflict", async () => {
      await repo.set("ns-1", "agent-1", "key-1", { version: 1 });
      await repo.set("ns-1", "agent-1", "key-1", { version: 2 });

      const result = await repo.get("ns-1", "agent-1", "key-1");
      expect(result!.value).toEqual({ version: 2 });
    });
  });

  describe("TTL expiry", () => {
    it("should return null for expired entries", async () => {
      await repo.set("ns-1", "agent-1", "ttl-key", { data: "temp" }, 1);

      const before = await repo.get("ns-1", "agent-1", "ttl-key");
      expect(before).not.toBeNull();

      await new Promise((resolve) => setTimeout(resolve, 2100));

      const after = await repo.get("ns-1", "agent-1", "ttl-key");
      expect(after).toBeNull();
    });

    it("should not return entries without expiry", async () => {
      await repo.set("ns-1", "agent-1", "permanent", { data: "forever" });

      const result = await repo.get("ns-1", "agent-1", "permanent");
      expect(result).not.toBeNull();
    });
  });

  describe("delete", () => {
    it("should soft delete an entry", async () => {
      await repo.set("ns-1", "agent-1", "to-delete", { data: "bye" });

      const deleted = await repo.delete("ns-1", "agent-1", "to-delete");
      expect(deleted).toBe(true);

      const result = await repo.get("ns-1", "agent-1", "to-delete");
      expect(result).toBeNull();
    });

    it("should return false for non-existent entry", async () => {
      const deleted = await repo.delete("ns-1", "agent-1", "nonexistent");
      expect(deleted).toBe(false);
    });
  });

  describe("searchSimilar", () => {
    it("should return nearest embeddings by cosine similarity", async () => {
      await repo.set("ns-1", "agent-1", "vec-1", { label: "a" }, undefined, [1, 0, 0]);
      await repo.set("ns-1", "agent-1", "vec-2", { label: "b" }, undefined, [0, 1, 0]);
      await repo.set("ns-1", "agent-1", "vec-3", { label: "c" }, undefined, [0.9, 0.1, 0]);

      const results = await repo.searchSimilar("ns-1", [1, 0, 0], 3);

      expect(results.length).toBe(3);
      expect(results[0]!.entry.key).toBe("vec-1");
      expect(results[0]!.similarity).toBeCloseTo(1.0, 2);
      expect(results[1]!.entry.key).toBe("vec-3");
    });

    it("should only search within namespace", async () => {
      await repo.set("ns-1", "agent-1", "vec-1", { label: "a" }, undefined, [1, 0, 0]);
      await repo.set("ns-2", "agent-1", "vec-2", { label: "b" }, undefined, [1, 0, 0]);

      const results = await repo.searchSimilar("ns-1", [1, 0, 0], 10);
      expect(results.length).toBe(1);
      expect(results[0]!.entry.key).toBe("vec-1");
    });

    it("should exclude expired entries", async () => {
      await repo.set("ns-1", "agent-1", "expired-vec", { label: "x" }, 1, [1, 0, 0]);
      await repo.set("ns-1", "agent-1", "valid-vec", { label: "y" }, undefined, [1, 0, 0]);

      await new Promise((resolve) => setTimeout(resolve, 1500));

      const results = await repo.searchSimilar("ns-1", [1, 0, 0], 10);
      expect(results.length).toBe(1);
      expect(results[0]!.entry.key).toBe("valid-vec");
    });
  });

  describe("clearExpired", () => {
    it("should delete expired entries", async () => {
      await repo.set("ns-1", "agent-1", "exp-1", { data: 1 }, 1);
      await repo.set("ns-1", "agent-1", "keep-1", { data: 2 });

      await new Promise((resolve) => setTimeout(resolve, 1500));

      const cleared = await repo.clearExpired();
      expect(cleared).toBe(1);

      const result = await repo.get("ns-1", "agent-1", "keep-1");
      expect(result).not.toBeNull();
    });
  });

  describe("list", () => {
    it("should list entries for an agent", async () => {
      await repo.set("ns-1", "agent-1", "k1", { v: 1 });
      await repo.set("ns-1", "agent-1", "k2", { v: 2 });
      await repo.set("ns-1", "agent-2", "k3", { v: 3 });

      const entries = await repo.list("ns-1", "agent-1");
      expect(entries).toHaveLength(2);
    });

    it("should respect limit and offset", async () => {
      for (let i = 0; i < 10; i++) {
        await repo.set("ns-1", "agent-1", `k${i}`, { v: i });
      }

      const page1 = await repo.list("ns-1", "agent-1", 3, 0);
      expect(page1).toHaveLength(3);

      const page2 = await repo.list("ns-1", "agent-1", 3, 3);
      expect(page2).toHaveLength(3);
    });
  });
});
