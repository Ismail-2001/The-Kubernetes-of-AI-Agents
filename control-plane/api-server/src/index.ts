import { initTracing, shutdownTracing, createNamespaceServerInterceptor, createServiceTokenServerInterceptor, createTraceServerInterceptor, validateSecrets, loadSecretsIntoEnv, SLOTracker, DEFAULT_SLO_DEFINITIONS, toProblemDetails } from "@e-gaop/shared";

initTracing("api-server");
loadSecretsIntoEnv();
if (process.env.NODE_ENV !== "test") {
  validateSecrets();
}

import crypto from "crypto";
import path from "path";
import http from "http";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import Fastify from "fastify";

// CORS, security headers, and caching handled via onRequest hook (not onSend) to avoid Fastify v5 lifecycle conflicts

import pino from "pino";
import { WebSocket } from "ws";
import { Connection, Client } from "@temporalio/client";
import { getServerCredentials, verifyJWT } from "@e-gaop/shared";
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
  ...(process.env.NODE_ENV !== "production" && process.env.NODE_ENV !== "test" ? {
    transport: { target: "pino-pretty", options: { colorize: true } }
  } : {}),
});

// ─── Temporal Client ───────────────────────────────────────────────────────
let temporalClient: Client | null = null;

async function getTemporalClient(): Promise<Client> {
  if (temporalClient) return temporalClient;
  const address = process.env.TEMPORAL_ADDRESS || "temporal:7233";
  const connection = await Connection.connect({ address });
  const namespace = process.env.TEMPORAL_NAMESPACE || "egaop";
  temporalClient = new Client({ connection, namespace });
  return temporalClient;
}

const PROTO_DIR = path.resolve(__dirname, "../../../api/proto");

const agentPackageDef = protoLoader.loadSync(
  path.join(PROTO_DIR, "egaop/v1/agent.proto"),
  { keepCase: true, longs: String, enums: String, defaults: true, oneofs: true, includeDirs: [PROTO_DIR] }
);

const namespacePackageDef = protoLoader.loadSync(
  path.join(PROTO_DIR, "egaop/v1/namespace.proto"),
  { keepCase: true, longs: String, enums: String, defaults: true, oneofs: true, includeDirs: [PROTO_DIR] }
);

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- dynamic proto loading returns untyped structure
const egaopProto = grpc.loadPackageDefinition(agentPackageDef) as any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- dynamic proto loading returns untyped structure
const nsProto = grpc.loadPackageDefinition(namespacePackageDef) as any;

const agentService = egaopProto.egaop.v1.AgentService;
const namespaceService = nsProto.egaop.v1.NamespaceService;

const server = new grpc.Server({
  interceptors: [createNamespaceServerInterceptor(), createServiceTokenServerInterceptor(), createTraceServerInterceptor()],
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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- dynamically loaded proto service
  check: (_call: any, callback: any) => {
    callback(null, { status: "SERVING" });
  }
});

// ── Suppress Fastify v5 ERR_HTTP_HEADERS_SENT crashes ────────────────────
// This error occurs when res.writeHead() is called twice in the Fastify
// lifecycle. It is harmless (the first response was already sent) but
// crashes the process. We suppress it at every possible level.
function isHeadersSentError(err: unknown): boolean {
  if (err instanceof Error) {
    if ((err as NodeJS.ErrnoException).code === "ERR_HTTP_HEADERS_SENT") return true;
    if (err.message.includes("ERR_HTTP_HEADERS_SENT")) return true;
    if (err.message.includes("headers have already been sent")) return true;
  }
  return false;
}
process.on("uncaughtException", (err) => {
  if (isHeadersSentError(err)) return;
  // eslint-disable-next-line no-console
  console.error("[FATAL] Uncaught exception:", err);
  process.exit(1);
});
process.on("unhandledRejection", (reason) => {
  if (isHeadersSentError(reason)) return;
  // eslint-disable-next-line no-console
  console.error("[ERROR] Unhandled rejection:", reason);
});

// ── REST API (BFF for frontend) ──────────────────────────────────────────────

const fastify = Fastify({
  logger: false,
  bodyLimit: 1048576, // 1MB max request body
});

// CORS origins parsed from environment (comma-separated) or default dev origins
const corsOrigins = process.env.CORS_ALLOWED_ORIGINS
  ? process.env.CORS_ALLOWED_ORIGINS.split(",").map((s) => s.trim())
  : ["http://localhost:3000", "http://localhost:5173"];

const isProduction = process.env.NODE_ENV === "production";

// CORS preflight: standalone OPTIONS route returns 204 with required headers.
// Non-preflight CORS headers are set in the onRequest hook below.
fastify.options("/*", async (_request, reply) => {
  reply.header("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
  reply.header("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Requested-With");
  reply.header("Access-Control-Max-Age", "86400");
  reply.code(204).send();
});

// Caching headers for GET responses (enables CDN/proxy caching)
const CACHE_TTL: Record<string, string> = {
  "/api/agents": "public, max-age=30, stale-while-revalidate=120",
  "/api/namespaces": "public, max-age=60, stale-while-revalidate=300",
  "/api/executions": "public, max-age=30, stale-while-revalidate=120",
  "/api/traces": "no-cache, max-age=10",
  "/api/metrics": "no-cache, max-age=15",
  "/api/slos": "no-cache, max-age=30",
  "/api/events": "no-cache, max-age=10",
  "/api/auth/me": "private, no-cache, max-age=10",
};

// ── API Versioning: /api/v1/ → /api/ rewrite ────────────────────────────────
// Fastify v5 resolves routes before onRequest hooks, so URL rewriting in
// onRequest cannot remap routes. Instead, we maintain /api/ as the canonical
// base path and document /api/v1/ as the public versioned alias. The response
// envelope carries apiVersion: "v1" for clients that need it.

// ── Global onRequest hook: CORS, security headers, request ID, and caching ──
// Uses onRequest (not onSend) to avoid Fastify v5 response lifecycle conflicts.
// Headers set here are included in ALL responses — preflight, API, error, etc.
fastify.addHook("onRequest", async (request, reply) => {
  // X-Request-ID: use client-provided ID or generate new one
  const requestId = (request.headers["x-request-id"] as string) || crypto.randomUUID();
  reply.header("X-Request-ID", requestId);

  // CORS: set Allow-Origin on every response for non-preflight requests.
  // Preflight OPTIONS handler also sets these; redundant but harmless.
  const origin = request.headers.origin;
  if (origin && corsOrigins.includes(origin)) {
    reply.header("Access-Control-Allow-Origin", origin);
    reply.header("Access-Control-Allow-Credentials", "true");
  }
  reply.header("Vary", "Origin");

  // Security headers (OWASP recommended)
  reply.header("X-Content-Type-Options", "nosniff");
  reply.header("X-Frame-Options", "DENY");
  reply.header("X-XSS-Protection", "0");
  reply.header("Referrer-Policy", "strict-origin-when-cross-origin");
  reply.header("Permissions-Policy", "geolocation=(), microphone=(), camera=()");
  if (isProduction) {
    reply.header("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }

  // Rate limit headers (in-memory counter per IP)
  const rateLimitMax = Number(process.env.RATE_LIMIT_MAX) || 100;
  const clientIp = request.ip ?? request.socket?.remoteAddress ?? "unknown";
  const now = Date.now();
  const windowMs = Number(process.env.RATE_LIMIT_WINDOW_MS) || 60_000;
  const windowStart = Math.floor(now / windowMs) * windowMs;
  const rateLimitKey = `${clientIp}:${windowStart}`;
  const currentCount = rateLimitStore.get(rateLimitKey) ?? 0;
  reply.header("X-RateLimit-Limit", String(rateLimitMax));
  reply.header("X-RateLimit-Remaining", String(Math.max(0, rateLimitMax - currentCount - 1)));
  reply.header("X-RateLimit-Reset", String(Math.ceil((windowStart + windowMs) / 1000)));

  // Cache-Control for GET responses
  if (request.method === "GET") {
    const cacheKey = Object.keys(CACHE_TTL).find((k) => request.url.startsWith(k));
    if (cacheKey) {
      reply.header("Cache-Control", CACHE_TTL[cacheKey]);
    }
  }
});

// ── In-memory rate limit counter (resets on restart) ────────────────────────
const rateLimitStore = new Map<string, number>();
const RATE_LIMIT_CLEANUP_INTERVAL = 60_000;
setInterval(() => {
  const cutoff = Date.now() - 120_000;
  for (const [key, _count] of rateLimitStore) {
    const windowStart = parseInt(key.split(":").pop() ?? "0", 10);
    if (windowStart < cutoff) rateLimitStore.delete(key);
  }
}, RATE_LIMIT_CLEANUP_INTERVAL).unref();

// Content-type enforcement for mutation requests (RFC 7807 format)
fastify.addHook("preHandler", async (request, reply) => {
  if (["POST", "PUT", "PATCH"].includes(request.method)) {
    const ct = request.headers["content-type"];
    if (!ct || !ct.includes("application/json")) {
      const traceId = reply.getHeader("X-Request-ID") as string || crypto.randomUUID();
      reply.code(415).send(toProblemDetails(
        "VALIDATION_ERROR",
        "Content-Type must be application/json",
        request.url,
        traceId,
      ));
      return;
    }
  }
});

// ── Global RFC 7807 error handler ────────────────────────────────────────────
fastify.setErrorHandler((error: Error & { statusCode?: number }, request, reply) => {
  const traceId = (reply.getHeader("X-Request-ID") as string) || crypto.randomUUID();
  const statusCode = error.statusCode ?? 500;

  // Map known error codes to RFC 7807
  let code = "INTERNAL";
  if (statusCode === 401) code = error.message.includes("Invalid credentials") ? "INVALID_CREDENTIALS" : "UNAUTHORIZED";
  else if (statusCode === 403) code = "FORBIDDEN";
  else if (statusCode === 404) code = "NOT_FOUND";
  else if (statusCode === 409) code = "CONFLICT";
  else if (statusCode === 429) code = "RATE_LIMITED";

  const problem = toProblemDetails(code, error.message, request.url, traceId);

  // Log server errors
  if (statusCode >= 500) {
    request.log.error({ err: error, traceId }, "Unhandled server error");
  }

  reply.status(statusCode).send(problem);
});

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

  // RBAC: check namespace access for resource-scoped routes
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const user = (request as any).user;
  if (user?.namespace_access && Array.isArray(user.namespace_access) && user.namespace_access.length > 0) {
    const ns = (request.query as Record<string, string>)?.namespace
      || (request.params as Record<string, string>)?.name
      || (request.params as Record<string, string>)?.namespace;
    // Only enforce if the route specifies a namespace and user has restricted access
    if (ns && !user.namespace_access.includes(ns) && !user.namespace_access.includes("*")) {
      reply.code(403).send({ error: { message: "Access denied to namespace", code: "FORBIDDEN" } });
    }
  }
});

const API_VERSION = "v1";

function apiResponse<T>(data: T) {
  return { data, meta: { apiVersion: API_VERSION, traceId: crypto.randomUUID(), timestamp: new Date().toISOString() } };
}

function paginate<T>(items: T[], page: number, limit: number, maxLimit = 100, totalOverride?: number) {
  const safePage = Math.max(1, Math.floor(page) || 1);
  const safeLimit = Math.min(Math.max(1, Math.floor(limit) || 20), maxLimit);
  const start = (safePage - 1) * safeLimit;
  const paged = items.slice(start, start + safeLimit);
  const total = totalOverride ?? items.length;
  const totalPages = Math.ceil(total / safeLimit);
  return {
    items: paged,
    total,
    page: safePage,
    limit: safeLimit,
    totalPages,
    hasNext: start + safeLimit < total,
    hasPrevious: safePage > 1,
  };
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
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- dynamically loaded proto
      { request: { namespace: q.namespace ?? "", filters, pagination: { page_size: limit } } } as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- dynamically loaded proto callback
      (_err: any, response: any) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- dynamically loaded proto response
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
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- dynamically loaded proto
      { request: { name: id, namespace } } as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- dynamically loaded proto callback
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
  const namespace = q.namespace ?? "default";

  try {
    const client = await getTemporalClient();

    // List Temporal workflows matching this agent ID
    const iterator = client.workflow.list({
      query: `WorkflowId LIKE 'agent-exec-%' AND WorkflowType = 'reactWorkflow'`,
      pageSize: limit,
    });

    const executions: Array<Record<string, unknown>> = [];

    for await (const workflow of iterator) {
      // Filter by agent ID — check if this workflow's ID contains the agent name
      if (!workflow.workflowId.includes(id)) continue;

      const startTime = workflow.startTime instanceof Date
        ? workflow.startTime.toISOString()
        : new Date().toISOString();
      const endTime = workflow.closeTime instanceof Date
        ? workflow.closeTime.toISOString()
        : undefined;
      const durationMs = workflow.closeTime instanceof Date && workflow.startTime instanceof Date
        ? workflow.closeTime.getTime() - workflow.startTime.getTime()
        : undefined;

      executions.push({
        id: workflow.workflowId,
        agentId: id,
        agentName: id,
        namespace,
        status: workflow.status.name === "Completed" ? "succeeded"
          : workflow.status.name === "Running" ? "running"
          : workflow.status.name === "Failed" ? "failed"
          : workflow.status.name === "Terminated" ? "cancelled"
          : workflow.status.name === "TimedOut" ? "timeout"
          : workflow.status.name?.toLowerCase() ?? "unknown",
        startTime,
        endTime,
        durationMs,
        costUsd: 0, // Cost tracked in observability plane
        traceId: workflow.workflowId,
        runId: (workflow as unknown as Record<string, unknown>).runtimeStatus ?? undefined,
      });
    }

    return apiResponse(paginate(executions, page, limit));
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    logger.warn({ err: errMsg, agentId: id }, "Failed to query executions from Temporal, returning empty");
    return apiResponse(paginate([], page, limit));
  }
});

// ── Run Agent (trigger workflow) ──

fastify.post("/api/agents/:id/run", async (request, reply) => {
  const { id } = request.params as { id: string };
  const body = request.body as { input?: Record<string, unknown>; namespace?: string; resourceNamespace?: string; callerRole?: string } | undefined;

  // Verify agent exists and extract configured model
  let agentFound = false;
  let agentName = id;
  let configuredModel: string | undefined;

  await new Promise<void>((resolve) => {
    agentHandlers.GetAgent(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- dynamically loaded proto
      { request: { name: id, namespace: body?.namespace ?? "default" } } as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- dynamically loaded proto callback
      (err: any, response: any) => {
        if (!err && response) {
          agentFound = true;
          agentName = response.metadata?.name ?? id;
          const spec = response.spec as Record<string, unknown> | undefined;
          if (spec && typeof spec.model === "string") {
            configuredModel = spec.model as string;
          }
        }
        resolve();
      }
    );
  });

  if (!agentFound) {
    reply.code(404);
    return { error: { message: `Agent not found: ${id}`, code: "NOT_FOUND" } };
  }

  // Start Temporal workflow
  const executionId = `exec-${crypto.randomUUID().slice(0, 8)}`;
  const workflowId = `agent-exec-${executionId}`;
  const namespace = body?.namespace ?? "default";

  try {
    const client = await getTemporalClient();
    const handle = await client.workflow.start("reactWorkflow", {
      args: [{
        agentId: agentName,
        executionId,
        namespace,
        resourceNamespace: body?.resourceNamespace ?? namespace,
        callerRole: "namespace_admin",
        model: configuredModel,
        systemPrompt: body?.input?.systemPrompt as string | undefined,
        initialMessages: body?.input?.prompt
          ? [{ role: "user" as const, content: body.input.prompt as string }]
          : (body?.input?.messages as Array<{ role: string; content: string }> | undefined),
      }],
      taskQueue: process.env.TEMPORAL_TASK_QUEUE || "egaop-agent-queue",
      workflowId,
      workflowExecutionTimeout: "30 minutes",
    });

    logger.info({ agentId: id, agentName, executionId, workflowId: handle.workflowId }, "Workflow started");

    return apiResponse({
      executionId,
      workflowId: handle.workflowId,
      runId: handle.firstExecutionRunId,
      agentId: id,
      agentName,
      status: "running",
      startTime: new Date().toISOString(),
    });
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    logger.error({ err: errMsg, agentId: id }, "Failed to start workflow");
    reply.code(500);
    return { error: { message: "Failed to start workflow", code: "INTERNAL" } };
  }
});

fastify.get("/api/executions/:id", async (request, reply) => {
  const { id } = request.params as { id: string };

  try {
    const client = await getTemporalClient();
    const handle = client.workflow.getHandle(id);
    const describe = await handle.describe();
    const raw = describe.raw as Record<string, unknown> | undefined;

    return apiResponse({
      workflowId: describe.workflowId,
      runId: raw?.runId ?? "",
      status: describe.status.name,
      startTime: describe.startTime?.toISOString() ?? "",
      executionTime: raw?.executionTime ?? "",
      taskQueue: describe.taskQueue,
    });
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    if (errMsg.includes("not found") || errMsg.includes("NotFound")) {
      reply.code(404);
      return { error: { message: `Execution not found: ${id}`, code: "NOT_FOUND" } };
    }
    reply.code(500);
    return { error: { message: "Failed to get execution", code: "INTERNAL" } };
  }
});

fastify.get("/api/executions/:id/history", async (request, reply) => {
  const { id } = request.params as { id: string };

  try {
    const client = await getTemporalClient();
    const handle = client.workflow.getHandle(id);
    const history = await handle.fetchHistory();
    const events = history.events ?? [];

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Temporal history events have dynamic event-specific attributes
    const formattedEvents = events.map((event: any) => {
      const eventId = event.eventId != null ? String(event.eventId) : "0";
      const eventTime = event.eventTime?.seconds
        ? new Date(Number(event.eventTime.seconds) * 1000).toISOString()
        : "";
      const eventType = event.eventType ?? "UNKNOWN";

      let attributes: Record<string, unknown> = {};
      if (event.workflowExecutionStartedEventAttributes) {
        attributes = { input: event.workflowExecutionStartedEventAttributes.input };
      } else if (event.workflowTaskCompletedEventAttributes) {
        attributes = { scheduledEventId: event.workflowExecutionCompletedEventAttributes?.scheduledEventId };
      } else if (event.activityTaskCompletedEventAttributes) {
        attributes = { result: event.activityTaskCompletedEventAttributes.result };
      } else if (event.activityTaskFailedEventAttributes) {
        attributes = { error: event.activityTaskFailedEventAttributes.failure?.message };
      }

      return {
        eventId,
        eventTime,
        eventType,
        attributes,
      };
    });

    return apiResponse({
      workflowId: id,
      eventCount: formattedEvents.length,
      events: formattedEvents,
    });
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    if (errMsg.includes("not found") || errMsg.includes("NotFound")) {
      reply.code(404);
      return { error: { message: `Execution not found: ${id}`, code: "NOT_FOUND" } };
    }
    reply.code(500);
    return { error: { message: "Failed to get execution history", code: "INTERNAL" } };
  }
});

fastify.post("/api/agents", async (request, reply) => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Fastify request body
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
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- dynamically loaded proto
      } as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- dynamically loaded proto callback
      (err: any, response: any) => {
        if (err) {
          reply.code(409);
          resolve({ error: { message: err.message, code: "CONFLICT" } });
          return;
        }
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
  const q = request.query as Record<string, string>;
  const namespace = q.namespace || "default";
  return new Promise((resolve) => {
    agentHandlers.DeleteAgent(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- dynamically loaded proto
      { request: { name: id, namespace } } as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- dynamically loaded proto callback
      (err: any) => {
        if (err) { reply.code(404); resolve({ error: { message: "Agent not found" } }); return; }
        resolve(apiResponse(null));
      }
    );
  });
});

fastify.put("/api/agents/:id", async (request, reply) => {
  const { id } = request.params as { id: string };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Fastify request body
  const body = request.body as any;
  return new Promise((resolve) => {
    agentHandlers.UpdateAgent(
      {
        request: {
          name: id,
          namespace: body.namespace ?? "default",
          spec: body.spec ?? {},
          labels: body.labels ?? {},
          annotations: body.annotations ?? {},
        },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- dynamically loaded proto
      } as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- dynamically loaded proto callback
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
          namespace: a.metadata?.namespace ?? body.namespace ?? "default",
          status: "updated",
          health: "Healthy",
          spec: a.spec ?? body.spec ?? {},
          updatedAt: new Date().toISOString(),
        }));
      }
    );
  });
});

// ── Agent Version History ──

fastify.get("/api/agents/:id/versions", async (request) => {
  const { id } = request.params as { id: string };
  const q = request.query as Record<string, string>;
  const namespace = q.namespace ?? "default";
  const limit = parseInt(q.limit ?? "50", 10);

  try {
    const repo = await import("./agents/repository.js").then((m) => m.getAgentRepository());
    await repo.ensureVersionTable();
    const versions = await repo.getVersionHistory(namespace, id, limit);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- repository version record shape
    return apiResponse(versions.map((v: any) => ({
      id: v.id,
      agentId: v.agent_id,
      namespace: v.namespace,
      name: v.name,
      version: v.version,
      spec: v.spec,
      labels: v.labels,
      annotations: v.annotations,
      createdBy: v.created_by,
      createdAt: v.created_at,
      changeSummary: v.change_summary,
    })));
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    logger.warn({ err: errMsg, agentId: id }, "Failed to get version history");
    return apiResponse([]);
  }
});

fastify.get("/api/agents/:id/versions/:version", async (request, reply) => {
  const { id, version } = request.params as { id: string; version: string };
  const q = request.query as Record<string, string>;
  const namespace = q.namespace ?? "default";
  const versionNum = parseInt(version, 10);

  if (isNaN(versionNum)) {
    reply.code(400);
    return { error: { message: "Version must be a number", code: "BAD_REQUEST" } };
  }

  try {
    const repo = await import("./agents/repository.js").then((m) => m.getAgentRepository());
    await repo.ensureVersionTable();
    const versionData = await repo.getVersion(namespace, id, versionNum);
    if (!versionData) {
      reply.code(404);
      return { error: { message: `Version ${versionNum} not found for agent ${id}`, code: "NOT_FOUND" } };
    }
    return apiResponse({
      id: versionData.id,
      agentId: versionData.agent_id,
      namespace: versionData.namespace,
      name: versionData.name,
      version: versionData.version,
      spec: versionData.spec,
      labels: versionData.labels,
      annotations: versionData.annotations,
      createdBy: versionData.created_by,
      createdAt: versionData.created_at,
      changeSummary: versionData.change_summary,
    });
  } catch (err: unknown) {
    reply.code(500);
    return { error: { message: "Failed to get version", code: "INTERNAL" } };
  }
});

// ── Agent Rollback ──

fastify.post("/api/agents/:id/rollback", async (request, reply) => {
  const { id } = request.params as { id: string };
  const body = request.body as { version?: number; namespace?: string } | undefined;
  const namespace = body?.namespace ?? "default";
  const targetVersion = body?.version;

  if (!targetVersion || isNaN(targetVersion)) {
    reply.code(400);
    return { error: { message: "Target version number is required", code: "BAD_REQUEST" } };
  }

  try {
    const repo = await import("./agents/repository.js").then((m) => m.getAgentRepository());
    await repo.ensureVersionTable();
    const rolledBack = await repo.rollbackToVersion(namespace, id, targetVersion);

    if (!rolledBack) {
      reply.code(404);
      return { error: { message: `Agent or version not found`, code: "NOT_FOUND" } };
    }

    logger.info({ agentId: id, namespace, targetVersion, newVersion: rolledBack.version }, "Agent rolled back");

    return apiResponse({
      id: rolledBack.id,
      name: rolledBack.name,
      namespace: rolledBack.namespace,
      version: `v${rolledBack.version}`,
      spec: rolledBack.spec,
      rolledBackToVersion: targetVersion,
    });
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    logger.error({ err: errMsg, agentId: id }, "Rollback failed");
    reply.code(500);
    return { error: { message: "Rollback failed", code: "INTERNAL" } };
  }
});

// ── Namespaces REST ──

fastify.get("/api/namespaces", async (request) => {
  const q = request.query as Record<string, string>;
  const page = parseInt(q.page ?? "1", 10);
  const limit = parseInt(q.limit ?? "50", 10);

  return new Promise((resolve) => {
    namespaceHandlers.ListNamespaces(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- dynamically loaded proto
      { request: { page_size: Math.min(Math.max(limit, 1), 100) } } as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- dynamically loaded proto callback
      (_err: any, response: any) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- dynamically loaded proto response
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
        resolve(apiResponse(paginate(ns, page, limit)));
      }
    );
  });
});

fastify.post("/api/namespaces", async (request, reply) => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Fastify request body
  const body = request.body as any;
  const name = body.name ?? body.displayName ?? "";
  if (!name) {
    reply.code(400);
    return { error: { message: "Namespace name is required", code: "BAD_REQUEST" } };
  }
  return new Promise((resolve) => {
    namespaceHandlers.CreateNamespace(
      {
        request: {
          slug: name.toLowerCase().replace(/[^a-z0-9-]/g, "-"),
          display_name: body.displayName ?? name,
          tier: body.tier ?? "sandbox",
          quotas: body.quotas ?? {},
        },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- dynamically loaded proto
      } as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- dynamically loaded proto callback
      (err: any, response: any) => {
        if (err) {
          reply.code(409);
          resolve({ error: { message: err.message, code: "CONFLICT" } });
          return;
        }
        const ns = response;
        resolve(apiResponse({
          name: ns.slug ?? name,
          displayName: ns.display_name ?? name,
          tier: (ns.tier ?? "sandbox").replace("NAMESPACE_TIER_", "").toLowerCase(),
          status: "active",
          createdAt: ns.created_at ? new Date(ns.created_at.seconds * 1000).toISOString() : new Date().toISOString(),
        }));
      }
    );
  });
});

fastify.put("/api/namespaces/:name", async (request, reply) => {
  const { name } = request.params as { name: string };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Fastify request body
  const body = request.body as any;
  return new Promise((resolve) => {
    namespaceHandlers.UpdateNamespace(
      {
        request: {
          slug: name,
          display_name: body.displayName,
          tier: body.tier,
          quotas: body.quotas ?? {},
        },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- dynamically loaded proto
      } as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- dynamically loaded proto callback
      (err: any, response: any) => {
        if (err) {
          reply.code(404);
          resolve({ error: { message: err.message, code: "NOT_FOUND" } });
          return;
        }
        const ns = response;
        resolve(apiResponse({
          name: ns.slug ?? name,
          displayName: ns.display_name ?? name,
          tier: (ns.tier ?? "sandbox").replace("NAMESPACE_TIER_", "").toLowerCase(),
          updatedAt: new Date().toISOString(),
        }));
      }
    );
  });
});

fastify.delete("/api/namespaces/:name", async (request, reply) => {
  const { name } = request.params as { name: string };
  return new Promise((resolve) => {
    namespaceHandlers.DeleteNamespace(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- dynamically loaded proto
      { request: { slug: name } } as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- dynamically loaded proto callback
      (err: any) => {
        if (err) { reply.code(404); resolve({ error: { message: "Namespace not found" } }); return; }
        resolve(apiResponse(null));
      }
    );
  });
});

// ── Traces / Executions REST ──

fastify.get("/api/traces", async (request) => {
  const q = request.query as Record<string, string>;
  const page = parseInt(q.page ?? "1", 10);
  const limit = parseInt(q.limit ?? "20", 10);

  try {
    const client = await getTemporalClient();
    const listOpts: { query?: string; pageSize?: number } = {
      query: q.namespace
        ? `WorkflowType = "reactWorkflow" AND WorkflowId LIKE "agent-exec-%"`
        : `WorkflowType = "reactWorkflow"`,
      pageSize: limit,
    };

    const iterable = client.workflow.list(listOpts);
    const executions: Array<Record<string, unknown>> = [];
    for await (const info of iterable) {
      const statusMap: Record<string, string> = {
        RUNNING: "running",
        COMPLETED: "succeeded",
        FAILED: "failed",
        CANCELLED: "cancelled",
        TERMINATED: "terminated",
        TIMED_OUT: "timeout",
      };
      const durationMs = info.closeTime && info.startTime
        ? info.closeTime.getTime() - info.startTime.getTime()
        : undefined;

      executions.push({
        id: info.workflowId,
        agentId: info.workflowId.replace("agent-exec-", ""),
        agentName: info.type,
        namespace: q.namespace ?? "default",
        status: statusMap[info.status.name] ?? "unknown",
        startTime: info.startTime.toISOString(),
        endTime: info.closeTime?.toISOString(),
        durationMs,
        costUsd: undefined,
        traceId: "",
      });
      if (executions.length >= limit) break;
    }

    return apiResponse(paginate(executions, page, limit));
  } catch {
    return apiResponse(paginate([], page, limit));
  }
});

fastify.get("/api/traces/:traceId", async (request, reply) => {
  const { traceId } = request.params as { traceId: string };

  try {
    const client = await getTemporalClient();
    const iterable = client.workflow.list({ pageSize: 100 });

    let found: import("@temporalio/client").WorkflowExecutionInfo | null = null;
    for await (const info of iterable) {
      if (info.workflowId === traceId || info.workflowId.endsWith(`-${traceId}`)) {
        found = info;
        break;
      }
    }

    if (!found) {
      reply.code(404);
      return { error: { message: `Trace not found: ${traceId}`, code: "NOT_FOUND" } };
    }

    const durationMs = found.closeTime && found.startTime
      ? found.closeTime.getTime() - found.startTime.getTime()
      : 0;

    return apiResponse({
      traceId: found.workflowId,
      agentId: found.workflowId.replace("agent-exec-", ""),
      executionId: found.workflowId,
      operationName: "agent.execute",
      startTime: found.startTime.toISOString(),
      endTime: found.closeTime?.toISOString() ?? found.startTime.toISOString(),
      durationMs,
      spanCount: 1,
      errorCount: found.status.name === "FAILED" ? 1 : 0,
      spans: [
        {
          spanId: "s-1",
          traceId: found.workflowId,
          operationName: "agent.execute",
          serviceName: "api-server",
          startTime: found.startTime.toISOString(),
          endTime: found.closeTime?.toISOString() ?? found.startTime.toISOString(),
          durationMs,
          status: found.status.name === "COMPLETED" ? "ok" : found.status.name === "FAILED" ? "error" : "running",
          attributes: { workflowId: found.workflowId, taskQueue: (found as unknown as Record<string, unknown>).taskQueue },
        },
      ],
    });
  } catch (err: unknown) {
    reply.code(500);
    return { error: { message: "Failed to get trace", code: "INTERNAL" } };
  }
});

// ── Metrics REST ──

fastify.get("/api/metrics", async () => {
  try {
    const client = await getTemporalClient();
    const iterable = client.workflow.list({ query: `WorkflowType = "reactWorkflow"` });

    const now = Date.now();
    const oneDayAgo = now - 24 * 60 * 60 * 1000;
    let running = 0;
    let failed = 0;
    let total = 0;
    let recentCount = 0;
    let totalLatencyMs = 0;
    let totalCostUsd = 0;

    for await (const info of iterable) {
      total++;
      if (info.status.name === "RUNNING") running++;
      else if (info.status.name === "FAILED") failed++;

      if (info.startTime.getTime() > oneDayAgo) {
        recentCount++;
        if (info.closeTime) {
          totalLatencyMs += info.closeTime.getTime() - info.startTime.getTime();
        }
        // Extract cost from workflow memo if available
        const raw = (info as unknown as Record<string, unknown>).raw as Record<string, unknown> | undefined;
        const memo = raw?.memo as Record<string, unknown> | undefined;
        if (memo?.totalCost) {
          const costStr = String(memo.totalCost).replace("$", "");
          const costVal = parseFloat(costStr);
          if (!isNaN(costVal)) totalCostUsd += costVal;
        }
      }
    }

    return apiResponse({
      activeAgents: running,
      executions24h: recentCount,
      avgLatencyMs: recentCount > 0 ? Math.round(totalLatencyMs / recentCount) : 0,
      errorRate: total > 0 ? Number(((failed / total) * 100).toFixed(2)) : 0,
      totalCostUsd: Number(totalCostUsd.toFixed(6)),
      activeNamespaces: 1,
    });
  } catch {
    return apiResponse({
      activeAgents: 0,
      executions24h: 0,
      avgLatencyMs: 0,
      errorRate: 0,
      totalCostUsd: 0,
      activeNamespaces: 1,
    });
  }
});

// ── SLO/SLI Tracking ──

const sloTracker = new SLOTracker();
for (const [name, def] of Object.entries(DEFAULT_SLO_DEFINITIONS)) {
  const target = def.type === "availability" ? 0.999 : def.metricName.includes("p99") ? 3000 : 1000;
  sloTracker.define(name, def.type, target);
}

fastify.get("/api/slos", async (request) => {
  const windowMinutes = Number((request.query as Record<string, string>).window) || 30;
  const snapshot = sloTracker.snapshot(windowMinutes);
  return apiResponse(snapshot);
});

// ── Audit Log REST ──

fastify.get("/api/audit-log", async (request) => {
  const q = request.query as Record<string, string>;
  const page = parseInt(q.page ?? "1", 10);
  const limit = Math.min(parseInt(q.limit ?? "50", 10), 100);
  const offset = (Math.max(1, page) - 1) * limit;

  try {
    const { getPool } = await import("@e-gaop/shared");
    const pool = await getPool();

    const where: string[] = [];
    const params: unknown[] = [];
    let paramIdx = 1;

    if (q.event_type) {
      where.push(`event_type = $${paramIdx++}`);
      params.push(q.event_type);
    }
    if (q.severity) {
      where.push(`severity = $${paramIdx++}`);
      params.push(q.severity);
    }
    if (q.actor_id) {
      where.push(`actor->>'id' ILIKE $${paramIdx++}`);
      params.push(`%${q.actor_id}%`);
    }
    if (q.search) {
      where.push(`(event_type ILIKE $${paramIdx} OR actor->>'id' ILIKE $${paramIdx} OR action->>'name' ILIKE $${paramIdx})`);
      params.push(`%${q.search}%`);
      paramIdx++;
    }

    const whereClause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";

    const countResult = await pool.query(`SELECT COUNT(*) FROM audit_entries ${whereClause}`, params);
    const total = parseInt(countResult.rows[0]?.count ?? "0", 10);

    const result = await pool.query(
      `SELECT event_id, event_type, severity, actor, target, action, context, created_at
       FROM audit_entries ${whereClause}
       ORDER BY created_at DESC
       LIMIT $${paramIdx++} OFFSET $${paramIdx++}`,
      [...params, limit, offset],
    );

    const entries = result.rows.map((row) => ({
      id: row.event_id,
      eventType: row.event_type,
      severity: row.severity,
      actor: row.actor,
      target: row.target,
      action: row.action,
      context: row.context,
      createdAt: row.created_at,
    }));

    return apiResponse(paginate(entries, page, limit, total));
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    logger.warn({ err: errMsg }, "Failed to query audit log");
    return apiResponse(paginate([], page, limit, 0));
  }
});

// ── Users REST (admin) ──

fastify.get("/api/users", async (request) => {
  const q = request.query as Record<string, string>;
  const page = parseInt(q.page ?? "1", 10);
  const limit = Math.min(parseInt(q.limit ?? "50", 10), 100);
  const offset = (Math.max(1, page) - 1) * limit;

  try {
    const { Pool } = await import("pg");
    const pool = new Pool({
      host: process.env.POSTGRES_HOST ?? "postgres",
      port: parseInt(process.env.POSTGRES_PORT ?? "5432", 10),
      database: process.env.POSTGRES_DB ?? "egaop",
      user: process.env.POSTGRES_USER ?? "egaop",
      password: process.env.POSTGRES_PASSWORD ?? "",
      max: 5,
      connectionTimeoutMillis: 5000,
    });

    const where: string[] = ["deleted_at IS NULL"];
    const params: unknown[] = [];
    let paramIdx = 1;

    if (q.role) {
      where.push(`role = $${paramIdx++}`);
      params.push(q.role);
    }
    if (q.search) {
      where.push(`(name ILIKE $${paramIdx} OR email ILIKE $${paramIdx})`);
      params.push(`%${q.search}%`);
      paramIdx++;
    }

    const whereClause = `WHERE ${where.join(" AND ")}`;

    const countResult = await pool.query(`SELECT COUNT(*) FROM users ${whereClause}`, params);
    const total = parseInt(countResult.rows[0]?.count ?? "0", 10);

    const result = await pool.query(
      `SELECT id, email, name, role, namespace_access, is_active, last_login_at, created_at
       FROM users ${whereClause}
       ORDER BY created_at DESC
       LIMIT $${paramIdx++} OFFSET $${paramIdx++}`,
      [...params, limit, offset],
    );

    await pool.end();

    const users = result.rows.map((row) => ({
      id: row.id,
      email: row.email,
      name: row.name,
      role: row.role,
      namespaceAccess: typeof row.namespace_access === "string"
        ? JSON.parse(row.namespace_access)
        : row.namespace_access,
      isActive: row.is_active,
      lastLoginAt: row.last_login_at,
      createdAt: row.created_at,
    }));

    return apiResponse(paginate(users, page, limit, total));
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    logger.warn({ err: errMsg }, "Failed to query users");
    return apiResponse(paginate([], page, limit, 0));
  }
});

// ── Namespace Health ──

fastify.get("/api/namespaces/health", async () => {
  try {
    const { getPool } = await import("@e-gaop/shared");
    const pool = await getPool();

    const nsResult = await pool.query(
      `SELECT slug, display_name, tier, quotas, suspended_at FROM namespaces WHERE deleted_at IS NULL`
    );

    const health = await Promise.all(nsResult.rows.map(async (ns) => {
      const agentCount = await pool.query(
        `SELECT COUNT(*) FROM agents WHERE namespace = $1 AND deleted_at IS NULL`,
        [ns.slug],
      );
      const quotas = typeof ns.quotas === "string" ? JSON.parse(ns.quotas) : (ns.quotas ?? {});
      const maxAgents = quotas.max_agents ?? 10;
      const currentAgents = parseInt(agentCount.rows[0]?.count ?? "0", 10);
      const pct = maxAgents > 0 ? Math.round((currentAgents / maxAgents) * 100) : 0;

      return {
        name: ns.slug,
        displayName: ns.display_name ?? ns.slug,
        tier: (ns.tier ?? "sandbox").replace("NAMESPACE_TIER_", "").toLowerCase(),
        agentCount: currentAgents,
        maxAgents,
        quotaPct: pct,
        status: ns.suspended_at ? "inactive" : "active",
        healthColor: pct > 80 ? "warn" : pct > 50 ? "accent" : "ok",
      };
    }));

    return apiResponse(health);
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    logger.warn({ err: errMsg }, "Failed to query namespace health");
    return apiResponse([]);
  }
});

// ── WebSocket Event Streaming ──

const MAX_EXECUTION_SUBSCRIBERS = 500; // max concurrent execution stream subscriptions
const executionSubscribers = new Map<string, Set<WebSocket>>();

function broadcastToExecution(executionId: string, event: string, data: Record<string, unknown>) {
  const subscribers = executionSubscribers.get(executionId);
  if (!subscribers || subscribers.size === 0) return;
  const payload = JSON.stringify({ event, data, timestamp: new Date().toISOString() });
  for (const ws of subscribers) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(payload);
    }
  }
}

// SSE endpoint REMOVED: Fastify lifecycle conflict with reply.raw.writeHead().
// Frontend uses polling via GET /api/metrics and GET /api/traces instead.

// ── WebSocket JWT validation ──────────────────────────────────────────────
function verifyWebSocketAuth(request: { headers: Record<string, string | string[] | undefined>; url?: string }): string | null {
  // Use the same JWT_SECRET that auth/routes.ts validates on startup.
  // If the env var is missing here, auth/routes.ts would have already thrown.
  const jwtSecret = process.env.JWT_SECRET;
  if (!jwtSecret || jwtSecret.length < 32) {
    logger.error("JWT_SECRET not set or too short — WebSocket auth disabled");
    return null;
  }

  // Check Authorization header
  const authHeader = request.headers.authorization;
  if (typeof authHeader === "string" && authHeader.startsWith("Bearer ")) {
    const claims = verifyJWT(authHeader.slice(7), jwtSecret);
    if (claims) return claims.sub;
  }

  // Fallback: token query parameter (ws://host:port/api/ws/...?token=xxx)
  if (request.url) {
    try {
      const url = new URL(request.url, "http://localhost");
      const token = url.searchParams.get("token");
      if (token) {
        const claims = verifyJWT(token, jwtSecret);
        if (claims) return claims.sub;
      }
    } catch { /* invalid URL — ignore */ }
  }

  return null;
}

// WebSocket endpoint for real-time execution streaming
// Connect to: ws://host:port/api/ws/executions/:executionId?token=<JWT>
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Fastify WebSocket route option and handler
fastify.get("/api/ws/executions/:executionId", { websocket: true } as any, async (socket: any, request: any) => {
  const { executionId } = request.params as { executionId: string };

  // JWT authentication for WebSocket
  const userId = verifyWebSocketAuth(request);
  if (!userId) {
    socket.send(JSON.stringify({ event: "error", data: { message: "Unauthorized: valid JWT required" }, timestamp: new Date().toISOString() }));
    socket.close();
    return;
  }

  logger.info({ executionId, userId }, "WebSocket client connected for execution streaming");

  // Enforce subscriber cap to prevent memory DoS
  const totalSubscribers = Array.from(executionSubscribers.values()).reduce((sum, s) => sum + s.size, 0);
  if (totalSubscribers >= MAX_EXECUTION_SUBSCRIBERS) {
    socket.send(JSON.stringify({ event: "error", data: { message: "Server capacity reached. Try again later." }, timestamp: new Date().toISOString() }));
    socket.close();
    return;
  }

  // Register subscriber
  if (!executionSubscribers.has(executionId)) {
    executionSubscribers.set(executionId, new Set());
  }
  executionSubscribers.get(executionId)!.add(socket);

  // Send initial status from Temporal
  try {
    const client = await getTemporalClient();
    const handle = client.workflow.getHandle(executionId);
    const describe = await handle.describe();
    socket.send(JSON.stringify({
      event: "connected",
      data: {
        executionId,
        status: describe.status.name,
        startTime: describe.startTime?.toISOString(),
      },
      timestamp: new Date().toISOString(),
    }));

    // Poll Temporal for status updates and push to subscribers
    const pollInterval = setInterval(async () => {
      try {
        const info = await handle.describe();
        const statusMap: Record<string, string> = {
          RUNNING: "running",
          COMPLETED: "succeeded",
          FAILED: "failed",
          CANCELLED: "cancelled",
          TERMINATED: "terminated",
          TIMED_OUT: "timeout",
        };
        broadcastToExecution(executionId, "status_update", {
          executionId,
          status: statusMap[info.status.name] ?? info.status.name?.toLowerCase(),
          lastEventTimestamp: new Date().toISOString(),
        });

        // If execution is terminal, send final event and clean up
        if (["COMPLETED", "FAILED", "CANCELLED", "TERMINATED", "TIMED_OUT"].includes(info.status.name)) {
          const closeTime = (info as unknown as Record<string, unknown>).closeTime as Date | undefined;
          broadcastToExecution(executionId, "execution_finished", {
            executionId,
            status: statusMap[info.status.name],
            endTime: closeTime?.toISOString(),
          });
          clearInterval(pollInterval);
        }
      } catch {
        // Execution may have been deleted
        clearInterval(pollInterval);
      }
    }, 3000);

    // Clean up on disconnect
    socket.on("close", () => {
      logger.info({ executionId }, "WebSocket client disconnected");
      executionSubscribers.get(executionId)?.delete(socket);
      if (executionSubscribers.get(executionId)?.size === 0) {
        executionSubscribers.delete(executionId);
      }
    });
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    socket.send(JSON.stringify({
      event: "error",
      data: { message: `Failed to subscribe: ${errMsg}` },
      timestamp: new Date().toISOString(),
    }));
    socket.close();
  }
});

// Global WebSocket endpoint for all events (broadcasts to all connected clients)
const globalSubscribers = new Set<WebSocket>();

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Fastify WebSocket route option and handler
fastify.get("/api/ws/events", { websocket: true } as any, async (socket: any, request: any) => {
  // JWT authentication for WebSocket
  const userId = verifyWebSocketAuth(request);
  if (!userId) {
    socket.send(JSON.stringify({ event: "error", data: { message: "Unauthorized: valid JWT required" }, timestamp: new Date().toISOString() }));
    socket.close();
    return;
  }

  logger.info({ userId }, "WebSocket client connected to global event stream");
  globalSubscribers.add(socket);

  socket.send(JSON.stringify({
    event: "connected",
    data: { message: "Connected to E-GAOP event stream" },
    timestamp: new Date().toISOString(),
  }));

  socket.on("close", () => {
    globalSubscribers.delete(socket);
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

  const healthServer = http.createServer(async (req, res) => {
    if (req.url === "/healthz" || req.url === "/readyz") {
      let temporalOk = false;
      try {
        const client = await getTemporalClient();
        await client.workflow.getHandle("health-check-test").describe();
        temporalOk = true;
      } catch (err: unknown) {
        // Workflow not found is OK (Temporal is reachable)
        const errMsg = err instanceof Error ? err.message : String(err);
        if (errMsg.includes("not found") || errMsg.includes("NotFound")) {
          temporalOk = true;
        }
      }
      const code = temporalOk ? 200 : 503;
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        status: temporalOk ? "SERVING" : "NOT_SERVING",
        service: "api-server",
        temporal: temporalOk ? "connected" : "unreachable",
        timestamp: new Date().toISOString(),
      }));
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  healthServer.listen(HEALTH_PORT, "0.0.0.0", () => {
    logger.info(`Health endpoint listening on 0.0.0.0:${HEALTH_PORT}`);
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
