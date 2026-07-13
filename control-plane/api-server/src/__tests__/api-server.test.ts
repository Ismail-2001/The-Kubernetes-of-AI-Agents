import path from "path";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import { server } from "../index";
import { resetAgentRepository } from "../agents/repository";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { GenericContainer, Wait } = require("testcontainers");

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

let pgContainer: any = null;
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

  // Point agent repository at test DB
  process.env.POSTGRES_HOST = "127.0.0.1";
  process.env.POSTGRES_PORT = String(postgresPort);
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
  if (pgContainer) {
    await pgContainer.stop();
    pgContainer = null;
  }
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
