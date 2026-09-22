import { initTracing, shutdownTracing, createNamespaceServerInterceptor, createServiceTokenServerInterceptor, createTraceServerInterceptor, validateSecrets, loadSecretsIntoEnv, createAuditEntry, buildHealthResponse, healthToHttpStatus, checkPostgres, checkRedis } from "@e-gaop/shared";

initTracing("memory-plane");
loadSecretsIntoEnv();
if (process.env.NODE_ENV !== "test") {
  validateSecrets();
}

import path from "path";
import http from "http";
import crypto from "crypto";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import pino from "pino";
import Redis from "ioredis";
import { Pool } from "pg";
import { getServerCredentials } from "@e-gaop/shared";
import { MemoryPlaneRepository } from "./repository";
import { MemoryWriteQueue } from "./write-queue";

function verifyServiceToken(req: http.IncomingMessage): boolean {
  const expectedToken = process.env.INTERNAL_SERVICE_TOKEN ?? "";
  if (!expectedToken) return true;
  const provided = (req.headers["x-service-token"] as string) ?? "";
  const a = Buffer.from(expectedToken);
  const b = Buffer.from(provided);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
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

// ─── Redis (fast path) ────────────────────────────────────────────────────

const redis = new Redis({
  host: process.env.REDIS_HOST || "localhost",
  port: parseInt(process.env.REDIS_PORT || "6379", 10),
  password: process.env.REDIS_PASSWORD || undefined,
  lazyConnect: true,
  retryStrategy: (times) => Math.min(times * 50, 2000),
  ...(process.env.REDIS_SENTINEL_HOSTS
    ? {
        sentinels: process.env.REDIS_SENTINEL_HOSTS.split(",").map((s) => {
          const [host, port] = s.trim().split(":");
          return { host: host!, port: parseInt(port || "26379", 10) };
        }),
        name: process.env.REDIS_SENTINEL_MASTER || "mymaster",
        sentinelPassword: process.env.REDIS_SENTINEL_PASSWORD || undefined,
        enableOfflineQueue: true,
        maxRetriesPerRequest: 3,
      }
    : {}),
});

redis.on("error", (err) => logger.warn({ err: err.message }, "Redis connection issue"));
redis.on("connect", () => logger.info("Connected to Redis"));

// ─── PostgreSQL + pgvector (durable path) ─────────────────────────────────

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

const memRepo = new MemoryPlaneRepository(pgPool);

// Write-ahead log: durable writes are queued and retried instead of fire-and-forget.
const memWriteQueue = new MemoryWriteQueue(memRepo, {
  maxAttempts: parseInt(process.env.MEMORY_WAL_MAX_ATTEMPTS || "5", 10),
  backoffBaseMs: parseInt(process.env.MEMORY_WAL_BACKOFF_MS || "500", 10),
  maxQueueSize: parseInt(process.env.MEMORY_WAL_MAX_QUEUE || "10000", 10),
});

pgPool.on("error", (err) => logger.warn({ err: err.message }, "PostgreSQL connection issue"));

// ─── Proto setup ──────────────────────────────────────────────────────────

const PROTO_PATH = path.resolve(__dirname, "../../api/proto/egaop/v1/memory.proto");

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
const memoryService = egaopProto.egaop.v1.MemoryService;

const server = new grpc.Server({
  interceptors: [createNamespaceServerInterceptor(), createServiceTokenServerInterceptor(), createTraceServerInterceptor()],
});

function sanitizeKeyComponent(value: unknown): string {
  if (typeof value !== "string") return "unknown";
  const sanitized = value.replace(/[^a-zA-Z0-9_.-]/g, "_");
  return sanitized.substring(0, 128) || "unknown";
}

server.addService(memoryService.service, {
  Read: async (call: grpc.ServerUnaryCall<unknown, unknown>, callback: grpc.sendUnaryData<unknown>) => {
    const { agent_id, namespace, memory_type, key } = call.request as Record<string, unknown>;

    logger.info({ agent_id, namespace, memory_type, key }, "Memory read request");

    try {
      const safeNs = sanitizeKeyComponent(namespace);
      const safeAgent = sanitizeKeyComponent(agent_id);
      const safeType = sanitizeKeyComponent(memory_type);
      const safeKey = sanitizeKeyComponent(key);

      // Fast path: try Redis first
      let data: unknown = null;
      const redisKey = `egaop:${safeNs}:${safeAgent}:${safeType}:${safeKey}`;
      const raw = await redis.get(redisKey);
      if (raw) {
        data = JSON.parse(raw);
      }

      // Slow path: fall back to PostgreSQL if not in Redis
      if (!data) {
        try {
          const entry = await memRepo.get(namespace as string, agent_id as string, key as string);
          if (entry) {
            data = entry.value;
            // Backfill Redis for faster subsequent reads
            const ttl = memory_type === "working" ? 300 : 86400;
            await redis.setex(redisKey, ttl, JSON.stringify(data));
          }
        } catch (pgErr: unknown) {
          logger.warn({ err: pgErr instanceof Error ? pgErr.message : String(pgErr) }, "PostgreSQL read fallback failed");
        }
      }

      callback(null, { data: data || {}, found: !!data });
    } catch (err: unknown) {
      logger.error({ err: err instanceof Error ? err.message : String(err) }, "Memory read error");
      callback(null, { data: {}, found: false });
    }
  },

  Write: async (call: grpc.ServerUnaryCall<unknown, unknown>, callback: grpc.sendUnaryData<unknown>) => {
    const { agent_id, namespace, memory_type, key, data, ttl_seconds } = call.request as Record<string, unknown>;

    logger.info({ agent_id, namespace, memory_type, key }, "Memory write request");

    try {
      const safeNs = sanitizeKeyComponent(namespace);
      const safeAgent = sanitizeKeyComponent(agent_id);
      const safeType = sanitizeKeyComponent(memory_type);
      const safeKey = sanitizeKeyComponent(key);

      const redisKey = `egaop:${safeNs}:${safeAgent}:${safeType}:${safeKey}`;
      const serialized = JSON.stringify(data);
      const ttl = (ttl_seconds as number) || (memory_type === "working" ? 300 : 86400);

      // Fast path: write to Redis
      await redis.setex(redisKey, ttl, serialized);

      // Durable path: enqueue to write-ahead log with retry/backoff (no fire-and-forget)
      memWriteQueue.enqueue({
        namespace: safeNs,
        agentId: safeAgent,
        key: safeKey,
        value: data as Record<string, unknown>,
        ttlSeconds: ttl,
      });

      try {
        createAuditEntry(
          "agent.tool_call",
          "info",
          { type: "agent", id: agent_id as string, namespace: namespace as string },
          { name: "memory.Write", result: "allowed" },
          { type: "memory", id: `${namespace}/${memory_type}/${key}`, namespace: namespace as string },
        );
      } catch { /* audit failure is non-fatal */ }

      callback(null, { status: "success", version: `rev-${Date.now()}` });
    } catch (err: unknown) {
      logger.error({ err: err instanceof Error ? err.message : String(err) }, "Memory write error");
      callback(null, { status: "error", version: "" });
    }
  },

  Delete: async (call: grpc.ServerUnaryCall<unknown, unknown>, callback: grpc.sendUnaryData<unknown>) => {
    const { agent_id, namespace, memory_type, key } = call.request as Record<string, unknown>;
    try {
      const safeNs = sanitizeKeyComponent(namespace);
      const safeAgent = sanitizeKeyComponent(agent_id);
      const safeType = sanitizeKeyComponent(memory_type);
      const safeKey = sanitizeKeyComponent(key);

      const redisKey = `egaop:${safeNs}:${safeAgent}:${safeType}:${safeKey}`;
      await redis.del(redisKey);

      // Also soft-delete from PostgreSQL
      memRepo.delete(namespace as string, agent_id as string, key as string)
        .catch((pgErr) => logger.warn({ err: pgErr.message }, "PostgreSQL delete failed"));

      try {
        createAuditEntry(
          "agent.tool_call",
          "info",
          { type: "agent", id: agent_id as string, namespace: namespace as string },
          { name: "memory.Delete", result: "allowed" },
          { type: "memory", id: `${namespace}/${memory_type}/${key}`, namespace: namespace as string },
        );
      } catch { /* audit failure is non-fatal */ }

      callback(null, { status: "success" });
    } catch (err: unknown) {
      callback(null, { status: "error" });
    }
  },

  List: async (call: grpc.ServerUnaryCall<unknown, unknown>, callback: grpc.sendUnaryData<unknown>) => {
    const { agent_id, namespace, memory_type } = call.request as Record<string, unknown>;
    try {
      const safeNs = sanitizeKeyComponent(namespace);
      const safeAgent = sanitizeKeyComponent(agent_id);
      const safeType = sanitizeKeyComponent(memory_type);

      // Try Redis first
      const pattern = `egaop:${safeNs}:${safeAgent}:${safeType}:*`;
      const entries: Array<{ key: string; data: unknown }> = [];
      const stream = redis.scanStream({ match: pattern, count: 100 });
      for await (const keys of stream) {
        for (const k of keys) {
          const raw = await redis.get(k);
          const name = k.split(":").slice(4).join(":");
          entries.push({ key: name, data: raw ? JSON.parse(raw) : {} });
        }
      }

      // Fall back to PostgreSQL if Redis returned nothing
      if (entries.length === 0) {
        try {
          const pgEntries = await memRepo.list(namespace as string, agent_id as string);
          for (const entry of pgEntries) {
            entries.push({ key: entry.key, data: entry.value });
          }
        } catch (pgErr: unknown) {
          logger.warn({ err: pgErr instanceof Error ? pgErr.message : String(pgErr) }, "PostgreSQL list fallback failed");
        }
      }

      callback(null, { entries });
    } catch (err: unknown) {
      callback(null, { entries: [] });
    }
  },
});

server.addService(HEALTH_SERVICE, {
  check: async (_call: grpc.ServerUnaryCall<unknown, unknown>, callback: grpc.sendUnaryData<unknown>) => {
    try {
      await Promise.all([redis.ping(), pgPool.query("SELECT 1")]);
      callback(null, { status: "SERVING" });
    } catch {
      callback(null, { status: "NOT_SERVING" });
    }
  }
});

if (process.env.NODE_ENV !== "test") {
  const MEMORY_PORT = process.env.MEMORY_PLANE_PORT || "50055";
  const HEALTH_PORT = parseInt(process.env.MEMORY_PLANE_HEALTH_PORT || "15055", 10);

  // Start expired memory cleanup
  memRepo.startCleanupInterval();

  server.bindAsync(`0.0.0.0:${MEMORY_PORT}`, getServerCredentials(), (err, port) => {
    if (err) {
      logger.error(err, "Failed to bind Memory Plane server");
      return;
    }
    server.start();
    logger.info(`E-GAOP Memory Plane listening on port ${port}`);
  });

  const SERVICE_VERSION = process.env.SERVICE_VERSION || "0.1.0";
  const healthStartTime = new Date();

  const healthServer = http.createServer(async (req, res) => {
    if (req.url === "/healthz") {
      const response = buildHealthResponse("memory-plane", SERVICE_VERSION, healthStartTime, []);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(response));
    } else if (req.url === "/readyz") {
      const checks = await Promise.all([
        checkPostgres(() => pgPool.query("SELECT 1")),
        checkRedis(() => redis.ping()),
      ]);
      const response = buildHealthResponse("memory-plane", SERVICE_VERSION, healthStartTime, checks);
      res.writeHead(healthToHttpStatus(response.status), { "Content-Type": "application/json" });
      res.end(JSON.stringify(response));
    } else if (req.url === "/api/v1/memory/search" && req.method === "POST") {
      // Vector similarity search endpoint (used by other services internally)
      if (!verifyServiceToken(req)) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Unauthorized" }));
        return;
      }
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", async () => {
        try {
          const { namespace, embedding, top_k } = JSON.parse(body);
          if (!namespace || !embedding) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "namespace and embedding required" }));
            return;
          }
          const results = await memRepo.searchSimilar(namespace, embedding, top_k || 10);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            results: results.map((r) => ({
              key: r.entry.key,
              agent_id: r.entry.agentId,
              value: r.entry.value,
              similarity: r.similarity,
            })),
          }));
        } catch (err: unknown) {
          logger.error({ err: err instanceof Error ? err.message : String(err) }, "Vector search error");
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Search failed" }));
        }
      });
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  healthServer.listen(HEALTH_PORT, "0.0.0.0", () => {
    logger.info(`Health endpoint listening on port ${HEALTH_PORT}`);
  });

  const shutdown = async () => {
    logger.info("Shutting down Memory Plane...");
    memRepo.stopCleanupInterval();
    server.tryShutdown(async () => {
      healthServer.close();
      redis.disconnect();
      await memWriteQueue.dispose();
      await pgPool.end();
      await shutdownTracing();
      logger.info("Memory Plane shut down");
      process.exit(0);
    });
    setTimeout(() => { logger.error("Forced shutdown"); process.exit(1); }, 5000).unref();
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

export { server, redis, pgPool, memRepo, memWriteQueue };
