import path from "path";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import { server, encryptedVault } from "../index";

const PROTO_PATH = path.resolve(__dirname, "../../../../api/proto/egaop/v1/secret.proto");

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

describe("Secret Store", () => {
  let port: number;
  let client: any;
  let healthClient: ReturnType<typeof createHealthClient>;

  beforeAll(async () => {
    encryptedVault.clear();
    port = await startServer(server);
    const SecretService = egaopProto.egaop.v1.SecretService;
    client = new SecretService(`localhost:${port}`, grpc.credentials.createInsecure());
    healthClient = createHealthClient(port);
  });

  afterAll(() => {
    healthClient.close();
    server.forceShutdown();
  });

  describe("CreateSecret", () => {
    it("should encrypt and store secret data", (done) => {
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

    it("should persist encrypted value in vault", (done) => {
      client.CreateSecret({
        name: "db-password",
        namespace: "prod",
        data: { password: "s3cret!" },
        type: "environment_variable"
      }, (err: any, _response: any) => {
        expect(err).toBeNull();
        const stored = encryptedVault.get("prod/db-password");
        expect(stored).toBeDefined();
        expect(stored).toContain(":"); // iv:tag:ciphertext format
        done();
      });
    });
  });

  describe("GetSecret", () => {
    it("should decrypt and return stored secret", (done) => {
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
