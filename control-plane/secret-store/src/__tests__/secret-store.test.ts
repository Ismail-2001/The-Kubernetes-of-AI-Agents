jest.mock("pg", () => {
  const mPool = { query: jest.fn(), connect: jest.fn(), end: jest.fn() };
  return { Pool: jest.fn(() => mPool) };
});

import path from "path";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import { SecretRepository } from "../repository";
import { createServerBundle, destroyServerBundle, type ServerBundle } from "../test-server";

const MASTER_KEY = "test-master-key-for-unit-tests-only-32chars";

const PROTO_PATH = path.resolve(__dirname, "../../../../api/proto/egaop/v1/secret.proto");
const packageDefinition = protoLoader.loadSync(PROTO_PATH, {
  keepCase: true, longs: String, enums: String, defaults: true, oneofs: true,
  includeDirs: [path.resolve(__dirname, "../../../../api/proto")]
});
const egaopProto = grpc.loadPackageDefinition(packageDefinition) as any;

let repo: SecretRepository | null = null;
let bundle: ServerBundle | null = null;
const secrets = new Map<string, any>();

beforeAll(async () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Pool } = require("pg");
  const mockPool = new Pool() as { query: jest.Mock; connect: jest.Mock; end: jest.Mock };
  mockPool.query.mockImplementation(async (sql: string, params: any[]) => {
    // INSERT INTO secrets ... ON CONFLICT ... DO UPDATE
    if (sql.trimStart().startsWith("INSERT INTO secrets")) {
      const key = `${params[0]}/${params[1]}`;
      secrets.set(key, {
        id: "00000000-0000-0000-0000-000000000001",
        namespace: params[0],
        name: params[1],
        encrypted_data: params[2],
        type: params[3] || "api_key",
        created_at: new Date(),
        updated_at: new Date(),
      });
      return { rows: [], rowCount: 1 };
    }

    // SELECT ... FROM secrets WHERE namespace = $1 AND name = $2
    if (sql.includes("SELECT") && sql.includes("FROM secrets")) {
      const key = `${params[0]}/${params[1]}`;
      const secret = secrets.get(key);
      if (!secret) return { rows: [], rowCount: 0 };
      return { rows: [secret], rowCount: 1 };
    }

    return { rows: [], rowCount: 0 };
  });

  repo = new SecretRepository({
    host: "127.0.0.1",
    port: 5432,
    database: "testdb",
    user: "testuser",
    password: "testpass",
  });

  bundle = await createServerBundle({ masterKey: MASTER_KEY, repo });
}, 180000);

afterAll(async () => {
  if (bundle) await destroyServerBundle(bundle);
});

function createSecretClient(port: number) {
  const SecretService = egaopProto.egaop.v1.SecretService;
  return new SecretService(`localhost:${port}`, grpc.credentials.createInsecure());
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

describe("Secret Store — gRPC integration", () => {
  let client: any;
  let healthClient: ReturnType<typeof createHealthClient>;

  beforeAll(() => {
    if (!bundle) return;
    client = createSecretClient(bundle.port);
    // Health service is registered on the gRPC server, not the HTTP health endpoint
    healthClient = createHealthClient(bundle.port);
  });

  afterAll(() => {
    if (healthClient) healthClient.close();
  });

  describe("CreateSecret", () => {
    it("should encrypt and store secret data", (done) => {
      if (!bundle) return done();
      client.CreateSecret({
        name: "api-key",
        namespace: "default",
        data: { key: "sk-1234567890" },
        type: "api_key"
      }, (err: any, response: any) => {
        expect(err).toBeNull();
        expect(response.metadata.name).toBe("api-key");
        expect(response.metadata.namespace).toBe("default");
        expect(parseInt(response.metadata.created_at.seconds, 10)).toBeGreaterThan(1700000000);
        expect(response.spec.type).toBe("api_key");
        expect(response.spec.data.status).toBe("STORED_ENCRYPTED");
        expect(response.spec.rotation.enabled).toBe(true);
        done();
      });
    });

    it("should persist encrypted value in PostgreSQL", (done) => {
      if (!bundle) return done();
      client.CreateSecret({
        name: "db-password",
        namespace: "prod",
        data: { password: "s3cret!" },
        type: "environment_variable"
      }, async (err: any, _response: any) => {
        expect(err).toBeNull();
        const stored = await bundle!.repo.get("prod", "db-password");
        expect(stored).not.toBeNull();
        expect(stored!.encryptedData).toContain(":");
        done();
      });
    });
  });

  describe("GetSecret", () => {
    it("should decrypt and return stored secret", (done) => {
      if (!bundle) return done();
      client.CreateSecret({
        name: "my-secret",
        namespace: "test-ns",
        data: { username: "admin", password: "hunter2" },
        type: "environment_variable"
      }, () => {
        client.GetSecret({ name: "my-secret", namespace: "test-ns" }, (err: any, response: any) => {
          expect(err).toBeNull();
          expect(response.spec.data.username).toBe("admin");
          expect(response.spec.data.password).toBe("hunter2");
          done();
        });
      });
    });

    it("should return NOT_FOUND for missing secret", (done) => {
      client.GetSecret({ name: "nonexistent", namespace: "default" }, (err: any, _response: any) => {
        expect(err).toBeDefined();
        expect(err.code).toBe(grpc.status.NOT_FOUND);
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
