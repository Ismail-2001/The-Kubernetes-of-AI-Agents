import path from "path";
import http from "http";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import pino from "pino";
import { createNamespaceServerInterceptor, encrypt, decrypt, type EncryptedPayload } from "@e-gaop/shared";
import { SecretRepository } from "./repository";

const HEALTH_SERVICE: grpc.ServiceDefinition = {
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
  const logger = pino({
    level: "silent",
  });

  const PROTO_PATH = path.resolve(__dirname, "../../../api/proto/egaop/v1/secret.proto");
  const packageDefinition = protoLoader.loadSync(PROTO_PATH, {
    keepCase: true,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true,
    includeDirs: [path.resolve(__dirname, "../../../api/proto")]
  });

  const egaopProto = grpc.loadPackageDefinition(packageDefinition) as any;
  const secretService = egaopProto.egaop.v1.SecretService;

  const grpcServer = new grpc.Server({
    interceptors: [createNamespaceServerInterceptor()],
  });

  grpcServer.addService(secretService.service, {
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
      } catch (err: any) {
        callback({ code: grpc.status.INTERNAL, message: `Encryption or persistence failed: ${err.message}` });
      }
    },

    GetSecret: async (call: any, callback: any) => {
      const { name, namespace } = call.request;
      try {
        const row = await config.repo.get(namespace, name);
        if (!row) {
          return callback({ code: grpc.status.NOT_FOUND, message: `Secret ${namespace}/${name} not found` });
        }
        const payload: EncryptedPayload = JSON.parse(row.encryptedData);
        const decryptedData = JSON.parse(await decrypt(payload, config.masterKey));
        callback(null, {
          metadata: { name, namespace },
          spec: { type: row.type, data: decryptedData }
        });
      } catch (err: any) {
        callback({ code: grpc.status.INTERNAL, message: `Retrieval or decryption failed: ${err.message}` });
      }
    }
  });

  grpcServer.addService(HEALTH_SERVICE, {
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
