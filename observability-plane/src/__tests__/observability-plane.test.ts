import path from "path";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import { server, traceStore } from "../index";

const PROTO_PATH = path.resolve(__dirname, "../../../api/proto/egaop/v1/execution.proto");

const packageDefinition = protoLoader.loadSync(PROTO_PATH, {
  keepCase: true, longs: String, enums: String, defaults: true, oneofs: true,
  includeDirs: [path.resolve(__dirname, "../../../api/proto")]
});

const egaopProto = grpc.loadPackageDefinition(packageDefinition) as any;

function startServer(srv: grpc.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    srv.bindAsync("localhost:0", grpc.ServerCredentials.createInsecure(), (err, port) => {
      if (err) reject(err);
      else { srv.start(); resolve(port); }
    });
  });
}

function createHealthClient(port: number) {
  const client = new grpc.Client(`localhost:${port}`, grpc.credentials.createInsecure());
  return {
    Check: (req: any, callback: any) => {
      client.makeUnaryRequest(
        "/grpc.health.v1.Health/Check",
        (v: any) => Buffer.from(JSON.stringify(v)),
        (b: Buffer) => JSON.parse(b.toString()),
        req,
        callback
      );
    },
    close: () => client.close()
  };
}

describe("Observability Plane", () => {
  let port: number;
  let client: any;
  let healthClient: ReturnType<typeof createHealthClient>;

  beforeAll(async () => {
    traceStore.clear();
    port = await startServer(server);
    const ObsService = egaopProto.egaop.v1.ObservabilityService;
    client = new ObsService(`localhost:${port}`, grpc.credentials.createInsecure());
    healthClient = createHealthClient(port);
  });

  afterAll(() => {
    healthClient.close();
    server.forceShutdown();
  });

  describe("ExportTrace", () => {
    it("should store a span in the trace store", (done) => {
      client.ExportTrace({
        execution_id: "exec-1",
        span_id: "span-001",
        name: "llm_call",
        start_time: { seconds: 1000, nanos: 0 },
        end_time: { seconds: 1002, nanos: 500000000 },
        attributes: { fields: {} }
      }, (err: any, response: any) => {
        expect(err).toBeNull();
        expect(response.success).toBe(true);
        const spans = traceStore.get("exec-1");
        expect(spans).toBeDefined();
        expect(spans!.length).toBe(1);
        expect(spans![0].span_id).toBe("span-001");
        expect(spans![0].name).toBe("llm_call");
        done();
      });
    });

    it("should append multiple spans to the same execution", (done) => {
      client.ExportTrace({
        execution_id: "exec-2",
        span_id: "span-1",
        name: "admission",
        start_time: { seconds: 100, nanos: 0 },
        end_time: { seconds: 101, nanos: 0 },
        attributes: { fields: {} }
      }, () => {
        client.ExportTrace({
          execution_id: "exec-2",
          span_id: "span-2",
          name: "execution",
          start_time: { seconds: 101, nanos: 0 },
          end_time: { seconds: 105, nanos: 0 },
          attributes: { fields: {} }
        }, () => {
          const spans = traceStore.get("exec-2");
          expect(spans).toHaveLength(2);
          done();
        });
      });
    });

    it("should extract cost from span attributes", (done) => {
      client.ExportTrace({
        execution_id: "exec-3",
        span_id: "span-cost",
        name: "llm_call",
        start_time: { seconds: 1, nanos: 0 },
        end_time: { seconds: 2, nanos: 0 },
        attributes: {
          fields: {
            "egaop.llm.cost": { stringValue: "$0.024" }
          }
        }
      }, (err: any, _response: any) => {
        expect(err).toBeNull();
        const spans = traceStore.get("exec-3");
        expect(spans![0].attributes.fields["egaop.llm.cost"].stringValue).toBe("$0.024");
        done();
      });
    });
  });

  describe("GetExecutionReplay", () => {
    it("should construct replay bundle from stored spans", (done) => {
      client.ExportTrace({
        execution_id: "exec-replay",
        span_id: "s1",
        name: "admission",
        start_time: { seconds: 100, nanos: 0 },
        end_time: { seconds: 101, nanos: 0 },
        attributes: { fields: {} }
      }, () => {
        client.ExportTrace({
          execution_id: "exec-replay",
          span_id: "s2",
          name: "llm_call",
          start_time: { seconds: 101, nanos: 0 },
          end_time: { seconds: 105, nanos: 0 },
          attributes: { fields: {} }
        }, () => {
          client.GetExecutionReplay({ execution_id: "exec-replay" }, (err: any, record: any) => {
            expect(err).toBeNull();
            expect(record.execution_id).toBe("exec-replay");
            expect(record.steps).toHaveLength(2);
            expect(record.steps[0].name).toBe("admission");
            expect(record.steps[1].name).toBe("llm_call");
            expect(parseInt(record.steps[0].duration_ms, 10)).toBe(1000);
            expect(parseInt(record.steps[1].duration_ms, 10)).toBe(4000);
            done();
          });
        });
      });
    });

    it("should return NOT_FOUND for unknown execution", (done) => {
      client.GetExecutionReplay({ execution_id: "nonexistent" }, (err: any, _record: any) => {
        expect(err).toBeDefined();
        expect(err.code).toBe(grpc.status.NOT_FOUND);
        expect(err.details).toContain("nonexistent");
        done();
      });
    });
  });

  describe("Health Check", () => {
    it("should return SERVING", (done) => {
      healthClient.Check({}, (err: any, response: any) => {
        expect(err).toBeNull();
        expect(response.status).toBe("SERVING");
        done();
      });
    });
  });
});
