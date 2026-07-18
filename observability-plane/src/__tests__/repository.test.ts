import { ObservabilityRepository } from "../repository";

const mockClient = {
  query: jest.fn(),
  release: jest.fn(),
};

const mockPool = {
  query: jest.fn(),
  end: jest.fn().mockResolvedValue(undefined),
  connect: jest.fn().mockResolvedValue(mockClient),
};

jest.mock("pg", () => ({
  Pool: jest.fn(() => mockPool),
}));

function spanRow(overrides?: Record<string, unknown>) {
  return {
    trace_id: "trace-1",
    span_id: "span-1",
    parent_span_id: null,
    service_name: "test-service",
    operation_name: "test-op",
    namespace: "ns-1",
    start_time: new Date("2026-06-01T00:00:00Z"),
    end_time: new Date("2026-06-01T00:00:01Z"),
    status: "ok",
    attributes: {},
    events: [],
    ...overrides,
  };
}

function sessionRow(overrides?: Record<string, unknown>) {
  return {
    id: "session-id",
    trace_id: "trace-r",
    created_at: new Date(),
    metadata: { agent: "a1" },
    ...overrides,
  };
}

let repo: ObservabilityRepository;

beforeAll(() => {
  repo = new ObservabilityRepository(mockPool as any);
});

afterAll(async () => {
  await mockPool.end();
});

describe("ObservabilityRepository", () => {
  describe("ingestSpan", () => {
    it("should store a span", async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });

      const inserted = await repo.ingestSpan({
        traceId: "trace-1", spanId: "span-1", parentSpanId: null,
        serviceName: "test-service", operationName: "test-op",
        namespace: "ns-1", startTime: new Date("2026-06-01T00:00:00Z"),
        endTime: new Date("2026-06-01T00:00:01Z"), status: "ok",
        attributes: {}, events: [],
      });
      expect(inserted).toBe(true);

      mockPool.query.mockResolvedValueOnce({
        rows: [spanRow()],
        rowCount: 1,
      });

      const spans = await repo.getTrace("trace-1", "ns-1");
      expect(spans).toHaveLength(1);
      expect(spans[0]!.spanId).toBe("span-1");
    });

    it("should be idempotent on duplicate span_id", async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });
      mockPool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

      const span = {
        traceId: "trace-1", spanId: "span-1", parentSpanId: null,
        serviceName: "test-service", operationName: "test-op",
        namespace: "ns-1", startTime: new Date("2026-06-01T00:00:00Z"),
        endTime: new Date("2026-06-01T00:00:01Z"), status: "ok",
        attributes: {}, events: [],
      };

      const first = await repo.ingestSpan(span);
      expect(first).toBe(true);

      const second = await repo.ingestSpan(span);
      expect(second).toBe(false);

      mockPool.query.mockResolvedValueOnce({
        rows: [spanRow()],
        rowCount: 1,
      });

      const spans = await repo.getTrace("trace-1", "ns-1");
      expect(spans).toHaveLength(1);
    });
  });

  describe("getTrace", () => {
    it("should return all spans for a trace", async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });
      mockPool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });
      mockPool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });

      await repo.ingestSpan({
        traceId: "trace-1", spanId: "s1", parentSpanId: null,
        serviceName: "test-service", operationName: "test-op",
        namespace: "ns-1", startTime: new Date(), endTime: new Date(), status: "ok",
        attributes: {}, events: [],
      });
      await repo.ingestSpan({
        traceId: "trace-1", spanId: "s2", parentSpanId: null,
        serviceName: "test-service", operationName: "test-op",
        namespace: "ns-1", startTime: new Date(), endTime: new Date(), status: "ok",
        attributes: {}, events: [],
      });
      await repo.ingestSpan({
        traceId: "trace-1", spanId: "s3", parentSpanId: null,
        serviceName: "test-service", operationName: "test-op",
        namespace: "ns-1", startTime: new Date(), endTime: new Date(), status: "ok",
        attributes: {}, events: [],
      });

      mockPool.query.mockResolvedValueOnce({
        rows: [spanRow({ span_id: "s1" }), spanRow({ span_id: "s2" }), spanRow({ span_id: "s3" })],
        rowCount: 3,
      });

      const spans = await repo.getTrace("trace-1", "ns-1");
      expect(spans).toHaveLength(3);
    });

    it("should isolate by namespace", async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });
      mockPool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });

      await repo.ingestSpan({
        traceId: "trace-1", spanId: "s1", parentSpanId: null,
        serviceName: "test-service", operationName: "test-op",
        namespace: "ns-A", startTime: new Date(), endTime: new Date(), status: "ok",
        attributes: {}, events: [],
      });
      await repo.ingestSpan({
        traceId: "trace-1", spanId: "s2", parentSpanId: null,
        serviceName: "test-service", operationName: "test-op",
        namespace: "ns-B", startTime: new Date(), endTime: new Date(), status: "ok",
        attributes: {}, events: [],
      });

      mockPool.query.mockResolvedValueOnce({
        rows: [spanRow({ span_id: "s1", namespace: "ns-A" })],
        rowCount: 1,
      });

      const nsASpans = await repo.getTrace("trace-1", "ns-A");
      expect(nsASpans).toHaveLength(1);
      expect(nsASpans[0]!.spanId).toBe("s1");

      mockPool.query.mockResolvedValueOnce({
        rows: [spanRow({ span_id: "s2", namespace: "ns-B" })],
        rowCount: 1,
      });

      const nsBSpans = await repo.getTrace("trace-1", "ns-B");
      expect(nsBSpans).toHaveLength(1);
      expect(nsBSpans[0]!.spanId).toBe("s2");
    });

    it("should return empty for unknown trace", async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

      const spans = await repo.getTrace("nonexistent", "ns-1");
      expect(spans).toHaveLength(0);
    });
  });

  describe("namespace isolation", () => {
    it("should not expose spans from ns-A to ns-B query", async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });
      mockPool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });
      mockPool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });

      await repo.ingestSpan({
        traceId: "trace-1", spanId: "s1", parentSpanId: null,
        serviceName: "test-service", operationName: "test-op",
        namespace: "ns-A", startTime: new Date(), endTime: new Date(), status: "ok",
        attributes: {}, events: [],
      });
      await repo.ingestSpan({
        traceId: "trace-1", spanId: "s2", parentSpanId: null,
        serviceName: "test-service", operationName: "test-op",
        namespace: "ns-B", startTime: new Date(), endTime: new Date(), status: "ok",
        attributes: {}, events: [],
      });
      await repo.ingestSpan({
        traceId: "trace-1", spanId: "s3", parentSpanId: null,
        serviceName: "test-service", operationName: "test-op",
        namespace: "ns-A", startTime: new Date(), endTime: new Date(), status: "ok",
        attributes: {}, events: [],
      });

      mockPool.query.mockResolvedValueOnce({
        rows: [spanRow({ span_id: "s1", namespace: "ns-A" }), spanRow({ span_id: "s3", namespace: "ns-A" })],
        rowCount: 2,
      });

      const nsA = await repo.getTrace("trace-1", "ns-A");
      expect(nsA).toHaveLength(2);

      mockPool.query.mockResolvedValueOnce({
        rows: [spanRow({ span_id: "s2", namespace: "ns-B" })],
        rowCount: 1,
      });

      const nsB = await repo.getTrace("trace-1", "ns-B");
      expect(nsB).toHaveLength(1);

      mockPool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

      const nsC = await repo.getTrace("trace-1", "ns-C");
      expect(nsC).toHaveLength(0);
    });
  });

  describe("listTraces", () => {
    it("should list traces paginated", async () => {
      for (let i = 0; i < 5; i++) {
        mockPool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });
        await repo.ingestSpan({
          traceId: `trace-${i}`, spanId: `s-${i}`, parentSpanId: null,
          serviceName: "test-service", operationName: `op-${i}`,
          namespace: "ns-1", startTime: new Date(), endTime: new Date(), status: "ok",
          attributes: {}, events: [],
        });
      }

      mockPool.query.mockResolvedValueOnce({
        rows: [
          spanRow({ trace_id: "trace-0", span_id: "s-0", operation_name: "op-0" }),
          spanRow({ trace_id: "trace-1", span_id: "s-1", operation_name: "op-1" }),
          spanRow({ trace_id: "trace-2", span_id: "s-2", operation_name: "op-2" }),
          spanRow({ trace_id: "trace-3", span_id: "s-3", operation_name: "op-3" }),
        ],
        rowCount: 4,
      });

      const result = await repo.listTraces("ns-1", new Date("2026-01-01"), new Date("2026-12-31"), 3);
      expect(result.traces).toHaveLength(3);
      expect(result.nextCursor).not.toBeNull();
    });

    it("should handle cursor-based pagination", async () => {
      for (let i = 0; i < 5; i++) {
        mockPool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });
        await repo.ingestSpan({
          traceId: `trace-${i}`, spanId: `s-${i}`, parentSpanId: null,
          serviceName: "test-service", operationName: "test-op",
          namespace: "ns-1", startTime: new Date(), endTime: new Date(), status: "ok",
          attributes: {}, events: [],
        });
      }

      mockPool.query.mockResolvedValueOnce({
        rows: [
          spanRow({ trace_id: "trace-0", span_id: "s-0" }),
          spanRow({ trace_id: "trace-1", span_id: "s-1" }),
          spanRow({ trace_id: "trace-2", span_id: "s-2" }),
        ],
        rowCount: 3,
      });

      const page1 = await repo.listTraces("ns-1", new Date("2026-01-01"), new Date("2026-12-31"), 2);
      expect(page1.traces).toHaveLength(2);
      expect(page1.nextCursor).not.toBeNull();

      mockPool.query.mockResolvedValueOnce({
        rows: [
          spanRow({ trace_id: "trace-2", span_id: "s-2" }),
          spanRow({ trace_id: "trace-3", span_id: "s-3" }),
        ],
        rowCount: 2,
      });

      const page2 = await repo.listTraces("ns-1", new Date("2026-01-01"), new Date("2026-12-31"), 2, page1.nextCursor!);
      expect(page2.traces.length).toBeGreaterThan(0);
    });
  });

  describe("replay sessions", () => {
    it("should create and retrieve a replay session with spans", async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });
      mockPool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });

      await repo.ingestSpan({
        traceId: "trace-r", spanId: "s1", parentSpanId: null,
        serviceName: "test-service", operationName: "test-op",
        namespace: "ns-1", startTime: new Date(), endTime: new Date(), status: "ok",
        attributes: {}, events: [],
      });
      await repo.ingestSpan({
        traceId: "trace-r", spanId: "s2", parentSpanId: null,
        serviceName: "test-service", operationName: "test-op",
        namespace: "ns-1", startTime: new Date(), endTime: new Date(), status: "ok",
        attributes: {}, events: [],
      });

      mockPool.query.mockResolvedValueOnce({
        rows: [sessionRow()],
        rowCount: 1,
      });

      const session = await repo.createReplaySession("trace-r", { agent: "a1" });
      expect(session.traceId).toBe("trace-r");
      expect(session.metadata).toEqual({ agent: "a1" });

      mockClient.query.mockResolvedValueOnce({ rows: [] }); // BEGIN
      mockClient.query.mockResolvedValueOnce({ // get session
        rows: [sessionRow()],
        rowCount: 1,
      });
      mockClient.query.mockResolvedValueOnce({ // get spans
        rows: [spanRow({ span_id: "s1" }), spanRow({ span_id: "s2" })],
        rowCount: 2,
      });
      mockClient.query.mockResolvedValueOnce({ rows: [] }); // COMMIT

      const retrieved = await repo.getReplaySession(session.id);
      expect(retrieved).not.toBeNull();
      expect(retrieved!.spans).toHaveLength(2);
      expect(retrieved!.spans[0]!.spanId).toBe("s1");
      expect(retrieved!.spans[1]!.spanId).toBe("s2");
    });

    it("should return null for unknown session", async () => {
      mockClient.query.mockResolvedValueOnce({ rows: [] }); // BEGIN
      mockClient.query.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // session not found
      mockClient.query.mockResolvedValueOnce({ rows: [] }); // ROLLBACK

      const result = await repo.getReplaySession("00000000-0000-0000-0000-000000000000");
      expect(result).toBeNull();
    });
  });

  describe("batchIngest", () => {
    it("should insert multiple spans in a single query", async () => {
      mockClient.query.mockResolvedValueOnce({ rows: [] }); // BEGIN
      mockClient.query.mockResolvedValueOnce({ rows: [], rowCount: 100 }); // INSERT
      mockClient.query.mockResolvedValueOnce({ rows: [] }); // COMMIT

      const spans = Array.from({ length: 100 }, (_, i) => ({
        traceId: "trace-batch", spanId: `batch-${i}`, parentSpanId: null,
        serviceName: "test-service", operationName: `op-${i}`,
        namespace: "ns-1", startTime: new Date(), endTime: new Date(), status: "ok",
        attributes: {}, events: [],
      }));

      const inserted = await repo.batchIngest(spans);
      expect(inserted).toBe(100);
    });

    it("should handle empty batch", async () => {
      const inserted = await repo.batchIngest([]);
      expect(inserted).toBe(0);
    });

    it("should handle duplicates in batch", async () => {
      mockClient.query.mockResolvedValueOnce({ rows: [] }); // BEGIN
      mockClient.query.mockResolvedValueOnce({ rows: [], rowCount: 1 }); // INSERT (1 unique)
      mockClient.query.mockResolvedValueOnce({ rows: [] }); // COMMIT

      const span = {
        traceId: "trace-1", spanId: "dup-1", parentSpanId: null,
        serviceName: "test-service", operationName: "test-op",
        namespace: "ns-1", startTime: new Date(), endTime: new Date(), status: "ok",
        attributes: {}, events: [],
      };
      const inserted = await repo.batchIngest([span, span]);
      expect(inserted).toBe(1);
    });
  });

  describe("deleteTrace", () => {
    it("should delete all spans for a trace", async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });
      mockPool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });

      await repo.ingestSpan({
        traceId: "del-trace", spanId: "d1", parentSpanId: null,
        serviceName: "test-service", operationName: "test-op",
        namespace: "ns-1", startTime: new Date(), endTime: new Date(), status: "ok",
        attributes: {}, events: [],
      });
      await repo.ingestSpan({
        traceId: "del-trace", spanId: "d2", parentSpanId: null,
        serviceName: "test-service", operationName: "test-op",
        namespace: "ns-1", startTime: new Date(), endTime: new Date(), status: "ok",
        attributes: {}, events: [],
      });

      mockPool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });

      const deleted = await repo.deleteTrace("del-trace", "ns-1");
      expect(deleted).toBe(true);

      mockPool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

      const spans = await repo.getTrace("del-trace", "ns-1");
      expect(spans).toHaveLength(0);
    });

    it("should return false for non-existent trace", async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

      const deleted = await repo.deleteTrace("nonexistent", "ns-1");
      expect(deleted).toBe(false);
    });
  });

  describe("getTraceCost", () => {
    it("should extract cost from span attributes", async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });

      await repo.ingestSpan({
        traceId: "trace-1", spanId: "span-1", parentSpanId: null,
        serviceName: "test-service", operationName: "test-op",
        namespace: "ns-1", startTime: new Date(), endTime: new Date(), status: "ok",
        attributes: { fields: { "egaop.llm.cost": { stringValue: "$0.042" } } },
        events: [],
      });

      mockPool.query.mockResolvedValueOnce({
        rows: [{ cost: "$0.042" }],
        rowCount: 1,
      });

      const cost = await repo.getTraceCost("trace-1");
      expect(cost).toBe("$0.042");
    });

    it("should return $0.00 when no cost found", async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });

      await repo.ingestSpan({
        traceId: "trace-1", spanId: "span-1", parentSpanId: null,
        serviceName: "test-service", operationName: "test-op",
        namespace: "ns-1", startTime: new Date(), endTime: new Date(), status: "ok",
        attributes: {}, events: [],
      });

      mockPool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

      const cost = await repo.getTraceCost("trace-1");
      expect(cost).toBe("$0.00");
    });
  });
});
