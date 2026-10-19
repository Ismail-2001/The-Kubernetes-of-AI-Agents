jest.mock("pg", () => {
  const mPool = { query: jest.fn(), connect: jest.fn(), end: jest.fn() };
  return { Pool: jest.fn(() => mPool) };
});

import crypto from "crypto";
import http from "http";
import path from "path";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import { SecretRepository } from "../repository";
import { createServerBundle, destroyServerBundle, HEALTH_SERVICE, type ServerBundle } from "../test-server";

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
let mockPool!: { query: jest.Mock; connect: jest.Mock; end: jest.Mock };

beforeAll(async () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Pool } = require("pg");
  mockPool = new Pool() as { query: jest.Mock; connect: jest.Mock; end: jest.Mock };
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
  const HealthClient = grpc.makeGenericClientConstructor(HEALTH_SERVICE, "Health") as any;
  const client = new HealthClient(`localhost:${port}`, grpc.credentials.createInsecure());
  return {
    Check: (req: any, callback: any) => client.check(req, callback),
    close: () => client.close()
  };
}

function httpGet(url: string): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        let body = "";
        res.on("data", (chunk) => {
          body += chunk;
        });
        res.on("end", () => resolve({ statusCode: res.statusCode ?? 0, body }));
      })
      .on("error", reject);
  });
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

    it("should NOT persist the master key inside the encrypted payload (P0-1)", (done) => {
      if (!bundle) return done();
      client.CreateSecret({
        name: "no-leak-secret",
        namespace: "default",
        data: { key: "sk-super-secret" },
        type: "api_key"
      }, async (err: any, _response: any) => {
        expect(err).toBeNull();
        const stored = await bundle!.repo.get("default", "no-leak-secret");
        expect(stored).not.toBeNull();
        expect(stored!.encryptedData).not.toContain(MASTER_KEY);
        const payload = JSON.parse(stored!.encryptedData);
        expect(payload.kdf.name).toBe("scrypt");
        expect(payload.keyId).not.toBe(MASTER_KEY);
        done();
      });
    });

    it("should default to api_key type when type is omitted", (done) => {
      if (!bundle) return done();
      client.CreateSecret({
        name: "no-type-secret",
        namespace: "default",
        data: { token: "abc123" }
      }, async (err: any, _response: any) => {
        expect(err).toBeNull();
        const stored = await bundle!.repo.get("default", "no-type-secret");
        expect(stored).not.toBeNull();
        expect(stored!.type).toBe("api_key");
        done();
      });
    });

    it("should surface an INTERNAL error when persistence fails", (done) => {
      if (!bundle) return done();
      mockPool.query.mockRejectedValueOnce(new Error("db exploded"));
      client.CreateSecret({
        name: "fail-secret",
        namespace: "default",
        data: { key: "v" },
        type: "api_key"
      }, (err: any) => {
        expect(err).toBeDefined();
        expect(err.code).toBe(grpc.status.INTERNAL);
        expect(err.message).toContain("db exploded");
        done();
      });
    });

    it("should handle non-Error persistence failures", (done) => {
      if (!bundle) return done();
      mockPool.query.mockRejectedValueOnce("plain string failure");
      client.CreateSecret({
        name: "fail-secret-2",
        namespace: "default",
        data: { key: "v" },
        type: "api_key"
      }, (err: any) => {
        expect(err).toBeDefined();
        expect(err.code).toBe(grpc.status.INTERNAL);
        expect(err.message).toContain("plain string failure");
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
        client.GetSecret({ name: "my-secret", namespace: "test-ns", agent_id: "test-ns/agent-123" }, (err: any, response: any) => {
          expect(err).toBeNull();
          expect(response.spec.data.username).toBe("admin");
          expect(response.spec.data.password).toBe("hunter2");
          done();
        });
      });
    });

    it("should lazily re-encrypt a legacy row that embedded the master key (P0-1)", (done) => {
      if (!bundle) return done();
      // Build a legacy payload exactly as the pre-fix code did:
      // key = scrypt(masterKey, salt), keyId field = the master key itself.
      const salt = crypto.randomBytes(16);
      const iv = crypto.randomBytes(12);
      const key = crypto.scryptSync(MASTER_KEY, salt, 32, {
        cost: 16384, blockSize: 8, parallelization: 1, maxmem: 64 * 1024 * 1024,
      });
      const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
      const plaintext = JSON.stringify({ legacy: "old-format" });
      const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
      const legacyPayload = {
        version: 2,
        algorithm: "aes-256-gcm",
        kdf: { name: "argon2id", memoryCost: 65536, timeCost: 3, parallelism: 4 },
        salt: salt.toString("base64"),
        iv: iv.toString("base64"),
        tag: cipher.getAuthTag().toString("base64"),
        ciphertext: ct.toString("base64"),
        keyId: MASTER_KEY,
        createdAt: new Date().toISOString(),
      };
      secrets.set("test-ns/legacy-row", {
        id: "00000000-0000-0000-0000-000000000009",
        namespace: "test-ns",
        name: "legacy-row",
        encrypted_data: JSON.stringify(legacyPayload),
        type: "api_key",
        created_at: new Date(),
        updated_at: new Date(),
      });

      client.GetSecret({ name: "legacy-row", namespace: "test-ns", agent_id: "test-ns/agent-123" }, async (err: any, response: any) => {
        expect(err).toBeNull();
        expect(response.spec.data.legacy).toBe("old-format");
        // Row must have been re-encrypted in place: no key material, truthful KDF label.
        const stored = await bundle!.repo.get("test-ns", "legacy-row");
        expect(stored).not.toBeNull();
        expect(stored!.encryptedData).not.toContain(MASTER_KEY);
        const upgraded = JSON.parse(stored!.encryptedData);
        expect(upgraded.kdf.name).toBe("scrypt");
        expect(upgraded.keyId).not.toBe(MASTER_KEY);
        done();
      });
    });

    it("should deny access when agent is outside the requested namespace", (done) => {
      if (!bundle) return done();
      client.GetSecret({ name: "my-secret", namespace: "test-ns", agent_id: "other-ns/agent-456" }, (err: any, _response: any) => {
        expect(err).toBeDefined();
        expect(err.code).toBe(grpc.status.PERMISSION_DENIED);
        done();
      });
    });

    it("should deny access when agent_id is missing", (done) => {
      if (!bundle) return done();
      client.GetSecret({ name: "my-secret", namespace: "test-ns" }, (err: any, _response: any) => {
        expect(err).toBeDefined();
        expect(err.code).toBe(grpc.status.PERMISSION_DENIED);
        done();
      });
    });

    it("should return NOT_FOUND for missing secret", (done) => {
      client.GetSecret({ name: "nonexistent", namespace: "default", agent_id: "default/agent-789" }, (err: any, _response: any) => {
        expect(err).toBeDefined();
        expect(err.code).toBe(grpc.status.NOT_FOUND);
        done();
      });
    });

    it("should surface an INTERNAL error when retrieval fails", (done) => {
      if (!bundle) return done();
      client.CreateSecret({
        name: "retrieve-fail",
        namespace: "default",
        data: { k: "v" },
        type: "api_key"
      }, () => {
        mockPool.query.mockRejectedValueOnce(new Error("read failed"));
        client.GetSecret({ name: "retrieve-fail", namespace: "default", agent_id: "default/agent-1" }, (err: any) => {
          expect(err).toBeDefined();
          expect(err.code).toBe(grpc.status.INTERNAL);
          expect(err.message).toContain("read failed");
          done();
        });
      });
    });

    it("should handle non-Error retrieval failures", (done) => {
      if (!bundle) return done();
      client.CreateSecret({
        name: "retrieve-fail-2",
        namespace: "default",
        data: { k: "v" },
        type: "api_key"
      }, () => {
        mockPool.query.mockRejectedValueOnce("read exploded");
        client.GetSecret({ name: "retrieve-fail-2", namespace: "default", agent_id: "default/agent-1" }, (err: any) => {
          expect(err).toBeDefined();
          expect(err.code).toBe(grpc.status.INTERNAL);
          expect(err.message).toContain("read exploded");
          done();
        });
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

  describe("HTTP health endpoint", () => {
    it("should return SERVING for /healthz", async () => {
      if (!bundle) return;
      const res = await httpGet(`http://127.0.0.1:${bundle.healthPort}/healthz`);
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).status).toBe("SERVING");
    });

    it("should return SERVING for /readyz", async () => {
      if (!bundle) return;
      const res = await httpGet(`http://127.0.0.1:${bundle.healthPort}/readyz`);
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).status).toBe("SERVING");
    });

    it("should return 404 for unknown paths", async () => {
      if (!bundle) return;
      const res = await httpGet(`http://127.0.0.1:${bundle.healthPort}/unknown`);
      expect(res.statusCode).toBe(404);
    });
  });

  describe("server bootstrap failures", () => {
    it("should reject when the gRPC server fails to bind", async () => {
      if (!bundle) return;
      const bindSpy = jest
        .spyOn(grpc.Server.prototype, "bindAsync")
        .mockImplementationOnce((_addr: string, _creds: any, callback: (err: Error | null, port: number) => void) => {
          callback(new Error("port in use"), 0);
        });
      try {
        await expect(
          createServerBundle({ masterKey: MASTER_KEY, repo: bundle.repo })
        ).rejects.toThrow("port in use");
      } finally {
        bindSpy.mockRestore();
      }
    });
  });
});
