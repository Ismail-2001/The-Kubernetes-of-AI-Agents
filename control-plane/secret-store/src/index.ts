import { initTracing, shutdownTracing, createNamespaceServerInterceptor, createServiceTokenServerInterceptor, createTraceServerInterceptor, validateSecrets, loadSecretsIntoEnv, createAuditEntry, buildHealthResponse, healthToHttpStatus, checkPostgres } from "@e-gaop/shared";

initTracing("secret-store");
loadSecretsIntoEnv();
if (process.env.NODE_ENV !== "test") {
  validateSecrets();
}

import path from "path";
import http from "http";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import pino from "pino";
import { getServerCredentials, encrypt, decrypt, extractNamespace, type EncryptedPayload } from "@e-gaop/shared";
import { SecretRepository } from "./repository";

const SERVICE_VERSION = process.env.SERVICE_VERSION || "1.0.0";
const healthStartTime = new Date();

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
  ...(process.env.NODE_ENV !== "production" && process.env.NODE_ENV !== "test" ? {
    transport: { target: "pino-pretty", options: { colorize: true } }
  } : {}),
});

const MASTER_KEY = (() => {
  const key = process.env.EGAOP_MASTER_ENCRYPTION_KEY;
  if (!key) {
    logger.fatal("EGAOP_MASTER_ENCRYPTION_KEY is not set — refusing to start");
    process.exit(1);
  }
  if (key === "default" || key === "dev-key-do-not-use-in-production" || key.length < 32) {
    logger.fatal("EGAOP_MASTER_ENCRYPTION_KEY is a known-bad or weak value — refusing to start");
    process.exit(1);
  }
  logger.info(`✓ EGAOP_MASTER_ENCRYPTION_KEY validated (${key.length} chars)`);
  return key;
})();

const repo = new SecretRepository();

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

const server = new grpc.Server({
  interceptors: [createNamespaceServerInterceptor(), createServiceTokenServerInterceptor(), createTraceServerInterceptor()],
});

server.addService(secretService.service, {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- dynamically loaded proto handler
  CreateSecret: async (call: any, callback: any) => {
    const { name, namespace, data, type } = call.request;
    const key = `${namespace}/${name}`;
    logger.info({ key, type }, "Encrypting and storing secret to PostgreSQL");
    try {
      const encryptedPayload = await encrypt(JSON.stringify(data), MASTER_KEY);
      await repo.upsert({
        namespace,
        name,
        encryptedData: JSON.stringify(encryptedPayload),
        type: type ?? "api_key",
      });
      logger.info({ key }, "Secret persisted to PostgreSQL");

      try {
        createAuditEntry(
          "secret.create",
          "info",
          { type: "service", id: "secret-store" },
          { name: "CreateSecret", result: "allowed" },
          { type: "secret", id: key, namespace },
        );
      } catch { /* audit failure is non-fatal */ }

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
      logger.error({ key, err: message }, "Failed to persist secret");
      callback({ code: grpc.status.INTERNAL, message: `Encryption or persistence failed: ${message}` });
    }
  },

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- dynamically loaded proto handler
  GetSecret: async (call: any, callback: any) => {
    const { name, namespace, agent_id } = call.request;
    const key = `${namespace}/${name}`;
    logger.info({ key, agent_id }, "Retrieving and decrypting secret from PostgreSQL");
    try {
      if (!agent_id) {
        try {
          createAuditEntry(
            "secret.access",
            "warn",
            { type: "service", id: "secret-store" },
            { name: "GetSecret", result: "denied", reason: "missing agent_id scope" },
            { type: "secret", id: key, namespace },
          );
        } catch { /* audit failure is non-fatal */ }
        return callback({ code: grpc.status.PERMISSION_DENIED, message: "GetSecret requires agent_id for scoped access" });
      }

      const agentNamespace = extractNamespace(agent_id);
      if (agentNamespace !== namespace) {
        try {
          createAuditEntry(
            "secret.access",
            "warn",
            { type: "service", id: "secret-store" },
            { name: "GetSecret", result: "denied", reason: "namespace mismatch" },
            { type: "secret", id: key, namespace },
          );
        } catch { /* audit failure is non-fatal */ }
        return callback({ code: grpc.status.PERMISSION_DENIED, message: `Agent in '${agentNamespace}' cannot access secret in '${namespace}'` });
      }

      const row = await repo.get(namespace, name);
      if (!row) {
        try {
          createAuditEntry(
            "secret.access",
            "warn",
            { type: "service", id: "secret-store" },
            { name: "GetSecret", result: "denied", reason: "not found" },
            { type: "secret", id: key, namespace },
          );
        } catch { /* audit failure is non-fatal */ }
        return callback({ code: grpc.status.NOT_FOUND, message: `Secret ${key} not found` });
      }
      const payload: EncryptedPayload = JSON.parse(row.encryptedData);
      const decryptedData = JSON.parse(await decrypt(payload, MASTER_KEY));

      try {
        createAuditEntry(
          "secret.access",
          "info",
          { type: "service", id: "secret-store" },
          { name: "GetSecret", result: "allowed" },
          { type: "secret", id: key, namespace },
        );
      } catch { /* audit failure is non-fatal */ }

      callback(null, {
        metadata: { name, namespace },
        spec: { type: row.type, data: decryptedData }
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ key, err: message }, "Failed to retrieve or decrypt secret");
      callback({ code: grpc.status.INTERNAL, message: `Retrieval or decryption failed: ${message}` });
    }
  }
});

server.addService(HEALTH_SERVICE, {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- dynamically loaded proto handler
  check: async (_call: any, callback: any) => {
    const dbOk = await repo.ping();
    callback(null, { status: dbOk ? "SERVING" : "NOT_SERVING" });
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

  const healthServer = http.createServer(async (req, res) => {
    if (req.url === "/healthz") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "SERVING", service: "secret-store" }));
    } else if (req.url === "/readyz") {
      const checks = await Promise.all([
        checkPostgres(() => repo.ping()),
      ]);
      const response = buildHealthResponse("secret-store", SERVICE_VERSION, healthStartTime, checks);
      const code = healthToHttpStatus(response.status);
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(JSON.stringify(response));
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
      await repo.close();
      await shutdownTracing();
      logger.info("Secret Store shut down");
      process.exit(0);
    });
    setTimeout(() => { logger.error("Forced shutdown"); process.exit(1); }, 5000).unref();
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

export { server, repo };
