import { initTracing, shutdownTracing, createNamespaceServerInterceptor, createServiceTokenServerInterceptor, createTraceServerInterceptor, validateSecrets, loadSecretsIntoEnv, SLOTracker, DEFAULT_SLO_DEFINITIONS, toProblemDetails } from "@e-gaop/shared";

process.on("uncaughtException", (err: Error & { code?: string }) => {
  if (err.code === "ERR_STREAM_WRITE_AFTER_END" || err.message?.includes("write after end")) {
    process.stderr.write(JSON.stringify({
      timestamp: new Date().toISOString(),
      level: "warn",
      message: `Suppressed ${err.code}: ${err.message}`,
    }) + "\n");
    return;
  }
  process.stderr.write(JSON.stringify({
    timestamp: new Date().toISOString(),
    level: "error",
    message: `Uncaught exception: ${err.message}`,
    stack: err.stack,
  }) + "\n");
});

initTracing("api-server");
loadSecretsIntoEnv();
if (process.env.NODE_ENV !== "test") {
  validateSecrets();
}

// Ensure notification/policy tables exist
if (process.env.NODE_ENV !== "test") {
  import("./ensure-tables.js").then(m => m.ensureTables()).catch(err => {
    console.error("[WARN] Failed to ensure tables:", err.message);
  });
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
  : process.env.NODE_ENV === "production"
    ? []
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
  reply.header("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
  reply.header("X-Permitted-Cross-Domain-Policies", "none");
  if (isProduction) {
    reply.header("Strict-Transport-Security", "max-age=31536000; includeSubDomains; preload");
  }

  // Rate limit headers (in-memory counter per IP)
  const rateLimitMax = Number(process.env.RATE_LIMIT_MAX) || 100;
  const clientIp = request.ip ?? request.socket?.remoteAddress ?? "unknown";
  const now = Date.now();
  const windowMs = Number(process.env.RATE_LIMIT_WINDOW_MS) || 60_000;
  const windowStart = Math.floor(now / windowMs) * windowMs;
  const rateLimitKey = `${clientIp}:${windowStart}`;
  const currentCount = (rateLimitStore.get(rateLimitKey) ?? 0) + 1;
  rateLimitStore.set(rateLimitKey, currentCount);
  reply.header("X-RateLimit-Limit", String(rateLimitMax));
  reply.header("X-RateLimit-Remaining", String(Math.max(0, rateLimitMax - currentCount)));
  reply.header("X-RateLimit-Reset", String(Math.ceil((windowStart + windowMs) / 1000)));

  if (currentCount > rateLimitMax) {
    reply.code(429).send(toProblemDetails(
      "RATE_LIMITED",
      `Rate limit exceeded. Max ${rateLimitMax} requests per ${windowMs / 1000}s.`,
      request.url,
      reply.getHeader("X-Request-ID") as string || crypto.randomUUID(),
    ));
    return;
  }

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
  else if (statusCode === 400) code = "VALIDATION_ERROR";

  // Extract validation details from Fastify/Zod errors when available
  const extra: Record<string, unknown> = {};
  if (code === "VALIDATION_ERROR") {
    // Fastify validation errors have validation property
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const validationErrors = (error as any).validation;
    if (Array.isArray(validationErrors) && validationErrors.length > 0) {
      extra.errors = validationErrors.map((v: Record<string, unknown>) => ({
        field: (v.instancePath as string) ?? "unknown",
        message: (v.message as string) ?? "Invalid value",
        received: v.data ?? undefined,
        expected: (v.params as Record<string, unknown>)?.type ?? (v.params as Record<string, unknown>)?.pattern ?? undefined,
      }));
    }
    // Zod errors have issues property
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const zodIssues = (error as any).issues;
    if (Array.isArray(zodIssues) && zodIssues.length > 0) {
      extra.errors = zodIssues.map((issue: Record<string, unknown>) => ({
        field: Array.isArray(issue.path) ? issue.path.join(".") : "unknown",
        message: (issue.message as string) ?? "Invalid value",
        code: issue.code ?? undefined,
      }));
    }
  }

  const problem = toProblemDetails(code, error.message, request.url, traceId, extra);

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
  return {
    status: "healthy",
    version: process.env.npm_package_version ?? "1.0.0",
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    services: [],
  };
});

fastify.get("/api/health", async () => {
  const dependencies: Record<string, { status: string; latencyMs?: number }> = {};

  // Check Postgres
  try {
    const { getPool } = await import("@e-gaop/shared");
    const pool = await getPool();
    const pgStart = Date.now();
    await pool.query("SELECT 1");
    dependencies.postgres = { status: "ok", latencyMs: Date.now() - pgStart };
  } catch {
    dependencies.postgres = { status: "unavailable" };
  }

  // Check Redis
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const RedisModule = await import("ioredis") as any;
    const Redis = RedisModule.default ?? RedisModule;
    const redis = new Redis({
      host: process.env.REDIS_HOST || "redis",
      port: parseInt(process.env.REDIS_PORT || "6379", 10),
      password: process.env.REDIS_PASSWORD || undefined,
      connectTimeout: 3000,
      maxRetriesPerRequest: 0,
      lazyConnect: true,
    });
    const redisStart = Date.now();
    await Promise.race([
      redis.connect().then(() => redis.ping()),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), 3000)),
    ]);
    dependencies.redis = { status: "ok", latencyMs: Date.now() - redisStart };
    redis.disconnect();
  } catch {
    dependencies.redis = { status: "unavailable" };
  }

  // Check Temporal
  try {
    const temporalStart = Date.now();
    const client = await getTemporalClient();
    await client.workflow.getHandle("health-check-probe").describe().catch(() => {});
    dependencies.temporal = { status: "ok", latencyMs: Date.now() - temporalStart };
  } catch {
    dependencies.temporal = { status: "unavailable" };
  }

  const allHealthy = Object.values(dependencies).every(d => d.status === "ok");

  return {
    status: allHealthy ? "ok" : "degraded",
    version: process.env.npm_package_version ?? "1.0.0",
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    dependencies,
  };
});

// ── OpenAPI spec endpoint (public) ──
fastify.get("/api/openapi.json", async (_request, reply) => {
  reply.header("Content-Type", "application/json");
  reply.header("Cache-Control", "public, max-age=3600");
  const fs = await import("fs");
  const path = await import("path");
  const specPath = path.resolve(__dirname, "../../../api/openapi.yaml");
  try {
    const yaml = await import("yaml");
    const content = fs.readFileSync(specPath, "utf-8");
    return yaml.parse(content);
  } catch {
    // Fallback: read raw YAML
    const content = fs.readFileSync(specPath, "utf-8");
    return { openapi: "3.0.3", info: { title: "E-GAOP API", version: "1.0.0" }, raw: content };
  }
});

// ── Response compression (onSend hook) ──
fastify.addHook("onSend", async (_request, reply, payload) => {
  const acceptEncoding = _request.headers["accept-encoding"];
  if (!acceptEncoding || !acceptEncoding.includes("gzip")) return payload;

  const contentType = String(reply.getHeader("content-type") || "");
  if (typeof payload === "string" && payload.length > 1024 && (contentType.includes("json") || contentType.includes("text"))) {
    const { gzip } = await import("zlib");
    const compressed = await new Promise<Buffer>((resolve, reject) => {
      gzip(Buffer.from(payload), (err, result) => err ? reject(err) : resolve(result));
    });
    reply.header("Content-Encoding", "gzip");
    reply.header("Content-Length", compressed.length);
    return compressed;
  }
  return payload;
});

// ── ETag support for GET responses ──
fastify.addHook("onSend", async (request, reply, payload) => {
  if (request.method !== "GET") return payload;
  const contentType = String(reply.getHeader("content-type") || "");
  if (!contentType.includes("json")) return payload;

  const { createHash } = await import("crypto");
  const etag = `"${createHash("sha256").update(typeof payload === "string" ? payload : JSON.stringify(payload)).digest("hex").slice(0, 16)}"`;
  reply.header("ETag", etag);

  const ifNoneMatch = request.headers["if-none-match"];
  if (ifNoneMatch === etag) {
    reply.code(304).send("");
    return "";
  }
  return payload;
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

// ── Notification Channels CRUD ──

fastify.get("/api/notification-channels", async (request) => {
  const q = request.query as Record<string, string>;
  const page = parseInt(q.page ?? "1", 10);
  const limit = Math.min(parseInt(q.limit ?? "50", 10), 100);
  const offset = (Math.max(1, page) - 1) * limit;

  try {
    const { getPool } = await import("@e-gaop/shared");
    const pool = await getPool();
    const countResult = await pool.query(`SELECT COUNT(*) FROM notification_channels`);
    const total = parseInt(countResult.rows[0]?.count ?? "0", 10);
    const result = await pool.query(
      `SELECT id, name, type, config, active, created_at, updated_at FROM notification_channels ORDER BY created_at DESC LIMIT $1 OFFSET $2`,
      [limit, offset],
    );
    return apiResponse(paginate(result.rows.map(r => ({
      id: r.id, name: r.name, type: r.type, config: r.config,
      active: r.active, createdAt: r.created_at, updatedAt: r.updated_at,
    })), page, limit, total));
  } catch (err: unknown) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, "Failed to list notification channels");
    return apiResponse(paginate([], page, limit, 0));
  }
});

fastify.post("/api/notification-channels", async (request, reply) => {
  const body = request.body as { name?: string; type?: string; config?: Record<string, unknown> };
  if (!body?.name || !body?.type) {
    reply.code(400);
    return toProblemDetails("VALIDATION_ERROR", "name and type are required", "/api/notification-channels", crypto.randomUUID());
  }
  try {
    const { getPool } = await import("@e-gaop/shared");
    const pool = await getPool();
    const id = crypto.randomUUID();
    await pool.query(
      `INSERT INTO notification_channels (id, name, type, config) VALUES ($1, $2, $3, $4)`,
      [id, body.name, body.type, JSON.stringify(body.config ?? {})],
    );
    reply.code(201);
    return apiResponse({ id, name: body.name, type: body.type, config: body.config ?? {}, active: true, createdAt: new Date().toISOString() });
  } catch (err: unknown) {
    reply.code(500);
    return toProblemDetails("INTERNAL", "Failed to create channel", "/api/notification-channels", crypto.randomUUID());
  }
});

fastify.put("/api/notification-channels/:id", async (request, reply) => {
  const { id } = request.params as { id: string };
  const body = request.body as { name?: string; type?: string; config?: Record<string, unknown>; active?: boolean };
  try {
    const { getPool } = await import("@e-gaop/shared");
    const pool = await getPool();
    const result = await pool.query(
      `UPDATE notification_channels SET name = COALESCE($1, name), type = COALESCE($2, type), config = COALESCE($3, config), active = COALESCE($4, active), updated_at = NOW() WHERE id = $5 RETURNING id, name, type, config, active, created_at, updated_at`,
      [body?.name ?? null, body?.type ?? null, body?.config ? JSON.stringify(body.config) : null, body?.active ?? null, id],
    );
    if (result.rows.length === 0) { reply.code(404); return toProblemDetails("NOT_FOUND", "Channel not found", `/api/notification-channels/${id}`, crypto.randomUUID()); }
    const r = result.rows[0];
    return apiResponse({ id: r.id, name: r.name, type: r.type, config: r.config, active: r.active, createdAt: r.created_at, updatedAt: r.updated_at });
  } catch (err: unknown) {
    reply.code(500);
    return toProblemDetails("INTERNAL", "Failed to update channel", `/api/notification-channels/${id}`, crypto.randomUUID());
  }
});

fastify.delete("/api/notification-channels/:id", async (request, reply) => {
  const { id } = request.params as { id: string };
  try {
    const { getPool } = await import("@e-gaop/shared");
    const pool = await getPool();
    const result = await pool.query(`DELETE FROM notification_channels WHERE id = $1`, [id]);
    if (result.rowCount === 0) { reply.code(404); return toProblemDetails("NOT_FOUND", "Channel not found", `/api/notification-channels/${id}`, crypto.randomUUID()); }
    return apiResponse(null);
  } catch (err: unknown) {
    reply.code(500);
    return toProblemDetails("INTERNAL", "Failed to delete channel", `/api/notification-channels/${id}`, crypto.randomUUID());
  }
});

// ── Notification Rules CRUD ──

fastify.get("/api/notification-rules", async (request) => {
  const q = request.query as Record<string, string>;
  const page = parseInt(q.page ?? "1", 10);
  const limit = Math.min(parseInt(q.limit ?? "50", 10), 100);
  const offset = (Math.max(1, page) - 1) * limit;

  try {
    const { getPool } = await import("@e-gaop/shared");
    const pool = await getPool();
    const countResult = await pool.query(`SELECT COUNT(*) FROM notification_rules`);
    const total = parseInt(countResult.rows[0]?.count ?? "0", 10);
    const result = await pool.query(
      `SELECT r.id, r.name, r.description, r.condition, r.channel_id, r.enabled, r.created_at, r.updated_at, c.name as channel_name, c.type as channel_type
       FROM notification_rules r LEFT JOIN notification_channels c ON r.channel_id = c.id
       ORDER BY r.created_at DESC LIMIT $1 OFFSET $2`,
      [limit, offset],
    );
    return apiResponse(paginate(result.rows.map(r => ({
      id: r.id, name: r.name, description: r.description, condition: r.condition,
      channelId: r.channel_id, channelName: r.channel_name, channelType: r.channel_type,
      enabled: r.enabled, createdAt: r.created_at, updatedAt: r.updated_at,
    })), page, limit, total));
  } catch (err: unknown) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, "Failed to list notification rules");
    return apiResponse(paginate([], page, limit, 0));
  }
});

fastify.post("/api/notification-rules", async (request, reply) => {
  const body = request.body as { name?: string; description?: string; condition?: Record<string, unknown>; channelId?: string };
  if (!body?.name || !body?.channelId) {
    reply.code(400);
    return toProblemDetails("VALIDATION_ERROR", "name and channelId are required", "/api/notification-rules", crypto.randomUUID());
  }
  try {
    const { getPool } = await import("@e-gaop/shared");
    const pool = await getPool();
    const id = crypto.randomUUID();
    await pool.query(
      `INSERT INTO notification_rules (id, name, description, condition, channel_id) VALUES ($1, $2, $3, $4, $5)`,
      [id, body.name, body.description ?? "", JSON.stringify(body.condition ?? {}), body.channelId],
    );
    reply.code(201);
    return apiResponse({ id, name: body.name, description: body.description ?? "", condition: body.condition ?? {}, channelId: body.channelId, enabled: true, createdAt: new Date().toISOString() });
  } catch (err: unknown) {
    reply.code(500);
    return toProblemDetails("INTERNAL", "Failed to create rule", "/api/notification-rules", crypto.randomUUID());
  }
});

fastify.put("/api/notification-rules/:id", async (request, reply) => {
  const { id } = request.params as { id: string };
  const body = request.body as { name?: string; description?: string; condition?: Record<string, unknown>; channelId?: string; enabled?: boolean };
  try {
    const { getPool } = await import("@e-gaop/shared");
    const pool = await getPool();
    const result = await pool.query(
      `UPDATE notification_rules SET name = COALESCE($1, name), description = COALESCE($2, description), condition = COALESCE($3, condition), channel_id = COALESCE($4, channel_id), enabled = COALESCE($5, enabled), updated_at = NOW() WHERE id = $6 RETURNING *`,
      [body?.name ?? null, body?.description ?? null, body?.condition ? JSON.stringify(body.condition) : null, body?.channelId ?? null, body?.enabled ?? null, id],
    );
    if (result.rows.length === 0) { reply.code(404); return toProblemDetails("NOT_FOUND", "Rule not found", `/api/notification-rules/${id}`, crypto.randomUUID()); }
    return apiResponse(result.rows[0]);
  } catch (err: unknown) {
    reply.code(500);
    return toProblemDetails("INTERNAL", "Failed to update rule", `/api/notification-rules/${id}`, crypto.randomUUID());
  }
});

fastify.delete("/api/notification-rules/:id", async (request, reply) => {
  const { id } = request.params as { id: string };
  try {
    const { getPool } = await import("@e-gaop/shared");
    const pool = await getPool();
    const result = await pool.query(`DELETE FROM notification_rules WHERE id = $1`, [id]);
    if (result.rowCount === 0) { reply.code(404); return toProblemDetails("NOT_FOUND", "Rule not found", `/api/notification-rules/${id}`, crypto.randomUUID()); }
    return apiResponse(null);
  } catch (err: unknown) {
    reply.code(500);
    return toProblemDetails("INTERNAL", "Failed to delete rule", `/api/notification-rules/${id}`, crypto.randomUUID());
  }
});

// ── Policies CRUD ──

fastify.get("/api/policies", async (request) => {
  const q = request.query as Record<string, string>;
  const page = parseInt(q.page ?? "1", 10);
  const limit = Math.min(parseInt(q.limit ?? "50", 10), 100);
  const offset = (Math.max(1, page) - 1) * limit;

  try {
    const { getPool } = await import("@e-gaop/shared");
    const pool = await getPool();
    const where: string[] = [];
    const params: unknown[] = [];
    let idx = 1;
    if (q.status) { where.push(`status = $${idx++}`); params.push(q.status); }
    if (q.type) { where.push(`type = $${idx++}`); params.push(q.type); }
    if (q.search) { where.push(`(name ILIKE $${idx} OR description ILIKE $${idx})`); params.push(`%${q.search}%`); idx++; }
    const whereClause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";

    const countResult = await pool.query(`SELECT COUNT(*) FROM policies ${whereClause}`, params);
    const total = parseInt(countResult.rows[0]?.count ?? "0", 10);
    const result = await pool.query(
      `SELECT id, name, description, type, config, status, version, created_by, created_at, updated_at FROM policies ${whereClause} ORDER BY updated_at DESC LIMIT $${idx++} OFFSET $${idx++}`,
      [...params, limit, offset],
    );
    return apiResponse(paginate(result.rows.map(r => ({
      id: r.id, name: r.name, description: r.description, type: r.type,
      config: r.config, status: r.status, version: r.version, createdBy: r.created_by,
      createdAt: r.created_at, updatedAt: r.updated_at,
    })), page, limit, total));
  } catch (err: unknown) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, "Failed to list policies");
    return apiResponse(paginate([], page, limit, 0));
  }
});

fastify.post("/api/policies", async (request, reply) => {
  const body = request.body as { name?: string; description?: string; type?: string; config?: Record<string, unknown> };
  if (!body?.name || !body?.type) {
    reply.code(400);
    return toProblemDetails("VALIDATION_ERROR", "name and type are required", "/api/policies", crypto.randomUUID());
  }
  try {
    const { getPool } = await import("@e-gaop/shared");
    const pool = await getPool();
    const id = crypto.randomUUID();
    await pool.query(
      `INSERT INTO policies (id, name, description, type, config, created_by) VALUES ($1, $2, $3, $4, $5, $6)`,
      [id, body.name, body.description ?? "", body.type, JSON.stringify(body.config ?? {}), (request as any).user?.id ?? "system"],
    );
    reply.code(201);
    return apiResponse({ id, name: body.name, description: body.description ?? "", type: body.type, config: body.config ?? {}, status: "draft", version: 1, createdAt: new Date().toISOString() });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("unique") || msg.includes("duplicate")) {
      reply.code(409);
      return toProblemDetails("CONFLICT", "Policy with this name already exists", "/api/policies", crypto.randomUUID());
    }
    reply.code(500);
    return toProblemDetails("INTERNAL", "Failed to create policy", "/api/policies", crypto.randomUUID());
  }
});

fastify.put("/api/policies/:id", async (request, reply) => {
  const { id } = request.params as { id: string };
  const body = request.body as { name?: string; description?: string; type?: string; config?: Record<string, unknown>; status?: string };
  try {
    const { getPool } = await import("@e-gaop/shared");
    const pool = await getPool();
    const result = await pool.query(
      `UPDATE policies SET name = COALESCE($1, name), description = COALESCE($2, description), type = COALESCE($3, type), config = COALESCE($4, config), status = COALESCE($5, status), version = version + 1, updated_at = NOW() WHERE id = $6 RETURNING id, name, description, type, config, status, version, created_by, created_at, updated_at`,
      [body?.name ?? null, body?.description ?? null, body?.type ?? null, body?.config ? JSON.stringify(body.config) : null, body?.status ?? null, id],
    );
    if (result.rows.length === 0) { reply.code(404); return toProblemDetails("NOT_FOUND", "Policy not found", `/api/policies/${id}`, crypto.randomUUID()); }
    const r = result.rows[0];
    return apiResponse({ id: r.id, name: r.name, description: r.description, type: r.type, config: r.config, status: r.status, version: r.version, createdBy: r.created_by, createdAt: r.created_at, updatedAt: r.updated_at });
  } catch (err: unknown) {
    reply.code(500);
    return toProblemDetails("INTERNAL", "Failed to update policy", `/api/policies/${id}`, crypto.randomUUID());
  }
});

fastify.delete("/api/policies/:id", async (request, reply) => {
  const { id } = request.params as { id: string };
  try {
    const { getPool } = await import("@e-gaop/shared");
    const pool = await getPool();
    const result = await pool.query(`DELETE FROM policies WHERE id = $1`, [id]);
    if (result.rowCount === 0) { reply.code(404); return toProblemDetails("NOT_FOUND", "Policy not found", `/api/policies/${id}`, crypto.randomUUID()); }
    return apiResponse(null);
  } catch (err: unknown) {
    reply.code(500);
    return toProblemDetails("INTERNAL", "Failed to delete policy", `/api/policies/${id}`, crypto.randomUUID());
  }
});

// ── Time-series: executions per hour for last 24h (Dashboard chart) ──

fastify.get("/api/metrics/timeseries", async () => {
  try {
    const client = await getTemporalClient();
    const now = Date.now();
    const hours: Array<{ hour: string; count: number }> = [];

    for (let i = 23; i >= 0; i--) {
      const hourStart = new Date(now - (i + 1) * 3600000);
      const hourEnd = new Date(now - i * 3600000);
      const label = hourStart.toISOString().slice(11, 13) + ":00";

      let count = 0;
      try {
        const iterable = client.workflow.list({
          query: `WorkflowType = "reactWorkflow" AND StartTime >= ${Math.floor(hourStart.getTime() / 1000)} AND StartTime < ${Math.floor(hourEnd.getTime() / 1000)}`,
          pageSize: 1,
        });
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        for await (const _ of iterable) { count++; }
      } catch { /* query may not support time filters */ }

      hours.push({ hour: label, count });
    }

    return apiResponse(hours);
  } catch {
    // Fallback: return empty timeseries
    return apiResponse(Array.from({ length: 24 }, (_, i) => ({
      hour: `${String(i).padStart(2, "0")}:00`,
      count: 0,
    })));
  }
});

// ── Usage Analytics REST ──

fastify.get("/api/analytics/summary", { preHandler: [authenticate] }, async (_request, reply) => {
  try {
    const { getUsageSummary } = await import("@e-gaop/shared");
    const summary = await getUsageSummary();
    return apiResponse(summary);
  } catch (err: unknown) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, "Failed to get analytics summary");
    reply.code(500);
    return toProblemDetails("INTERNAL", "Failed to fetch analytics summary", "/api/analytics/summary", crypto.randomUUID());
  }
});

fastify.get("/api/analytics/patterns", { preHandler: [authenticate] }, async (request, reply) => {
  try {
    const { getExecutionPatterns } = await import("@e-gaop/shared");
    const days = parseInt((request.query as Record<string, string>).days ?? "7", 10);
    const patterns = await getExecutionPatterns(days);
    return apiResponse(patterns);
  } catch (err: unknown) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, "Failed to get execution patterns");
    reply.code(500);
    return toProblemDetails("INTERNAL", "Failed to fetch execution patterns", "/api/analytics/patterns", crypto.randomUUID());
  }
});

fastify.get("/api/analytics/models", { preHandler: [authenticate] }, async (_request, reply) => {
  try {
    const { getModelDistribution } = await import("@e-gaop/shared");
    const models = await getModelDistribution();
    return apiResponse(models);
  } catch (err: unknown) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, "Failed to get model distribution");
    reply.code(500);
    return toProblemDetails("INTERNAL", "Failed to fetch model distribution", "/api/analytics/models", crypto.randomUUID());
  }
});

fastify.get("/api/analytics/cost-trend", { preHandler: [authenticate] }, async (request, reply) => {
  try {
    const { getCostTrend } = await import("@e-gaop/shared");
    const days = parseInt((request.query as Record<string, string>).days ?? "30", 10);
    const trend = await getCostTrend(days);
    return apiResponse(trend);
  } catch (err: unknown) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, "Failed to get cost trend");
    reply.code(500);
    return toProblemDetails("INTERNAL", "Failed to fetch cost trend", "/api/analytics/cost-trend", crypto.randomUUID());
  }
});

fastify.get("/api/analytics/peak-hours", { preHandler: [authenticate] }, async (_request, reply) => {
  try {
    const { getPeakHours } = await import("@e-gaop/shared");
    const peakHours = await getPeakHours();
    return apiResponse(peakHours);
  } catch (err: unknown) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, "Failed to get peak hours");
    reply.code(500);
    return toProblemDetails("INTERNAL", "Failed to fetch peak hours", "/api/analytics/peak-hours", crypto.randomUUID());
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
    try {
      if (req.url === "/healthz" || req.url === "/readyz") {
        let temporalOk = false;
        try {
          if (temporalClient) {
            await Promise.race([
              temporalClient.workflow.getHandle("health-check-test").describe(),
              new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), 2000)),
            ]);
            temporalOk = true;
          }
        } catch (err: unknown) {
          const errMsg = err instanceof Error ? err.message : String(err);
          if (errMsg.includes("not found") || errMsg.includes("NotFound")) {
            temporalOk = true;
          }
        }
        let dbOk = false;
        try {
          const { getPool } = await import("@e-gaop/shared");
          const p = await getPool();
          const r = await p.query("SELECT 1");
          dbOk = r.rows.length > 0;
        } catch {}
        const allOk = dbOk;
        const code = allOk ? 200 : 503;
        if (!res.writableEnded && !res.headersSent) {
          res.writeHead(code, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            status: allOk ? "SERVING" : "DEGRADED",
            service: "api-server",
            dependencies: {
              postgres: dbOk ? "connected" : "unreachable",
              redis: "unknown",
              temporal: temporalOk ? "connected" : "unreachable",
            },
            uptime: Math.floor(process.uptime()),
            version: "1.0.0",
            timestamp: new Date().toISOString(),
          }));
        }
      } else {
        if (!res.writableEnded && !res.headersSent) {
          res.writeHead(404);
          res.end();
        }
      }
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      process.stderr.write(JSON.stringify({
        timestamp: new Date().toISOString(),
        level: "error",
        message: `Health endpoint error: ${errMsg}`,
      }) + "\n");
      try {
        if (!res.writableEnded && !res.headersSent) {
          res.writeHead(500);
          res.end();
        }
      } catch {}
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
