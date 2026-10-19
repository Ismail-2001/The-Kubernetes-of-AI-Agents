import path from "path";
import http from "http";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import { createNamespaceServerInterceptor, encrypt, decrypt, extractNamespace, type EncryptedPayload } from "@e-gaop/shared";
import { SecretRepository } from "./repository";
import { upgradeLegacyRow } from "./migration";

export const HEALTH_SERVICE: grpc.ServiceDefinition = {
  check: {
    path: "/grpc.health.v1.Health/Check",
    requestStream: false,
    responseStream: false,
    requestSerialize: (v: unknown) => Buffer.from(JSON.stringify(v)),
    responseSerialize: (v: unknown) => Buffer.from(JSON.stringify(v)),
    requestDeserialize: (b: Buffer) => JSON.parse(b.toString()),
    responseDeserialize: (b: Buffer) => JSON.parse(b.toString()),
  },
};

export interface ServerBundle {
  grpcServer: grpc.Server;
  healthServer: http.Server;
  repo: SecretRepository;
  port: number;
  healthPort: number;
}

export async function createServerBundle(config: {
  masterKey: string;
  repo: SecretRepository;
  grpcPort?: number;
  healthPort?: number;
}): Promise<ServerBundle> {
  const PROTO_PATH = path.resolve(__dirname, "../../../api/proto/egaop/v1/secret.proto");
  const packageDefinition = protoLoader.loadSync(PROTO_PATH, {
    keepCase: true,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true,
    includeDirs: [path.resolve(__dirname, "../../../api/proto")]
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- dynamic proto loading returns untyped structure
  const egaopProto = grpc.loadPackageDefinition(packageDefinition) as any;
  const secretService = egaopProto.egaop.v1.SecretService;

  const grpcServer = new grpc.Server({
    interceptors: [createNamespaceServerInterceptor()],
  });

  grpcServer.addService(secretService.service, {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- dynamically loaded proto handler
    CreateSecret: async (call: any, callback: any) => {
      const { name, namespace, data, type } = call.request;
      try {
        const encryptedPayload = await encrypt(JSON.stringify(data), config.masterKey);
        await config.repo.upsert({
          namespace,
          name,
          encryptedData: JSON.stringify(encryptedPayload),
          type: type ?? "api_key",
        });
        callback(null, {
          api_version: "egaop.io/v1",
          kind: "Secret",
          metadata: { name, namespace, created_at: { seconds: Math.floor(Date.now() / 1000) } },
          spec: {
            type,
            data: { status: "STORED_ENCRYPTED" },
            rotation: { enabled: true, interval: "24h", strategy: "aes-256-gcm" }
          }
        });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        callback({ code: grpc.status.INTERNAL, message: `Encryption or persistence failed: ${message}` });
      }
    },

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- dynamically loaded proto handler
    GetSecret: async (call: any, callback: any) => {
      const { name, namespace, agent_id } = call.request;
      if (!agent_id || extractNamespace(agent_id) !== namespace) {
        return callback({ code: grpc.status.PERMISSION_DENIED, message: "GetSecret requires agent_id scoped to the requested namespace" });
      }
      try {
        const row = await config.repo.get(namespace, name);
        if (!row) {
          return callback({ code: grpc.status.NOT_FOUND, message: `Secret ${namespace}/${name} not found` });
        }
        const payload: EncryptedPayload = JSON.parse(row.encryptedData);
        const plaintext = await decrypt(payload, config.masterKey);
        try {
          await upgradeLegacyRow({
            repo: config.repo,
            namespace,
            name,
            rowType: row.type,
            payload,
            plaintext,
            masterKey: config.masterKey,
            keyId: "v1",
          });
        } catch { /* lazy re-encryption is best-effort; the read already succeeded */ }
        const decryptedData = JSON.parse(plaintext);
        callback(null, {
          metadata: { name, namespace },
          spec: { type: row.type, data: decryptedData }
        });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        callback({ code: grpc.status.INTERNAL, message: `Retrieval or decryption failed: ${message}` });
      }
    }
  });

  grpcServer.addService(HEALTH_SERVICE, {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- dynamically loaded proto handler
    check: (_call: any, callback: any) => {
      callback(null, { status: "SERVING" });
    }
  });

  // Bind to port 0 for random available port
  const grpcPort = await new Promise<number>((resolve, reject) => {
    grpcServer.bindAsync("localhost:0", grpc.ServerCredentials.createInsecure(), (err, port) => {
      if (err) reject(err);
      else { grpcServer.start(); resolve(port); }
    });
  });

  const healthServer = http.createServer((req, res) => {
    if (req.url === "/healthz" || req.url === "/readyz") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "SERVING", service: "secret-store" }));
    } else {
      res.writeHead(404);
      res.end();
    }
  });

  const healthPort = await new Promise<number>((resolve) => {
    healthServer.listen(0, "127.0.0.1", () => {
      const addr = healthServer.address();
      resolve(typeof addr === "object" && addr ? addr.port : 0);
    });
  });

  return {
    grpcServer,
    healthServer,
    repo: config.repo,
    port: grpcPort,
    healthPort,
  };
}

export function destroyServerBundle(bundle: ServerBundle): Promise<void> {
  return new Promise((resolve) => {
    bundle.healthServer.close();
    bundle.grpcServer.forceShutdown();
    bundle.repo.close().then(() => resolve());
  });
}
