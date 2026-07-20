import { initTracing, shutdownTracing, validateSecrets } from "@e-gaop/shared";

initTracing("sandbox-runtime");
if (process.env.NODE_ENV !== "test") {
  validateSecrets();
}

import path from "path";
import http from "http";
import fs from "fs";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import pino from "pino";
import Docker from "dockerode";
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
  level: process.env.NODE_ENV === "test" ? "silent" : (process.env.LOG_LEVEL || "info"),
  transport: process.env.NODE_ENV !== "test" ? {
    target: "pino-pretty",
    options: { colorize: true }
  } : undefined,
});

const docker = new Docker();

const PROTO_PATH = path.resolve(__dirname, "../../../api/proto/egaop/v1/runtime.proto");

const packageDefinition = protoLoader.loadSync(PROTO_PATH, {
  keepCase: true,
  longs: String,
  enums: String,
  defaults: true,
  oneofs: true,
  includeDirs: [path.resolve(__dirname, "../../../api/proto")]
});

const egaopProto = grpc.loadPackageDefinition(packageDefinition) as any;
const runtimeService = egaopProto.egaop.v1.RuntimeService;

const server = new grpc.Server();

server.addService(runtimeService.service, {
  CreateSandbox: async (call: any, callback: any) => {
    const { agent_id, execution_id, image, isolation_level, resources, env_vars, init_commands } = call.request;

    logger.info({ agent_id, execution_id, isolation_level }, "Allocating sandbox environment...");

    try {
      const NanoCpus = resources?.cpu ? Math.round(parseFloat(resources.cpu) * 1_000_000_000) : 500_000_000;
       const HostConfig: any = {
          Memory: resources?.memory ? parseInt(resources.memory) * 1024 * 1024 : 512 * 1024 * 1024,
          NanoCpus,
          NetworkMode: "egaop-sandbox",
          SecurityOpt: ["no-new-privileges"],
       };

      if (isolation_level === "Enhanced") {
         logger.info("Level 2 Isolation Requested. Enforcing gVisor (runsc) runtime.");
         HostConfig.Runtime = "runsc";
      } else if (isolation_level === "Maximum") {
         logger.info("Level 3 Isolation Requested. Provisioning Firecracker microVM instance.");
         HostConfig.Runtime = "firecracker";
      } else {
         logger.warn("Standard isolation (Level 1) used. Security boundary limited to Docker namespace.");
      }

      const container = await docker.createContainer({
         Image: image || "egaop-base-runtime:latest",
         name: `egaop-agent-${execution_id}`,
         Cmd: ["node", "/workspace/server.js"],
         Env: Object.entries(env_vars || {}).map(([k, v]) => `${k}=${v}`),
         HostConfig,
         Labels: {
           "egaop.agent.id": agent_id,
           "egaop.execution.id": execution_id,
           "egaop.plane": "execution"
         }
      });

      logger.info({ container_id: container.id }, "Container successfully initialized.");

      await container.start();
      logger.info({ container_id: container.id }, "Container started.");

      let ipAddress = "unknown";
      try {
        const info = await container.inspect();
        const networks = info.NetworkSettings?.Networks || {};
        const sandboxNet = networks["egaop-sandbox"];
        if (sandboxNet?.IPAddress) {
          ipAddress = sandboxNet.IPAddress;
        }
      } catch {
        // Container inspect failed — non-fatal
      }

      // Execute any init_commands inside the sandbox via Docker exec
      const initOutputs: string[] = [];
      if (init_commands && init_commands.length > 0) {
        for (const cmd of init_commands) {
          try {
            const execInstance = await container.exec({
              Cmd: ["sh", "-c", cmd],
              AttachStdout: true,
              AttachStderr: true,
            });
            const stream = await execInstance.start({ Detach: false, Tty: false });
            const output = await new Promise<string>((resolve) => {
              let data = "";
              stream.on("data", (chunk: Buffer) => { data += chunk.toString(); });
              stream.on("end", () => resolve(data));
            });
            initOutputs.push(output);
            logger.info({ command: cmd, output: output.slice(0, 200) }, "Init command executed.");
          } catch (execErr: any) {
            initOutputs.push(`ERROR: ${execErr.message}`);
            logger.error({ command: cmd, err: execErr.message }, "Init command failed.");
          }
        }
      }

      callback(null, {
         sandbox_id: container.id,
         status: "Running",
         ip_address: ipAddress,
         init_outputs: initOutputs,
      });

    } catch (err: any) {
      logger.error(err, "Failed to create agent sandbox");
      callback({
        code: grpc.status.INTERNAL,
        message: `Sandbox Creation Failed: ${err.message}`
      });
    }
  },

  TerminateSandbox: async (call: any, callback: any) => {
    const { sandbox_id, reason } = call.request;
    logger.info({ sandbox_id, reason }, "Instructed to terminate agent sandbox...");

    try {
      const container = docker.getContainer(sandbox_id);
      await container.remove({ force: true });
      logger.info({ sandbox_id }, "Sandbox terminated and resources reclaimed.");
      callback(null, { success: true });
    } catch (err: any) {
      logger.error(err, "Failed to terminate sandbox");
      callback(null, { success: false });
    }
  },

  GetSandboxStatus: async (call: any, callback: any) => {
    const { sandbox_id } = call.request;
    try {
      const container = docker.getContainer(sandbox_id);
      const info = await container.inspect();
      const state = info.State;
      callback(null, {
        status: state.Status || "unknown",
        cpu_usage: 0,
        memory_usage: 0,
        started_at: { seconds: Math.floor(new Date(state.StartedAt || Date.now()).getTime() / 1000) },
      });
    } catch (err: any) {
      if (err.statusCode === 404) {
        callback(null, { status: "NotFound", cpu_usage: 0, memory_usage: 0 });
      } else {
        callback(null, { status: "Unknown", cpu_usage: 0, memory_usage: 0 });
      }
    }
  }
});

server.addService(HEALTH_SERVICE, {
  check: async (_call: any, callback: any) => {
    try {
      await docker.ping();
      callback(null, { status: "SERVING" });
    } catch {
      callback(null, { status: "NOT_SERVING" });
    }
  }
});

if (process.env.NODE_ENV !== "test") {
  const RUNTIME_PORT = process.env.SANDBOX_RUNTIME_PORT || "50054";
  const HEALTH_PORT = parseInt(process.env.SANDBOX_RUNTIME_HEALTH_PORT || "15054", 10);

  server.bindAsync(`0.0.0.0:${RUNTIME_PORT}`, getServerCredentials(), (err, port) => {
    if (err) {
      logger.error(err, "Failed to bind Sandbox Runtime server");
      return;
    }
    logger.info(`E-GAOP Sandbox Runtime listening on port ${port}`);
  });

  const healthServer = http.createServer(async (req, res) => {
    if (req.url === "/healthz" || req.url === "/readyz") {
      try {
        await docker.ping();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "SERVING", service: "sandbox-runtime" }));
      } catch {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "NOT_SERVING", service: "sandbox-runtime" }));
      }
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  healthServer.listen(HEALTH_PORT, "0.0.0.0", () => {
    logger.info(`Health endpoint listening on port ${HEALTH_PORT}`);
  });

  const shutdown = async () => {
    logger.info("Shutting down Sandbox Runtime...");
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
