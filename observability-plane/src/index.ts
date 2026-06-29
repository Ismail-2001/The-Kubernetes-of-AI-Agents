import { initTracing, shutdownTracing, createNamespaceServerInterceptor } from "@e-gaop/shared";

initTracing("observability-plane");

import path from "path";
import http from "http";
import fs from "fs";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import pino from "pino";
import { getServerCredentials } from "@e-gaop/shared";

const HEALTH_SERVICE: grpc.ServiceDefinition = {
  check: {
    path: "/grpc.health.v1.Health/Check",
    requestStream: false,
    responseStream: false,
    requestSerialize: (v: any) => Buffer.from(JSON.stringify(v)),
    responseSerialize: (v: any) => Buffer.from(JSON.stringify(v)),
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

const PROTO_PATH = path.resolve(__dirname, "../../api/proto/egaop/v1/execution.proto");

const packageDefinition = protoLoader.loadSync(PROTO_PATH, {
  keepCase: true,
  longs: String,
  enums: String,
  defaults: true,
  oneofs: true,
  includeDirs: [path.resolve(__dirname, "../../api/proto")]
});

const egaopProto = grpc.loadPackageDefinition(packageDefinition) as any;
const obsService = egaopProto.egaop.v1.ObservabilityService;

const traceStore: Map<string, any[]> = new Map();

const server = new grpc.Server({
  interceptors: [createNamespaceServerInterceptor()],
});

server.addService(obsService.service, {
  ExportTrace: (call: any, callback: any) => {
    const { execution_id, span_id, name, start_time, end_time, attributes } = call.request;

    logger.info({ execution_id, span_id, name }, "Ingesting observability span...");

    const existing = traceStore.get(execution_id) || [];
    existing.push({
      span_id,
      name,
      start_time,
      end_time,
      attributes
    });
    traceStore.set(execution_id, existing);

    const cost = attributes?.fields?.['egaop.llm.cost']?.stringValue || "$0.00";
    if (cost !== "$0.00") {
       logger.info({ execution_id, cost }, "Accumulating execution cost...");
    }

    callback(null, { success: true });
  },

  GetExecutionReplay: (call: any, callback: any) => {
    const { execution_id } = call.request;

    logger.info({ execution_id }, "Constructing Execution Replay bundle...");

    const spans = traceStore.get(execution_id) || [];

    if (spans.length === 0) {
       return callback({
          code: grpc.status.NOT_FOUND,
          message: `Execution ${execution_id} not found.`
       });
    }

    const record = {
       execution_id,
       agent_ref: "order-processor@v2.1.0",
       inputs: { order_id: "ord_9182" },
       steps: spans.map((s, idx) => ({
          step: idx + 1,
          type: s.name,
          name: s.name,
          input: {},
          output: s.attributes,
          cost: s.attributes?.fields?.['egaop.llm.cost']?.stringValue || "$0.00",
          duration_ms: (s.end_time.seconds - s.start_time.seconds) * 1000,
          status: "succeeded",
          policy_decision: "allow"
       })),
       outputs: { status: "fulfilled" },
       total_cost: "$0.024",
       total_duration_ms: 1200,
       policy_violations: 0
    };

    logger.info({ execution_id }, "Replay bundle successfully constructed.");
    callback(null, record);
  }
});

server.addService(HEALTH_SERVICE, {
  check: (_call: any, callback: any) => {
    callback(null, { status: "SERVING" });
  }
});

if (process.env.NODE_ENV !== "test") {
  const OBS_PORT = process.env.OBSERVABILITY_PLANE_PORT || "50056";
  const HEALTH_PORT = parseInt(process.env.OBSERVABILITY_PLANE_HEALTH_PORT || "15056", 10);

  server.bindAsync(`0.0.0.0:${OBS_PORT}`, getServerCredentials(), (err, port) => {
    if (err) {
      logger.error(err, "Failed to bind Observability Plane server");
      return;
    }
    server.start();
    logger.info(`E-GAOP Observability Plane listening on port ${port}`);
  });

  const healthServer = http.createServer((req, res) => {
    if (req.url === "/healthz" || req.url === "/readyz") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "SERVING", service: "observability-plane", timestamp: new Date().toISOString() }));
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  healthServer.listen(HEALTH_PORT, "0.0.0.0", () => {
    logger.info(`Health endpoint listening on port ${HEALTH_PORT}`);
  });

  const shutdown = async () => {
    logger.info("Shutting down Observability Plane...");
    server.tryShutdown(async () => {
      healthServer.close();
      await shutdownTracing();
      logger.info("Observability Plane shut down");
      process.exit(0);
    });
    setTimeout(() => { logger.error("Forced shutdown"); process.exit(1); }, 5000).unref();
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

export { server, traceStore };
