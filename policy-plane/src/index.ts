import { initTracing, shutdownTracing, createNamespaceServerInterceptor, createServiceTokenServerInterceptor, validateSecrets, loadSecretsIntoEnv } from "@e-gaop/shared";

initTracing("policy-plane");
loadSecretsIntoEnv();
if (process.env.NODE_ENV !== "test") {
  validateSecrets();
}

import path from "path";
import http from "http";
import fs from "fs";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import pino from "pino";
import { PolicyPlaneService } from "./service";
import { getServerCredentials } from "@e-gaop/shared";

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
  level:
    process.env.NODE_ENV === "test"
      ? "silent"
      : process.env.LOG_LEVEL || "info",
  transport:
    process.env.NODE_ENV !== "test"
      ? { target: "pino-pretty", options: { colorize: true } }
      : undefined,
});

const PROTO_PATH = path.resolve(
  __dirname,
  "../../../api/proto/egaop/v1/execution.proto"
);

const packageDefinition = protoLoader.loadSync(PROTO_PATH, {
  keepCase: true,
  longs: String,
  enums: String,
  defaults: true,
  oneofs: true,
  includeDirs: [path.resolve(__dirname, "../../../api/proto")],
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const egaopProto = grpc.loadPackageDefinition(packageDefinition) as any;
const observabilityService = egaopProto["egaop"]?.["v1"]?.["ObservabilityService"];

const server = new grpc.Server({
  interceptors: [createNamespaceServerInterceptor(), createServiceTokenServerInterceptor()],
});

if (observabilityService?.service) {
  server.addService(observabilityService.service, {
    ExportTrace: (
      call: grpc.ServerUnaryCall<unknown, unknown>,
      callback: grpc.sendUnaryData<unknown>
    ) => {
      const request = call.request as Record<string, unknown>;
      logger.info(
        { span: request["span_id"], name: request["name"] },
        "Recording execution trace"
      );
      callback(null, {
        success: true,
        span_id: request["span_id"],
        timestamp: { seconds: Math.floor(Date.now() / 1000) },
      });
    },

    GetExecutionReplay: (
      call: grpc.ServerUnaryCall<unknown, unknown>,
      callback: grpc.sendUnaryData<unknown>
    ) => {
      const request = call.request as Record<string, unknown>;
      logger.info(
        { executionId: request["execution_id"] },
        "Retrieving execution replay"
      );
      callback(null, {
        execution_id: request["execution_id"],
        spans: [],
        total_cost: "$0.00",
        status: "NOT_FOUND",
      });
    },
  });
}

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

  const healthServer = http.createServer((req, res) => {
    if (req.url === "/healthz" || req.url === "/readyz") {
      const service = PolicyPlaneService.getInstance();
      const stats = service.getStats();
      const status =
        stats.circuitState === "OPEN" ? "NOT_SERVING" : "SERVING";
      const code = stats.circuitState === "OPEN" ? 503 : 200;
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          status,
          service: "policy-plane",
          circuit_breaker: stats.circuitState,
          cache_size: stats.cacheSize,
          timestamp: new Date().toISOString(),
        })
      );
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  healthServer.listen(HEALTH_PORT, "0.0.0.0", () => {
    logger.info(`Health endpoint listening on port ${HEALTH_PORT}`);
  });

  const shutdown = async () => {
    logger.info("Shutting down Policy Plane...");
    server.tryShutdown(async () => {
      healthServer.close();
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
