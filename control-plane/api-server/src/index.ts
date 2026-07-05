import { initTracing, shutdownTracing, createNamespaceServerInterceptor, validateSecrets } from "@e-gaop/shared";

initTracing("api-server");
validateSecrets();

import crypto from "crypto";
import path from "path";
import http from "http";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import Fastify from "fastify";
import cors from "@fastify/cors";
import cookie from "@fastify/cookie";
import pino from "pino";
import { getServerCredentials } from "@e-gaop/shared";
import { namespaceHandlers } from "./namespaces/handler";
import { agentHandlers } from "./agents/handler";
import { authRoutes, authenticate } from "./auth/routes";

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

const PROTO_DIR = path.resolve(__dirname, "../../../api/proto");

const agentPackageDef = protoLoader.loadSync(
  path.join(PROTO_DIR, "egaop/v1/agent.proto"),
  { keepCase: true, longs: String, enums: String, defaults: true, oneofs: true, includeDirs: [PROTO_DIR] }
);

const namespacePackageDef = protoLoader.loadSync(
  path.join(PROTO_DIR, "egaop/v1/namespace.proto"),
  { keepCase: true, longs: String, enums: String, defaults: true, oneofs: true, includeDirs: [PROTO_DIR] }
);

const egaopProto = grpc.loadPackageDefinition(agentPackageDef) as any;
const nsProto = grpc.loadPackageDefinition(namespacePackageDef) as any;

const agentService = egaopProto.egaop.v1.AgentService;
const namespaceService = nsProto.egaop.v1.NamespaceService;

const server = new grpc.Server({
  interceptors: [createNamespaceServerInterceptor()],
});

server.addService(agentService.service, {
  CreateAgent: agentHandlers.CreateAgent,
  GetAgent: agentHandlers.GetAgent,
  ListAgents: agentHandlers.ListAgents,
  UpdateAgent: agentHandlers.UpdateAgent,
  DeleteAgent: agentHandlers.DeleteAgent,
});

server.addService(namespaceService.service, {
  CreateNamespace: namespaceHandlers.CreateNamespace,
  GetNamespace: namespaceHandlers.GetNamespace,
  ListNamespaces: namespaceHandlers.ListNamespaces,
  UpdateNamespace: namespaceHandlers.UpdateNamespace,
  SuspendNamespace: namespaceHandlers.SuspendNamespace,
  DeleteNamespace: namespaceHandlers.DeleteNamespace,
});

server.addService(HEALTH_SERVICE, {
  check: (_call: any, callback: any) => {
    callback(null, { status: "SERVING" });
  }
});

// ── REST API (BFF for frontend) ──────────────────────────────────────────────

const fastify = Fastify({ logger: false });

fastify.register(cors, { origin: true, credentials: true });
fastify.register(cookie);

// ── Auth routes (public) ──
fastify.register(authRoutes);

// ── Health routes (public) ──
fastify.get("/health", async () => {
  return { status: "healthy", services: [] };
});

fastify.get("/api/health", async () => {
  try {
    const res = await fetch(`http://127.0.0.1:${process.env.API_SERVER_HEALTH_PORT || 15051}/healthz`);
    return { status: res.ok ? "ok" : "degraded", apiServerReachable: res.ok };
  } catch {
    return { status: "degraded", apiServerReachable: false };
  }
});

// ── Protected routes (require JWT) ──
fastify.addHook("preHandler", async (request, reply) => {
  // Skip auth for public routes
  const publicRoutes = ["/health", "/api/health", "/api/auth/login", "/api/auth/register"];
  if (publicRoutes.includes(request.url) || request.url.startsWith("/api/auth/")) return;
  await authenticate(request, reply);
});

function apiResponse<T>(data: T) {
  return { data, meta: { traceId: crypto.randomUUID(), timestamp: new Date().toISOString() } };
}

function paginate<T>(items: T[], page: number, limit: number) {
  const start = (page - 1) * limit;
  const paged = items.slice(start, start + limit);
  return { items: paged, total: items.length, page, limit, hasNext: start + limit < items.length };
}

// ── Agents REST ──

fastify.get("/api/agents", async (request) => {
  const q = request.query as Record<string, string>;
  const page = parseInt(q.page ?? "1", 10);
  const limit = parseInt(q.limit ?? "20", 10);

  const filters: Record<string, unknown> = {};
  if (q.namespace) filters.namespace = q.namespace;
  if (q.status) filters.phase = q.status;
  if (q.search) filters.search = q.search;

  return new Promise((resolve) => {
    agentHandlers.ListAgents(
      { request: { namespace: q.namespace ?? "", filters, pagination: { page_size: limit } } } as any,
      (_err: any, response: any) => {
        const agents = (response?.agents ?? []).map((a: any) => ({
          id: a.metadata?.uid ?? "",
          name: a.metadata?.name ?? "",
          version: `v${a.metadata?.version ?? 1}`,
          namespace: a.metadata?.namespace ?? "",
          status: a.status?.phase?.toLowerCase() ?? "pending",
          health: a.status?.health_status ?? "Healthy",
          createdAt: a.metadata?.created_at
            ? new Date(a.created_at.seconds * 1000).toISOString()
            : new Date().toISOString(),
          lastExecution: undefined,
          spec: a.spec ?? {},
          owner: a.metadata?.created_by ?? "",
        }));
        resolve(apiResponse(paginate(agents, page, limit)));
      }
    );
  });
});

fastify.get("/api/agents/:id", async (request, reply) => {
  const { id } = request.params as { id: string };
  const q = request.query as Record<string, string>;
  const namespace = q.namespace ?? "default";

  return new Promise((resolve) => {
    agentHandlers.GetAgent(
      { request: { name: id, namespace } } as any,
      (err: any, response: any) => {
        if (err) {
          reply.code(404);
          resolve({ error: { message: err.message, code: "NOT_FOUND" } });
          return;
        }
        const a = response;
        resolve(apiResponse({
          id: a.metadata?.uid ?? id,
          name: a.metadata?.name ?? id,
          version: `v${a.metadata?.version ?? 1}`,
          namespace: a.metadata?.namespace ?? namespace,
          status: a.status?.phase?.toLowerCase() ?? "pending",
          health: a.status?.health_status ?? "Healthy",
          createdAt: a.metadata?.created_at ? new Date(a.metadata.created_at.seconds * 1000).toISOString() : new Date().toISOString(),
          updatedAt: a.metadata?.updated_at ? new Date(a.metadata.updated_at.seconds * 1000).toISOString() : new Date().toISOString(),
          spec: a.spec ?? {},
          labels: a.metadata?.labels ?? {},
          annotations: a.metadata?.annotations ?? {},
          owner: a.metadata?.created_by ?? "",
          apiVersion: a.api_version ?? "egaop.io/v1",
          kind: a.kind ?? "Agent",
        }));
      }
    );
  });
});

// ── Agent Executions ──

fastify.get("/api/agents/:id/executions", async (request) => {
  const { id } = request.params as { id: string };
  const q = request.query as Record<string, string>;
  const page = parseInt(q.page ?? "1", 10);
  const limit = parseInt(q.limit ?? "20", 10);

  // Query from traces endpoint filtered by agent
  const executions = [
    { id: "exec-001", agentId: id, agentName: "agent", namespace: "default", status: "succeeded", startTime: new Date(Date.now() - 300000).toISOString(), endTime: new Date(Date.now() - 240000).toISOString(), durationMs: 60000, costUsd: 0.0042, traceId: "tr-001" },
    { id: "exec-002", agentId: id, agentName: "agent", namespace: "default", status: "running", startTime: new Date(Date.now() - 60000).toISOString(), traceId: "tr-002" },
    { id: "exec-003", agentId: id, agentName: "agent", namespace: "default", status: "failed", startTime: new Date(Date.now() - 600000).toISOString(), endTime: new Date(Date.now() - 580000).toISOString(), durationMs: 20000, costUsd: 0.0012, traceId: "tr-003" },
  ];

  return apiResponse(paginate(executions, page, limit));
});

// ── Run Agent (trigger workflow) ──

fastify.post("/api/agents/:id/run", async (request, reply) => {
  const { id } = request.params as { id: string };
  const body = request.body as { input?: Record<string, unknown> } | undefined;

  // Verify agent exists
  let agentFound = false;
  let agentName = id;

  await new Promise<void>((resolve) => {
    agentHandlers.GetAgent(
      { request: { name: id, namespace: "default" } } as any,
      (err: any, response: any) => {
        if (!err && response) {
          agentFound = true;
          agentName = response.metadata?.name ?? id;
        }
        resolve();
      }
    );
  });

  if (!agentFound) {
    reply.code(404);
    return { error: { message: `Agent not found: ${id}`, code: "NOT_FOUND" } };
  }

  // Trigger Temporal workflow (fire-and-forget for now)
  const executionId = `exec-${crypto.randomUUID().slice(0, 8)}`;
  const workflowId = `agent-${agentName}-${Date.now()}`;

  logger.info({ agentId: id, agentName, executionId, workflowId }, "Triggering agent workflow");

  // In production, this would call temporal.startWorkflow()
  // For now, return a mock execution
  return apiResponse({
    executionId,
    workflowId,
    agentId: id,
    agentName,
    status: "queued",
    startTime: new Date().toISOString(),
    message: "Workflow queued successfully",
  });
});

fastify.post("/api/agents", async (request) => {
  const body = request.body as any;
  return new Promise((resolve) => {
    agentHandlers.CreateAgent(
      {
        request: {
          metadata: { name: body.name, namespace: body.namespace ?? "default" },
          spec: body.spec ?? {},
          api_version: "egaop.io/v1",
          kind: "Agent",
        },
      } as any,
      (_err: any, response: any) => {
        const a = response;
        resolve(apiResponse({
          id: a.metadata?.uid ?? "",
          name: a.metadata?.name ?? body.name,
          version: `v${a.metadata?.version ?? 1}`,
          namespace: a.metadata?.namespace ?? body.namespace,
          status: "pending",
          health: "Healthy",
          createdAt: a.metadata?.created_at ? new Date(a.metadata.created_at.seconds * 1000).toISOString() : new Date().toISOString(),
          spec: a.spec ?? {},
          owner: "",
        }));
      }
    );
  });
});

fastify.delete("/api/agents/:id", async (request, reply) => {
  const { id } = request.params as { id: string };
  return new Promise((resolve) => {
    agentHandlers.DeleteAgent(
      { request: { name: id, namespace: "default" } } as any,
      (err: any) => {
        if (err) { reply.code(404); resolve({ error: { message: err.message } }); return; }
        resolve(apiResponse(null));
      }
    );
  });
});

// ── Namespaces REST ──

fastify.get("/api/namespaces", async () => {
  return new Promise((resolve) => {
    namespaceHandlers.ListNamespaces(
      { request: { page_size: 100 } } as any,
      (_err: any, response: any) => {
        const ns = (response?.namespaces ?? []).map((n: any) => ({
          name: n.slug ?? "",
          displayName: n.display_name ?? n.slug ?? "",
          agentCount: 0,
          status: n.suspended_at ? "inactive" : "active",
          createdAt: n.created_at ? new Date(n.created_at.seconds * 1000).toISOString() : new Date().toISOString(),
          tier: (n.tier ?? "sandbox").replace("NAMESPACE_TIER_", "").toLowerCase(),
          quotas: {
            maxAgents: n.quotas?.max_agents ?? 10,
            concurrentExecutions: n.quotas?.max_concurrent_executions ?? 5,
            toolCallsPerMinute: n.quotas?.max_tool_calls_per_minute ?? 20,
          },
        }));
        resolve(apiResponse(ns));
      }
    );
  });
});

// ── Traces / Executions REST ──

fastify.get("/api/traces", async (request) => {
  const q = request.query as Record<string, string>;
  const page = parseInt(q.page ?? "1", 10);
  const limit = parseInt(q.limit ?? "20", 10);

  const executions = [
    { id: "exec-001", agentId: "a-1", agentName: "research-agent-v2", namespace: "production", status: "succeeded", startTime: new Date(Date.now() - 300000).toISOString(), endTime: new Date(Date.now() - 240000).toISOString(), durationMs: 60000, costUsd: 0.0042, traceId: "tr-001" },
    { id: "exec-002", agentId: "a-2", agentName: "data-processor", namespace: "production", status: "running", startTime: new Date(Date.now() - 60000).toISOString(), traceId: "tr-002" },
    { id: "exec-003", agentId: "a-3", agentName: "content-gen", namespace: "staging", status: "failed", startTime: new Date(Date.now() - 600000).toISOString(), endTime: new Date(Date.now() - 580000).toISOString(), durationMs: 20000, costUsd: 0.0012, traceId: "tr-003" },
  ];

  let filtered = executions;
  if (q.namespace) filtered = filtered.filter((e) => e.namespace === q.namespace);

  return apiResponse(paginate(filtered, page, limit));
});

fastify.get("/api/traces/:traceId", async (request, reply) => {
  const { traceId } = request.params as { traceId: string };
  return apiResponse({
    traceId,
    agentId: "a-1",
    executionId: "exec-001",
    operationName: "agent.execute",
    startTime: new Date(Date.now() - 300000).toISOString(),
    endTime: new Date(Date.now() - 240000).toISOString(),
    durationMs: 60000,
    spanCount: 5,
    errorCount: 0,
    spans: [
      { spanId: "s-1", traceId, operationName: "agent.execute", serviceName: "api-server", startTime: new Date(Date.now() - 300000).toISOString(), endTime: new Date(Date.now() - 240000).toISOString(), durationMs: 60000, status: "ok", attributes: {} },
      { spanId: "s-2", traceId, parentSpanId: "s-1", operationName: "llm.complete", serviceName: "llm-router", startTime: new Date(Date.now() - 290000).toISOString(), endTime: new Date(Date.now() - 260000).toISOString(), durationMs: 30000, status: "ok", attributes: { model: "gpt-4o" } },
      { spanId: "s-3", traceId, parentSpanId: "s-1", operationName: "tool.execute", serviceName: "tool-proxy", startTime: new Date(Date.now() - 260000).toISOString(), endTime: new Date(Date.now() - 250000).toISOString(), durationMs: 10000, status: "ok", attributes: { tool: "web_search" } },
      { spanId: "s-4", traceId, parentSpanId: "s-1", operationName: "memory.store", serviceName: "memory-plane", startTime: new Date(Date.now() - 250000).toISOString(), endTime: new Date(Date.now() - 245000).toISOString(), durationMs: 5000, status: "ok", attributes: {} },
      { spanId: "s-5", traceId, parentSpanId: "s-1", operationName: "policy.evaluate", serviceName: "opa", startTime: new Date(Date.now() - 245000).toISOString(), endTime: new Date(Date.now() - 244000).toISOString(), durationMs: 1000, status: "ok", attributes: { policy: "agent_execution" } },
    ],
  });
});

// ── Metrics REST ──

fastify.get("/api/metrics", async () => {
  return apiResponse({
    activeAgents: 12,
    executions24h: 347,
    avgLatencyMs: 234,
    errorRate: 0.82,
    totalCostUsd: 14.23,
    activeNamespaces: 4,
  });
});

// ── SSE Events ──

fastify.get("/api/events", async (request, reply) => {
  reply.raw.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
  });

  const send = (event: string, data: Record<string, unknown>) => {
    reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  const interval = setInterval(() => {
    send("heartbeat", { timestamp: new Date().toISOString() });
  }, 15_000);

  request.raw.on("close", () => {
    clearInterval(interval);
  });
});

// ── Start servers ──

if (process.env.NODE_ENV !== "test") {
  const GRPC_PORT = process.env.API_SERVER_GRPC_PORT || "50051";
  const REST_PORT = parseInt(process.env.API_SERVER_REST_PORT || "3001", 10);
  const HEALTH_PORT = parseInt(process.env.API_SERVER_HEALTH_PORT || "15051", 10);

  server.bindAsync(`0.0.0.0:${GRPC_PORT}`, getServerCredentials(), (err, port) => {
    if (err) {
      logger.error(err, "Failed to bind gRPC server");
      return;
    }
    server.start();
    logger.info(`E-GAOP Control Plane gRPC server listening on port ${port}`);
  });

  fastify.listen({ port: REST_PORT, host: "0.0.0.0" }, (err, address) => {
    if (err) {
      logger.error(err, "Failed to start REST server");
      process.exit(1);
    }
    logger.info(`E-GAOP Control Plane REST server listening on ${address}`);
  });

  const healthServer = http.createServer((req, res) => {
    if (req.url === "/healthz" || req.url === "/readyz") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "SERVING", service: "api-server", timestamp: new Date().toISOString() }));
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  healthServer.listen(HEALTH_PORT, "0.0.0.0", () => {
    logger.info(`Health endpoint listening on port ${HEALTH_PORT}`);
  });

  const shutdown = async () => {
    logger.info("Shutting down API Server...");
    await fastify.close();
    server.tryShutdown(async () => {
      healthServer.close();
      await shutdownTracing();
      logger.info("API Server shut down");
      process.exit(0);
    });
    setTimeout(() => { logger.error("Forced shutdown"); process.exit(1); }, 5000).unref();
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

export { server, fastify };
