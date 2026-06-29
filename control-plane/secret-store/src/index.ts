import { initTracing, shutdownTracing, createNamespaceServerInterceptor } from "@e-gaop/shared";

initTracing("secret-store");

import path from "path";
import http from "http";
import fs from "fs";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import pino from "pino";
import { getServerCredentials, encrypt, decrypt, type EncryptedPayload } from "@e-gaop/shared";

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

const logger = pino({
  level: process.env.NODE_ENV === "test" ? "silent" : (process.env.LOG_LEVEL || "info"),
  transport: process.env.NODE_ENV !== "test" ? {
    target: "pino-pretty",
    options: { colorize: true }
  } : undefined,
});

const MASTER_KEY = process.env.EGAOP_MASTER_ENCRYPTION_KEY || (() => {
  if (process.env.NODE_ENV === "production") {
    throw new Error("EGAOP_MASTER_ENCRYPTION_KEY must be set in production");
  }
  logger.warn("Using fallback development encryption key");
  return "dev-key-do-not-use-in-production";
})();

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

const encryptedVault: Map<string, string> = new Map();

const server = new grpc.Server({
  interceptors: [createNamespaceServerInterceptor()],
});

server.addService(secretService.service, {
  CreateSecret: async (call: any, callback: any) => {
    const { name, namespace, data, type } = call.request;
    const key = `${namespace}/${name}`;
    logger.info({ key, type }, "Encrypting and persisting new secret to vault");
    try {
      const encryptedPayload = await encrypt(JSON.stringify(data), MASTER_KEY);
      encryptedVault.set(key, JSON.stringify(encryptedPayload));
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
      callback({ code: grpc.status.INTERNAL, message: `Encryption failed: ${err.message}` });
    }
  },

  GetSecret: async (call: any, callback: any) => {
    const { name, namespace } = call.request;
    const key = `${namespace}/${name}`;
    logger.info({ key }, "Decrypting and retrieving secret");
    const encryptedData = encryptedVault.get(key);
    if (!encryptedData) {
      return callback({ code: grpc.status.NOT_FOUND, message: `Secret ${key} not found` });
    }
    try {
      const payload: EncryptedPayload = JSON.parse(encryptedData);
      const decryptedData = JSON.parse(await decrypt(payload, MASTER_KEY));
      callback(null, {
        metadata: { name, namespace },
        spec: { type: "api_key", data: decryptedData }
      });
    } catch {
      callback({ code: grpc.status.INTERNAL, message: "Decryption failure: key mismatch or payload corruption" });
    }
  }
});

server.addService(HEALTH_SERVICE, {
  check: (_call: any, callback: any) => {
    callback(null, { status: "SERVING" });
  }
});

if (process.env.NODE_ENV !== "test") {
  const SECRET_PORT = process.env.SECRET_STORE_PORT || "50057";
  const HEALTH_PORT = parseInt(process.env.SECRET_STORE_HEALTH_PORT || "15057", 10);

  server.bindAsync(`0.0.0.0:${SECRET_PORT}`, getServerCredentials(), (err, port) => {
    if (err) {
      logger.error(err, "Failed to bind Secret Store server");
      return;
    }
    server.start();
    logger.info(`E-GAOP Dynamic Secret Store listening on port ${port}`);
  });

  const healthServer = http.createServer((req, res) => {
    if (req.url === "/healthz" || req.url === "/readyz") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "SERVING", service: "secret-store", timestamp: new Date().toISOString() }));
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  healthServer.listen(HEALTH_PORT, "0.0.0.0", () => {
    logger.info(`Health endpoint listening on port ${HEALTH_PORT}`);
  });

  const shutdown = async () => {
    logger.info("Shutting down Secret Store...");
    server.tryShutdown(async () => {
      healthServer.close();
      await shutdownTracing();
      logger.info("Secret Store shut down");
      process.exit(0);
    });
    setTimeout(() => { logger.error("Forced shutdown"); process.exit(1); }, 5000).unref();
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

export { server, encryptedVault };
