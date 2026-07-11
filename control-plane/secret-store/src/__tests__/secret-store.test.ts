import path from "path";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import { SecretRepository } from "../repository";
import { createServerBundle, destroyServerBundle, type ServerBundle } from "../test-server";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { GenericContainer, Wait } = require("testcontainers");

const MASTER_KEY = "test-master-key-for-unit-tests-only-32chars";

const PROTO_PATH = path.resolve(__dirname, "../../../../api/proto/egaop/v1/secret.proto");
const packageDefinition = protoLoader.loadSync(PROTO_PATH, {
  keepCase: true, longs: String, enums: String, defaults: true, oneofs: true,
  includeDirs: [path.resolve(__dirname, "../../../../api/proto")]
});
const egaopProto = grpc.loadPackageDefinition(packageDefinition) as any;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let pgContainer: any = null;
let repo: SecretRepository | null = null;
let bundle: ServerBundle | null = null;

beforeAll(async () => {
  // 1. Start PostgreSQL
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
  const postgresPort = container.getMappedPort(5432);

  // 2. Run migration
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
  await client.query(`
    CREATE TABLE IF NOT EXISTS secrets (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        namespace VARCHAR(255) NOT NULL,
        name VARCHAR(255) NOT NULL,
        encrypted_data TEXT NOT NULL,
        type VARCHAR(100) NOT NULL DEFAULT 'api_key',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(namespace, name)
    );
    CREATE INDEX IF NOT EXISTS idx_secrets_namespace_name ON secrets (namespace, name);
  `);
  await client.end();

  // 3. Create repository pointing at testcontainer
  repo = new SecretRepository({
    host: "127.0.0.1",
    port: postgresPort,
    database: "testdb",
    user: "testuser",
    password: "testpass",
  });

  // 4. Create gRPC server with this repo
  bundle = await createServerBundle({ masterKey: MASTER_KEY, repo });
}, 180000);

afterAll(async () => {
  if (bundle) await destroyServerBundle(bundle);
  if (pgContainer) await pgContainer.stop();
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
