import { initTracing, shutdownTracing, createNamespaceServerInterceptor, createServiceTokenServerInterceptor, validateSecrets, loadSecretsIntoEnv } from "@e-gaop/shared";

initTracing("memory-plane");
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
import Redis from "ioredis";
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
  ...(process.env.NODE_ENV !== "production" && process.env.NODE_ENV !== "test" ? {
    transport: { target: "pino-pretty", options: { colorize: true } }
  } : {}),
});

const redis = new Redis({
  host: process.env.REDIS_HOST || "localhost",
  port: parseInt(process.env.REDIS_PORT || "6379", 10),
  lazyConnect: true,
  retryStrategy: (times) => Math.min(times * 50, 2000),
});

redis.on("error", (err) => logger.warn({ err: err.message }, "Redis connection issue"));
redis.on("connect", () => logger.info("Connected to Redis"));

const PROTO_PATH = path.resolve(__dirname, "../../api/proto/egaop/v1/memory.proto");

const packageDefinition = protoLoader.loadSync(PROTO_PATH, {
  keepCase: true,
  longs: String,
  enums: String,
  defaults: true,
  oneofs: true,
  includeDirs: [path.resolve(__dirname, "../../api/proto")]
});

const egaopProto = grpc.loadPackageDefinition(packageDefinition) as any;
const memoryService = egaopProto.egaop.v1.MemoryService;

const server = new grpc.Server({
  interceptors: [createNamespaceServerInterceptor(), createServiceTokenServerInterceptor()],
});

server.addService(memoryService.service, {
  Read: async (call: any, callback: any) => {
    const { agent_id, namespace, memory_type, key } = call.request;

    logger.info({ agent_id, namespace, memory_type, key }, "Memory read request");

    try {
      let data: any = null;

      if (memory_type === "working") {
        const raw = await redis.get(`egaop:${namespace}:${agent_id}:working:${key}`);
        if (raw) data = JSON.parse(raw);
      } else {
        const raw = await redis.get(`egaop:${namespace}:${agent_id}:${memory_type}:${key}`);
        if (raw) data = JSON.parse(raw);
      }

      callback(null, { data: data || {}, found: !!data });
    } catch (err: any) {
      logger.error({ err: err.message }, "Memory read error");
      callback(null, { data: {}, found: false });
    }
  },

  Write: async (call: any, callback: any) => {
    const { agent_id, namespace, memory_type, key, data, ttl_seconds } = call.request;

    logger.info({ agent_id, namespace, memory_type, key }, "Memory write request");

    try {
      const redisKey = `egaop:${namespace}:${agent_id}:${memory_type}:${key}`;
      const serialized = JSON.stringify(data);
      const ttl = ttl_seconds || (memory_type === "working" ? 300 : 86400);

      await redis.setex(redisKey, ttl, serialized);

      callback(null, { status: "success", version: `rev-${Date.now()}` });
    } catch (err: any) {
      logger.error({ err: err.message }, "Memory write error");
      callback(null, { status: "error", version: "" });
    }
  },

  Delete: async (call: any, callback: any) => {
    const { agent_id, namespace, memory_type, key } = call.request;
    try {
      const redisKey = `egaop:${namespace}:${agent_id}:${memory_type}:${key}`;
      await redis.del(redisKey);
      callback(null, { status: "success" });
    } catch (err: any) {
      callback(null, { status: "error" });
    }
  },

  List: async (call: any, callback: any) => {
    const { agent_id, namespace, memory_type } = call.request;
    try {
      const pattern = `egaop:${namespace}:${agent_id}:${memory_type}:*`;
      const entries: any[] = [];
      const stream = redis.scanStream({ match: pattern, count: 100 });
      for await (const keys of stream) {
        for (const k of keys) {
          const raw = await redis.get(k);
          const name = k.split(":").slice(4).join(":");
          entries.push({ key: name, data: raw ? JSON.parse(raw) : {} });
        }
      }
      callback(null, { entries });
    } catch (err: any) {
      callback(null, { entries: [] });
    }
  },
});

server.addService(HEALTH_SERVICE, {
  check: async (_call: any, callback: any) => {
    try {
      await redis.ping();
      callback(null, { status: "SERVING" });
    } catch {
      callback(null, { status: "NOT_SERVING" });
    }
  }
});

if (process.env.NODE_ENV !== "test") {
  const MEMORY_PORT = process.env.MEMORY_PLANE_PORT || "50055";
  const HEALTH_PORT = parseInt(process.env.MEMORY_PLANE_HEALTH_PORT || "15055", 10);

  server.bindAsync(`0.0.0.0:${MEMORY_PORT}`, getServerCredentials(), (err, port) => {
    if (err) {
      logger.error(err, "Failed to bind Memory Plane server");
      return;
    }
    server.start();
    logger.info(`E-GAOP Memory Plane listening on port ${port}`);
  });

  const healthServer = http.createServer(async (req, res) => {
    if (req.url === "/healthz" || req.url === "/readyz") {
      try {
        await redis.ping();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "SERVING", service: "memory-plane" }));
      } catch {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "NOT_SERVING", service: "memory-plane" }));
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
    logger.info("Shutting down Memory Plane...");
    server.tryShutdown(async () => {
      healthServer.close();
      redis.disconnect();
      await shutdownTracing();
      logger.info("Memory Plane shut down");
      process.exit(0);
    });
    setTimeout(() => { logger.error("Forced shutdown"); process.exit(1); }, 5000).unref();
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

export { server, redis };
