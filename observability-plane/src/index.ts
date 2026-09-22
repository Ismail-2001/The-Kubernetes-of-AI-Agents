import { initTracing, shutdownTracing, createNamespaceServerInterceptor, createServiceTokenServerInterceptor, createTraceServerInterceptor, validateSecrets, loadSecretsIntoEnv, buildHealthResponse, healthToHttpStatus, checkPostgres } from "@e-gaop/shared";

initTracing("observability-plane");
loadSecretsIntoEnv();
if (process.env.NODE_ENV !== "test") {
  validateSecrets();
}

import path from "path";
import http from "http";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import pino from "pino";
import { Pool } from "pg";
import { getServerCredentials } from "@e-gaop/shared";
import { ObservabilityRepository } from "./repository";

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

// ─── PostgreSQL connection ────────────────────────────────────────────────

const pgPool = new Pool({
  host: process.env.POSTGRES_HOST || "localhost",
  port: parseInt(process.env.POSTGRES_PORT || "5432", 10),
  database: process.env.POSTGRES_DB || "egaop",
  user: process.env.POSTGRES_USER || "egaop",
  password: process.env.POSTGRES_PASSWORD || "",
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

const obsRepo = new ObservabilityRepository(pgPool);

pgPool.on("error", (err) => logger.warn({ err: err.message }, "PostgreSQL connection issue"));

// ─── Proto setup ──────────────────────────────────────────────────────────

const PROTO_PATH = path.resolve(__dirname, "../../api/proto/egaop/v1/execution.proto");

const packageDefinition = protoLoader.loadSync(PROTO_PATH, {
  keepCase: true,
  longs: String,
  enums: String,
  defaults: true,
  oneofs: true,
  includeDirs: [path.resolve(__dirname, "../../api/proto")]
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- dynamic proto loading returns untyped GrpcObject
const egaopProto = grpc.loadPackageDefinition(packageDefinition) as any;
const obsService = egaopProto.egaop.v1.ObservabilityService;

interface StoredSpan {
  span_id?: string;
  name?: string;
  start_time?: { seconds?: number } | null;
  end_time?: { seconds?: number } | null;
  attributes?: {
    fields?: Record<string, { stringValue?: string }>;
  };
}

// In-memory cache for hot traces (recent spans quick access)
const traceStore: Map<string, StoredSpan[]> = new Map();

const server = new grpc.Server({
  interceptors: [createNamespaceServerInterceptor(), createServiceTokenServerInterceptor(), createTraceServerInterceptor()],
});

server.addService(obsService.service, {
  ExportTrace: async (call: grpc.ServerUnaryCall<unknown, unknown>, callback: grpc.sendUnaryData<unknown>) => {
    const { execution_id, span_id, name, start_time, end_time, attributes } = call.request as Record<string, unknown>;

    logger.info({ execution_id, span_id, name }, "Ingesting observability span...");

    // Hot path: keep in memory for fast replay
    const existing = traceStore.get(execution_id as string) || [];
    existing.push({ span_id: span_id as string, name: name as string, start_time: start_time as StoredSpan['start_time'], end_time: end_time as StoredSpan['end_time'], attributes: attributes as StoredSpan['attributes'] });
    traceStore.set(execution_id as string, existing);

    // Durable path: persist to PostgreSQL
    try {
      const span = {
        traceId: execution_id as string,
        spanId: (span_id as string) || `span-${Date.now()}`,
        parentSpanId: null,
        serviceName: "egaop",
        operationName: (name as string) || "unknown",
        namespace: (attributes as StoredSpan['attributes'])?.fields?.['egaop.namespace']?.stringValue || "default",
        startTime: (start_time as StoredSpan['start_time'])?.seconds ? new Date((start_time as { seconds: number }).seconds * 1000) : new Date(),
        endTime: (end_time as StoredSpan['end_time'])?.seconds ? new Date((end_time as { seconds: number }).seconds * 1000) : null,
        status: (attributes as StoredSpan['attributes'])?.fields?.['egaop.status']?.stringValue || "ok",
        attributes: (attributes as StoredSpan['attributes']) || {},
        events: [],
      };
      await obsRepo.ingestSpan(span);
    } catch (pgErr: unknown) {
      logger.warn({ err: pgErr instanceof Error ? pgErr.message : String(pgErr), execution_id }, "PostgreSQL span ingestion failed");
    }

    const cost = (attributes as StoredSpan['attributes'])?.fields?.['egaop.llm.cost']?.stringValue || "$0.00";
    if (cost !== "$0.00") {
       logger.info({ execution_id, cost }, "Accumulating execution cost...");
    }

    callback(null, { success: true });
  },

  GetExecutionReplay: async (call: grpc.ServerUnaryCall<unknown, unknown>, callback: grpc.sendUnaryData<unknown>) => {
    const { execution_id } = call.request as Record<string, unknown>;

    logger.info({ execution_id }, "Constructing Execution Replay bundle...");

    // Try PostgreSQL first (durable), fall back to in-memory
    let spans: StoredSpan[] = [];

    try {
      const pgSpans = await obsRepo.getTrace(execution_id as string, "default");
      if (pgSpans.length > 0) {
        spans = pgSpans.map((s) => ({
          span_id: s.spanId,
          name: s.operationName,
          start_time: { seconds: Math.floor(s.startTime.getTime() / 1000) },
          end_time: s.endTime ? { seconds: Math.floor(s.endTime.getTime() / 1000) } : null,
          attributes: s.attributes,
        }));
      }
    } catch (pgErr: unknown) {
      logger.warn({ err: pgErr instanceof Error ? pgErr.message : String(pgErr), execution_id }, "PostgreSQL replay query failed, falling back to memory");
    }

    // Fall back to in-memory store
    if (spans.length === 0) {
      spans = traceStore.get(execution_id as string) || [];
    }

    if (spans.length === 0) {
       return callback({
          code: grpc.status.NOT_FOUND,
          message: `Execution ${execution_id} not found.`
       });
    }

    // Calculate real total cost from span attributes
    let totalCost = 0;
    let totalDurationMs = 0;
    const steps = spans.map((s, idx) => {
      const costStr = s.attributes?.fields?.['egaop.llm.cost']?.stringValue || "$0.00";
      const costVal = parseFloat(costStr.replace("$", "")) || 0;
      totalCost += costVal;

      const startSec = s.start_time?.seconds || 0;
      const endSec = s.end_time?.seconds || startSec;
      const durationMs = (endSec - startSec) * 1000;
      totalDurationMs += durationMs;

      return {
        step: idx + 1,
        type: s.name,
        name: s.name,
        input: {},
        output: s.attributes,
        cost: costStr,
        duration_ms: durationMs,
        status: "succeeded",
        policy_decision: "allow"
      };
    });

    // Query real agent info from the first span's attributes
    const agentRef = spans[0]?.attributes?.fields?.['egaop.agent_id']?.stringValue || "unknown";

    const record = {
       execution_id,
       agent_ref: agentRef,
       inputs: {},
       steps,
       outputs: { status: "fulfilled" },
       total_cost: `$${totalCost.toFixed(6)}`,
       total_duration_ms: totalDurationMs,
       policy_violations: 0
    };

    logger.info({ execution_id, total_cost: record.total_cost, steps: steps.length }, "Replay bundle constructed.");
    callback(null, record);
  }
});

server.addService(HEALTH_SERVICE, {
  check: async (_call: grpc.ServerUnaryCall<unknown, unknown>, callback: grpc.sendUnaryData<unknown>) => {
    try {
      await pgPool.query("SELECT 1");
      callback(null, { status: "SERVING" });
    } catch {
      callback(null, { status: "NOT_SERVING" });
    }
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

  const SERVICE_VERSION = process.env.SERVICE_VERSION || "0.1.0";
  const healthStartTime = new Date();

  const healthServer = http.createServer(async (req, res) => {
    if (req.url === "/healthz") {
      const response = buildHealthResponse("observability-plane", SERVICE_VERSION, healthStartTime, []);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(response));
    } else if (req.url === "/readyz") {
      const checks = await Promise.all([
        checkPostgres(() => pgPool.query("SELECT 1")),
      ]);
      const response = buildHealthResponse("observability-plane", SERVICE_VERSION, healthStartTime, checks);
      res.writeHead(healthToHttpStatus(response.status), { "Content-Type": "application/json" });
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
    logger.info("Shutting down Observability Plane...");
    server.tryShutdown(async () => {
      healthServer.close();
      await pgPool.end();
      await shutdownTracing();
      logger.info("Observability Plane shut down");
      process.exit(0);
    });
    setTimeout(() => { logger.error("Forced shutdown"); process.exit(1); }, 5000).unref();
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

export { server, traceStore, pgPool, obsRepo };
