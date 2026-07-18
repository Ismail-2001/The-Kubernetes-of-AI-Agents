jest.mock("pg", () => {
  const mPool = { query: jest.fn(), connect: jest.fn(), end: jest.fn() };
  return { Pool: jest.fn(() => mPool) };
});

import path from "path";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import { server } from "../index";
import { resetAgentRepository } from "../agents/repository";

const PROTO_PATH = path.resolve(__dirname, "../../../../api/proto/egaop/v1/agent.proto");

const packageDefinition = protoLoader.loadSync(PROTO_PATH, {
  keepCase: true, longs: String, enums: String, defaults: true, oneofs: true,
  includeDirs: [path.resolve(__dirname, "../../../../api/proto")]
});

const egaopProto = grpc.loadPackageDefinition(packageDefinition) as any;

const agents = new Map<string, any>();

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

beforeAll(async () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Pool } = require("pg");
  const mockPool = new Pool() as { query: jest.Mock; connect: jest.Mock; end: jest.Mock };
  mockPool.query.mockImplementation(async (sql: string, params: any[]) => {
    // INSERT INTO agents
    if (sql.trimStart().startsWith("INSERT INTO agents")) {
      const key = `${params[1]}/${params[2]}`;
      if (agents.has(key)) {
        throw new Error("duplicate key value violates unique constraint");
      }
      const spec = typeof params[5] === "string" ? JSON.parse(params[5]) : (params[5] || {});
      const status = typeof params[6] === "string" ? JSON.parse(params[6]) : (params[6] || {});
      const labels = typeof params[7] === "string" ? JSON.parse(params[7]) : (params[7] || {});
      const annotations = typeof params[8] === "string" ? JSON.parse(params[8]) : (params[8] || {});
      const agent = {
        id: params[0],
        namespace: params[1],
        name: params[2],
        api_version: params[3] || "egaop.io/v1",
        kind: params[4] || "Agent",
        spec,
        status,
        labels,
        annotations,
        version: 1,
        created_by: params[9] || "",
        created_at: new Date(),
        updated_at: new Date(),
        deleted_at: null,
      };
      agents.set(key, agent);
      return { rows: [agent], rowCount: 1 };
    }

    // SELECT ... FROM agents WHERE namespace = $1 AND name = $2 AND deleted_at IS NULL
    if (sql.includes("SELECT") && sql.includes("FROM agents") && sql.includes("namespace = $1 AND name = $2")) {
      const key = `${params[0]}/${params[1]}`;
      const agent = agents.get(key);
      if (!agent || agent.deleted_at) return { rows: [], rowCount: 0 };
      return { rows: [agent], rowCount: 1 };
    }

    return { rows: [], rowCount: 0 };
  });

  process.env.POSTGRES_HOST = "127.0.0.1";
  process.env.POSTGRES_PORT = "5432";
  process.env.POSTGRES_DB = "testdb";
  process.env.POSTGRES_USER = "testuser";
  process.env.POSTGRES_PASSWORD = "testpass";
  resetAgentRepository();
}, 180000);

afterAll(async () => {
  resetAgentRepository();
  delete process.env.POSTGRES_HOST;
  delete process.env.POSTGRES_PORT;
  delete process.env.POSTGRES_DB;
  delete process.env.POSTGRES_USER;
  delete process.env.POSTGRES_PASSWORD;
  server.forceShutdown();
});

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
    it("should return Pending phase for existing agent", (done) => {
      client.GetAgent({ name: "test-agent", namespace: "default" }, (err: any, response: any) => {
        expect(err).toBeNull();
        expect(response.status.phase).toBe("Pending");
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
