import path from "path";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import { server } from "../index";

const PROTO_PATH = path.resolve(__dirname, "../../../../api/proto/egaop/v1/agent.proto");

const packageDefinition = protoLoader.loadSync(PROTO_PATH, {
  keepCase: true, longs: String, enums: String, defaults: true, oneofs: true,
  includeDirs: [path.resolve(__dirname, "../../../../api/proto")]
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

describe("API Server", () => {
  let port: number;
  let client: any;
  let healthClient: ReturnType<typeof createHealthClient>;

  beforeAll(async () => {
    port = await startServer(server);
    const AgentService = egaopProto.egaop.v1.AgentService;
    client = new AgentService(`localhost:${port}`, grpc.credentials.createInsecure());
    healthClient = createHealthClient(port);
  });

  afterAll(() => {
    healthClient.close();
    server.forceShutdown();
  });

  describe("CreateAgent", () => {
    it("should assign uid and set phase to Pending", (done) => {
      client.CreateAgent({
        metadata: { name: "test-agent", namespace: "default" },
        spec: { version: "v1", description: "test", runtime: { isolation_level: "Enhanced" } }
      }, (err: any, response: any) => {
        expect(err).toBeNull();
        expect(response.metadata.uid).toBeDefined();
        expect(response.metadata.uid.length).toBeGreaterThan(0);
        expect(response.kind).toBe("Agent");
        expect(response.api_version).toBe("egaop.io/v1");
        expect(response.status.phase).toBe("Pending");
        expect(response.status.health_status).toBe("Healthy");
        done();
      });
    });

    it("should generate unique uid on each call", (done) => {
      client.CreateAgent({
        metadata: { name: "agent-a", namespace: "default" },
        spec: {}
      }, (_err1: any, r1: any) => {
        client.CreateAgent({
          metadata: { name: "agent-b", namespace: "default" },
          spec: {}
        }, (_err2: any, r2: any) => {
          expect(r1.metadata.uid).not.toBe(r2.metadata.uid);
          done();
        });
      });
    });
  });

  describe("GetAgent", () => {
    it("should return Running phase for existing agent", (done) => {
      client.GetAgent({ name: "test-agent", namespace: "default" }, (err: any, response: any) => {
        expect(err).toBeNull();
        expect(response.status.phase).toBe("Running");
        expect(response.status.health_status).toBe("Healthy");
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
