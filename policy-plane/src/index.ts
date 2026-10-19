import { initTracing, shutdownTracing, createNamespaceServerInterceptor, createServiceTokenServerInterceptor, createTraceServerInterceptor, validateSecrets, loadSecretsIntoEnv } from "@e-gaop/shared";

initTracing("policy-plane");
loadSecretsIntoEnv();
if (process.env.NODE_ENV !== "test") {
  validateSecrets();
}

import http from "http";
import * as grpc from "@grpc/grpc-js";
import pino from "pino";
import { PolicyPlaneService } from "./service";
import { createPolicyHttpHandler } from "./http-api";
import { getServerCredentials } from "@e-gaop/shared";

const OPA_URL = process.env.OPA_URL || "http://localhost:8181";

async function verifyOPAPolicies(logger: pino.Logger): Promise<void> {
  const requiredPackages = ["egaop/admission", "egaop/execution", "egaop/runtime"];
  for (const pkg of requiredPackages) {
    try {
      const response = await fetch(`${OPA_URL}/v1/data/${pkg}`, {
        method: "GET",
        signal: AbortSignal.timeout(5000),
      });
      if (response.ok) {
        logger.info(`OPA policy package '${pkg}' loaded successfully`);
      } else {
        logger.warn({ status: response.status }, `OPA policy package '${pkg}' not found (HTTP ${response.status})`);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn({ err: msg }, `OPA policy package '${pkg}' verification failed`);
    }
  }
}

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

const server = new grpc.Server({
  interceptors: [createNamespaceServerInterceptor(), createServiceTokenServerInterceptor(), createTraceServerInterceptor()],
});

server.addService(HEALTH_SERVICE, {
  check: (_call: grpc.ServerUnaryCall<unknown, unknown>, callback: grpc.sendUnaryData<unknown>) => {
    const service = PolicyPlaneService.getInstance();
    const stats = service.getStats();
    callback(null, {
      status: stats.circuitState === "OPEN" ? "NOT_SERVING" : "SERVING",
    });
  },
});

if (process.env.NODE_ENV !== "test") {
  const POLICY_PORT = process.env.POLICY_PLANE_PORT || "50059";
  const HEALTH_PORT = parseInt(
    process.env.POLICY_PLANE_HEALTH_PORT || "15059",
    10
  );

  verifyOPAPolicies(logger).catch((err) => {
    logger.error({ err: err instanceof Error ? err.message : String(err) }, "OPA policy verification failed at startup");
  });

  server.bindAsync(
    `0.0.0.0:${POLICY_PORT}`,
    getServerCredentials(),
    (err, port) => {
      if (err) {
        logger.error(err, "Failed to bind Policy Plane server");
        return;
      }
      server.start();
      logger.info(`E-GAOP Policy Plane gRPC server listening on port ${port}`);
    }
  );

  const policyHttpServer = http.createServer(createPolicyHttpHandler());
  policyHttpServer.listen(HEALTH_PORT, "0.0.0.0", () => {
    logger.info(`Policy HTTP API + health endpoints listening on port ${HEALTH_PORT}`);
  });

  const shutdown = async () => {
    logger.info("Shutting down Policy Plane...");
    server.tryShutdown(async () => {
      policyHttpServer.close();
      await shutdownTracing();
      logger.info("Policy Plane shut down");
      process.exit(0);
    });
    setTimeout(() => {
      logger.error("Forced shutdown");
      process.exit(1);
    }, 5000).unref();
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

export { server, PolicyPlaneService };
