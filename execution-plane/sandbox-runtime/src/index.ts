import { initTracing, shutdownTracing, validateSecrets, loadSecretsIntoEnv, buildHealthResponse, healthToHttpStatus } from "@e-gaop/shared";

initTracing("sandbox-runtime");
loadSecretsIntoEnv();
if (process.env.NODE_ENV !== "test") {
  validateSecrets();
}

import path from "path";
import http from "http";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import pino from "pino";
import { getServerCredentials, createNamespaceServerInterceptor, createServiceTokenServerInterceptor, createTraceServerInterceptor, createAuditEntry } from "@e-gaop/shared";
import type { SandboxDriver } from "@e-gaop/shared";

const logger = pino({
  level: process.env.NODE_ENV === "test" ? "silent" : (process.env.LOG_LEVEL || "info"),
  ...(process.env.NODE_ENV !== "production" && process.env.NODE_ENV !== "test" ? {
    transport: { target: "pino-pretty", options: { colorize: true } }
  } : {}),
});

function createDriver(): SandboxDriver {
  const driver = process.env.SANDBOX_DRIVER ?? "docker";
  if (driver === "k8s") {
    // Lazy-load K8s driver — avoids importing @kubernetes/client-node at module scope
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { K8sSandboxDriver } = require("@e-gaop/shared/dist/sandbox/sandbox-driver-k8s.js");
    logger.info("Using K8s sandbox driver");
    return new K8sSandboxDriver();
  }
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { DockerSandboxDriver } = require("./docker-driver");
  logger.info("Using Docker sandbox driver");
  return new DockerSandboxDriver();
}

const sandboxDriver = createDriver();

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

const PROTO_PATH = path.resolve(__dirname, "../../../api/proto/egaop/v1/runtime.proto");

const packageDefinition = protoLoader.loadSync(PROTO_PATH, {
  keepCase: true,
  longs: String,
  enums: String,
  defaults: true,
  oneofs: true,
  includeDirs: [path.resolve(__dirname, "../../../api/proto")],
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- proto-loader returns dynamic types with no static definitions
const egaopProto = grpc.loadPackageDefinition(packageDefinition) as any;
const runtimeService = egaopProto.egaop.v1.RuntimeService;

const server = new grpc.Server({
  interceptors: [createNamespaceServerInterceptor(), createServiceTokenServerInterceptor(), createTraceServerInterceptor()],
});

server.addService(runtimeService.service, {
  CreateSandbox: async (call: grpc.ServerUnaryCall<Record<string, unknown>, Record<string, unknown>>, callback: grpc.sendUnaryData<Record<string, unknown>>) => {
    const { agent_id, execution_id, image, isolation_level, resources, env_vars, init_commands } = call.request;

    logger.info({ agent_id, execution_id, isolation_level }, "Creating sandbox...");

    try {
      const result = await sandboxDriver.createSandbox({
        executionId: execution_id as string,
        agentId: agent_id as string,
        namespace: process.env.POD_NAMESPACE || "egaop",
        image: (image as string) || "egaop-base-runtime:latest",
        isolationLevel: isolation_level as string | undefined,
        cpu: (resources as { cpu?: string } | undefined)?.cpu,
        memory: (resources as { memory?: string } | undefined)?.memory,
        envVars: (env_vars as Record<string, string> | undefined) || {},
        initCommands: (init_commands as string[] | undefined) || [],
      });

      try {
        createAuditEntry(
          "sandbox.create",
          "info",
          { type: "service", id: "sandbox-runtime" },
          { name: "CreateSandbox", result: "allowed" },
          { type: "sandbox", id: result.sandboxId },
        );
      } catch (e) {
        logger.warn({ err: e }, "Audit log write failed");
      }

      callback(null, {
        sandbox_id: result.sandboxId,
        status: result.status,
        ip_address: result.ipAddress,
        init_outputs: result.initOutputs,
      });
    } catch (err: unknown) {
      const errObj = err instanceof Error ? err : new Error(String(err));
      const errRecord = err as Record<string, unknown>;
      logger.error({ err: errObj.message }, "Sandbox creation failed");
      callback({
        code: errRecord?.code === "INVALID_ARGUMENT" ? grpc.status.INVALID_ARGUMENT : grpc.status.INTERNAL,
        message: errRecord?.code === "INVALID_ARGUMENT" ? errObj.message : "Sandbox creation failed",
      });
    }
  },

  TerminateSandbox: async (call: grpc.ServerUnaryCall<Record<string, unknown>, Record<string, unknown>>, callback: grpc.sendUnaryData<Record<string, unknown>>) => {
    const { sandbox_id, reason } = call.request;
    logger.info({ sandbox_id, reason }, "Terminating sandbox...");

    try {
      const success = await sandboxDriver.terminateSandbox(sandbox_id as string);

      try {
        createAuditEntry(
          "sandbox.destroy",
          "info",
          { type: "service", id: "sandbox-runtime" },
          { name: "TerminateSandbox", result: success ? "allowed" : "error", reason: (reason as string) || "unknown" },
          { type: "sandbox", id: sandbox_id as string },
        );
      } catch (e) {
        logger.warn({ err: e }, "Audit log write failed");
      }

      callback(null, { success });
    } catch (err: unknown) {
      const errObj = err instanceof Error ? err : new Error(String(err));
      logger.error({ err: errObj.message }, "Failed to terminate sandbox");
      callback(null, { success: false });
    }
  },

  GetSandboxStatus: async (call: grpc.ServerUnaryCall<Record<string, unknown>, Record<string, unknown>>, callback: grpc.sendUnaryData<Record<string, unknown>>) => {
    const { sandbox_id } = call.request;
    try {
      const status = await sandboxDriver.getSandboxStatus(sandbox_id as string);

      try {
        createAuditEntry(
          "sandbox.exec",
          "info",
          { type: "service", id: "sandbox-runtime" },
          { name: "GetSandboxStatus", result: "allowed" },
          { type: "sandbox", id: sandbox_id as string },
        );
      } catch { /* audit failure is non-fatal */ }

      callback(null, {
        status: status.status,
        cpu_usage: status.cpu,
        memory_usage: status.memory,
        started_at: status.startedAt ? { seconds: Math.floor(status.startedAt.getTime() / 1000) } : undefined,
      });
    } catch {
      callback(null, { status: "Unknown", cpu_usage: 0, memory_usage: 0 });
    }
  },
});

server.addService(HEALTH_SERVICE, {
  check: async (_call: grpc.ServerUnaryCall<Record<string, unknown>, Record<string, unknown>>, callback: grpc.sendUnaryData<Record<string, unknown>>) => {
    try {
      const ok = await sandboxDriver.health();
      callback(null, { status: ok ? "SERVING" : "NOT_SERVING" });
    } catch {
      callback(null, { status: "NOT_SERVING" });
    }
  },
});

if (process.env.NODE_ENV !== "test") {
  const RUNTIME_PORT = process.env.SANDBOX_RUNTIME_PORT || "50054";
  const HEALTH_PORT = parseInt(process.env.SANDBOX_RUNTIME_HEALTH_PORT || "15054", 10);
  const SERVICE_VERSION = process.env.SERVICE_VERSION || "1.0.0";
  const healthStartTime = new Date();

  server.bindAsync(`0.0.0.0:${RUNTIME_PORT}`, getServerCredentials(), (err, port) => {
    if (err) {
      logger.error(err, "Failed to bind Sandbox Runtime server");
      return;
    }
    logger.info(`E-GAOP Sandbox Runtime listening on port ${port}`);
  });

  const healthServer = http.createServer(async (req, res) => {
    const url = req.url ?? "/";

    // ── Liveness: Is the process alive? (no dependency checks) ────────
    if (url === "/healthz") {
      const response = buildHealthResponse("sandbox-runtime", SERVICE_VERSION, healthStartTime, []);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(response));
      return;
    }

    // ── Readiness: Can we create sandboxes? (checks Docker) ──────────
    if (url === "/readyz") {
      const dockerOk = await sandboxDriver.health();
      const checks = [{
        name: "docker",
        status: dockerOk ? "healthy" as const : "unhealthy" as const,
        message: dockerOk ? undefined : "Docker daemon unreachable",
      }];
      const response = buildHealthResponse("sandbox-runtime", SERVICE_VERSION, healthStartTime, checks);
      const code = healthToHttpStatus(response.status);
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(JSON.stringify(response));
      return;
    }

    res.writeHead(404);
    res.end();
  });
  healthServer.listen(HEALTH_PORT, "0.0.0.0", () => {
    logger.info(`Health endpoint listening on port ${HEALTH_PORT}`);
  });

  const shutdown = async () => {
    logger.info("Shutting down Sandbox Runtime...");
    try {
      if (sandboxDriver.cleanup) {
        await sandboxDriver.cleanup();
        logger.info("Terminated active sandbox containers");
      }
    } catch (err) {
      logger.warn({ err }, "Sandbox container cleanup failed");
    }
    server.tryShutdown(async () => {
      healthServer.close();
      await shutdownTracing();
      logger.info("Sandbox Runtime shut down");
      process.exit(0);
    });
    setTimeout(() => { logger.error("Forced shutdown"); process.exit(1); }, 5000).unref();
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

export { server };
