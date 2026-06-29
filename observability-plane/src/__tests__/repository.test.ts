import { GenericContainer, StartedTestContainer, Wait } from "testcontainers";
import { Pool } from "pg";
import fs from "fs";
import path from "path";
import { ObservabilityRepository } from "../repository";

describe("ObservabilityRepository", () => {
  let container: StartedTestContainer;
  let pool: Pool;
  let repo: ObservabilityRepository;

  beforeAll(async () => {
    container = await new GenericContainer("postgres:16-alpine")
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
      path.resolve(__dirname, "../../../../migrations/002_observability_plane.sql"),
      "utf8"
    );
    await pool.query(migrationSql);

    repo = new ObservabilityRepository(pool);
  }, 120000);

  afterAll(async () => {
    await pool.end();
    await container.stop();
  });

  afterEach(async () => {
    await pool.query("DELETE FROM replay_sessions");
    await pool.query("DELETE FROM spans");
  });

  function makeSpan(overrides?: Partial<{
    traceId: string;
    spanId: string;
    namespace: string;
    serviceName: string;
    operationName: string;
  }>) {
    return {
      traceId: overrides?.traceId ?? "trace-1",
      spanId: overrides?.spanId ?? "span-1",
      parentSpanId: null,
      serviceName: overrides?.serviceName ?? "test-service",
      operationName: overrides?.operationName ?? "test-op",
      namespace: overrides?.namespace ?? "ns-1",
      startTime: new Date("2026-06-01T00:00:00Z"),
      endTime: new Date("2026-06-01T00:00:01Z"),
      status: "ok",
      attributes: {},
      events: [],
    };
  }

  describe("ingestSpan", () => {
    it("should store a span", async () => {
      const span = makeSpan();
      const inserted = await repo.ingestSpan(span);
      expect(inserted).toBe(true);

      const spans = await repo.getTrace("trace-1", "ns-1");
      expect(spans).toHaveLength(1);
      expect(spans[0]!.spanId).toBe("span-1");
    });

    it("should be idempotent on duplicate span_id", async () => {
      const span = makeSpan();
      const first = await repo.ingestSpan(span);
      expect(first).toBe(true);

      const second = await repo.ingestSpan(span);
      expect(second).toBe(false);

      const spans = await repo.getTrace("trace-1", "ns-1");
      expect(spans).toHaveLength(1);
    });
  });

  describe("getTrace", () => {
    it("should return all spans for a trace", async () => {
      await repo.ingestSpan(makeSpan({ spanId: "s1" }));
      await repo.ingestSpan(makeSpan({ spanId: "s2" }));
      await repo.ingestSpan(makeSpan({ spanId: "s3" }));

      const spans = await repo.getTrace("trace-1", "ns-1");
      expect(spans).toHaveLength(3);
    });

    it("should isolate by namespace", async () => {
      await repo.ingestSpan(makeSpan({ spanId: "s1", namespace: "ns-A" }));
      await repo.ingestSpan(makeSpan({ spanId: "s2", namespace: "ns-B" }));

      const nsASpans = await repo.getTrace("trace-1", "ns-A");
      expect(nsASpans).toHaveLength(1);
      expect(nsASpans[0]!.spanId).toBe("s1");

      const nsBSpans = await repo.getTrace("trace-1", "ns-B");
      expect(nsBSpans).toHaveLength(1);
      expect(nsBSpans[0]!.spanId).toBe("s2");
    });

    it("should return empty for unknown trace", async () => {
      const spans = await repo.getTrace("nonexistent", "ns-1");
      expect(spans).toHaveLength(0);
    });
  });

  describe("namespace isolation", () => {
    it("should not expose spans from ns-A to ns-B query", async () => {
      await repo.ingestSpan(makeSpan({ spanId: "s1", namespace: "ns-A" }));
      await repo.ingestSpan(makeSpan({ spanId: "s2", namespace: "ns-B" }));
      await repo.ingestSpan(makeSpan({ spanId: "s3", namespace: "ns-A" }));

      const nsA = await repo.getTrace("trace-1", "ns-A");
      expect(nsA).toHaveLength(2);

      const nsB = await repo.getTrace("trace-1", "ns-B");
      expect(nsB).toHaveLength(1);

      const nsC = await repo.getTrace("trace-1", "ns-C");
      expect(nsC).toHaveLength(0);
    });
  });

  describe("listTraces", () => {
    it("should list traces paginated", async () => {
      for (let i = 0; i < 5; i++) {
        await repo.ingestSpan(makeSpan({
          spanId: `s-${i}`,
          traceId: `trace-${i}`,
          operationName: `op-${i}`,
        }));
      }

      const result = await repo.listTraces(
        "ns-1",
        new Date("2026-01-01"),
        new Date("2026-12-31"),
        3
      );

      expect(result.traces).toHaveLength(3);
      expect(result.nextCursor).not.toBeNull();
    });

    it("should handle cursor-based pagination", async () => {
      for (let i = 0; i < 5; i++) {
        await repo.ingestSpan(makeSpan({
          spanId: `s-${i}`,
          traceId: `trace-${i}`,
        }));
      }

      const page1 = await repo.listTraces(
        "ns-1",
        new Date("2026-01-01"),
        new Date("2026-12-31"),
        2
      );
      expect(page1.traces).toHaveLength(2);
      expect(page1.nextCursor).not.toBeNull();

      const page2 = await repo.listTraces(
        "ns-1",
        new Date("2026-01-01"),
        new Date("2026-12-31"),
        2,
        page1.nextCursor!
      );
      expect(page2.traces.length).toBeGreaterThan(0);
    });
  });

  describe("replay sessions", () => {
    it("should create and retrieve a replay session with spans", async () => {
      await repo.ingestSpan(makeSpan({ spanId: "s1", traceId: "trace-r" }));
      await repo.ingestSpan(makeSpan({ spanId: "s2", traceId: "trace-r" }));

      const session = await repo.createReplaySession("trace-r", { agent: "a1" });
      expect(session.traceId).toBe("trace-r");
      expect(session.metadata).toEqual({ agent: "a1" });

      const retrieved = await repo.getReplaySession(session.id);
      expect(retrieved).not.toBeNull();
      expect(retrieved!.spans).toHaveLength(2);
      expect(retrieved!.spans[0]!.spanId).toBe("s1");
      expect(retrieved!.spans[1]!.spanId).toBe("s2");
    });

    it("should return null for unknown session", async () => {
      const result = await repo.getReplaySession("00000000-0000-0000-0000-000000000000");
      expect(result).toBeNull();
    });
  });

  describe("batchIngest", () => {
    it("should insert multiple spans in a single query", async () => {
      const spans = Array.from({ length: 100 }, (_, i) =>
        makeSpan({
          spanId: `batch-${i}`,
          traceId: "trace-batch",
          operationName: `op-${i}`,
        })
      );

      const inserted = await repo.batchIngest(spans);
      expect(inserted).toBe(100);

      const all = await repo.getTrace("trace-batch", "ns-1");
      expect(all).toHaveLength(100);
    });

    it("should handle empty batch", async () => {
      const inserted = await repo.batchIngest([]);
      expect(inserted).toBe(0);
    });

    it("should handle duplicates in batch", async () => {
      const span = makeSpan({ spanId: "dup-1" });
      const inserted = await repo.batchIngest([span, span]);
      expect(inserted).toBe(1);
    });
  });

  describe("deleteTrace", () => {
    it("should delete all spans for a trace", async () => {
      await repo.ingestSpan(makeSpan({ spanId: "d1", traceId: "del-trace" }));
      await repo.ingestSpan(makeSpan({ spanId: "d2", traceId: "del-trace" }));

      const deleted = await repo.deleteTrace("del-trace", "ns-1");
      expect(deleted).toBe(true);

      const spans = await repo.getTrace("del-trace", "ns-1");
      expect(spans).toHaveLength(0);
    });

    it("should return false for non-existent trace", async () => {
      const deleted = await repo.deleteTrace("nonexistent", "ns-1");
      expect(deleted).toBe(false);
    });
  });

  describe("getTraceCost", () => {
    it("should extract cost from span attributes", async () => {
      await repo.ingestSpan({
        ...makeSpan(),
        attributes: {
          fields: {
            "egaop.llm.cost": { stringValue: "$0.042" },
          },
        },
      });

      const cost = await repo.getTraceCost("trace-1");
      expect(cost).toBe("$0.042");
    });

    it("should return $0.00 when no cost found", async () => {
      await repo.ingestSpan(makeSpan());

      const cost = await repo.getTraceCost("trace-1");
      expect(cost).toBe("$0.00");
    });
  });
});
