import { GenericContainer, StartedTestContainer, Wait } from "testcontainers";
import http from "http";
import path from "path";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";

const PROTO_DIR = path.resolve(__dirname, "../../api/proto");

interface ServiceHealth {
  name: string;
  host: string;
  port: number;
  grpcPort?: number;
  healthPath?: string;
}

export interface IntegrationContext {
  postgres: StartedTestContainer;
  redis: StartedTestContainer;
  opa: StartedTestContainer;
  postgresPool: { host: string; port: number; database: string; user: string; password: string };
  redisUrl: string;
  opaUrl: string;
  services: Map<string, ServiceHealth>;
}

async function waitForHealth(host: string, port: number, path: string, timeoutMs: number = 30000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: Error | null = null;

  while (Date.now() < deadline) {
    try {
      await new Promise<void>((resolve, reject) => {
        const req = http.get(`http://${host}:${port}${path}`, { timeout: 2000 }, (res) => {
          if (res.statusCode === 200) {
            res.resume();
            resolve();
          } else {
            res.resume();
            reject(new Error(`HTTP ${res.statusCode}`));
          }
        });
        req.on("error", reject);
        req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
      });
      return;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  throw new Error(`Health check failed for ${host}:${port}${path} after ${timeoutMs}ms: ${lastError?.message}`);
}

async function waitForGrpcHealth(host: string, port: number, timeoutMs: number = 30000): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      const client = new grpc.Client(`${host}:${port}`, grpc.credentials.createInsecure());
      await new Promise<void>((resolve, reject) => {
        const deadlineTs = Date.now() + 2000;
        client.waitForReady(deadlineTs, (err) => {
          if (err) reject(err);
          else resolve();
        });
      });
      client.close();
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}

export async function integrationSetup(): Promise<IntegrationContext> {
  const postgres = await new GenericContainer("postgres:15-alpine")
    .withEnvironment({
      POSTGRES_DB: "egaop_test",
      POSTGRES_USER: "test",
      POSTGRES_PASSWORD: "test",
    })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage("database system is ready to accept connections", 2))
    .start();

  const redis = await new GenericContainer("redis:7-alpine")
    .withExposedPorts(6379)
    .withWaitStrategy(Wait.forLogMessage("Ready to accept connections"))
    .start();

  const opa = await new GenericContainer("openpolicyagent/opa:latest")
    .withCommand(["run", "--server", "--addr=0.0.0.0:8181"])
    .withExposedPorts(8181)
    .withWaitStrategy(Wait.forLogMessage("ready to serve requests"))
    .start();

  const pgHost = postgres.getHost();
  const pgPort = postgres.getMappedPort(5432);
  const redisHost = redis.getHost();
  const redisPort = redis.getMappedPort(6379);
  const opaHost = opa.getHost();
  const opaPort = opa.getMappedPort(8181);

  const pgPool = {
    host: pgHost,
    port: pgPort,
    database: "egaop_test",
    user: "test",
    password: "test",
  };
  const redisUrl = `redis://${redisHost}:${redisPort}`;
  const opaUrl = `http://${opaHost}:${opaPort}`;

  const services = new Map<string, ServiceHealth>();

  const serviceHealthChecks: ServiceHealth[] = [
    { name: "api-server", host: "localhost", port: 15051, healthPath: "/healthz" },
    { name: "memory-plane", host: "localhost", port: 15055, healthPath: "/healthz" },
    { name: "observability-plane", host: "localhost", port: 15056, healthPath: "/healthz" },
    { name: "policy-plane", host: "localhost", port: 15059, healthPath: "/healthz" },
    { name: "secret-store", host: "localhost", port: 15057, healthPath: "/healthz" },
    { name: "llm-router", host: "localhost", port: 15053, healthPath: "/healthz" },
    { name: "tool-proxy", host: "localhost", port: 15052, healthPath: "/healthz" },
    { name: "sandbox-runtime", host: "localhost", port: 15054, healthPath: "/healthz" },
  ];

  for (const svc of serviceHealthChecks) {
    services.set(svc.name, svc);
  }

  return {
    postgres,
    redis,
    opa,
    postgresPool: pgPool,
    redisUrl,
    opaUrl,
    services,
  };
}

export async function waitForAllServices(ctx: IntegrationContext, timeoutMs: number = 60000): Promise<void> {
  const checks: Promise<void>[] = [];

  for (const [, svc] of ctx.services) {
    if (svc.healthPath) {
      checks.push(waitForHealth(svc.host, svc.port, svc.healthPath, timeoutMs));
    }
    if (svc.grpcPort) {
      checks.push(waitForGrpcHealth(svc.host, svc.grpcPort, timeoutMs));
    }
  }

  await Promise.all(checks);
}

export async function teardownIntegration(ctx: IntegrationContext): Promise<void> {
  const errors: Error[] = [];

  try {
    await ctx.postgres.stop();
  } catch (err) {
    errors.push(err instanceof Error ? err : new Error(String(err)));
  }

  try {
    await ctx.redis.stop();
  } catch (err) {
    errors.push(err instanceof Error ? err : new Error(String(err)));
  }

  try {
    await ctx.opa.stop();
  } catch (err) {
    errors.push(err instanceof Error ? err : new Error(String(err)));
  }

  if (errors.length > 0) {
    process.stderr.write(
      JSON.stringify({
        level: "warn",
        msg: "Teardown errors (containers may not have been running)",
        errors: errors.map((e) => e.message),
      }) + "\n"
    );
  }
}

export function loadProto(servicePath: string): any {
  const packageDef = protoLoader.loadSync(path.join(PROTO_DIR, servicePath), {
    keepCase: true,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true,
    includeDirs: [PROTO_DIR],
  });
  return grpc.loadPackageDefinition(packageDef);
}

export function createGrpcClient(proto: any, serviceName: string, host: string, port: number): any {
  const Service = proto.egaop.v1[serviceName];
  return new Service(`${host}:${port}`, grpc.credentials.createInsecure());
}

export function startGrpcServer(svc: grpc.ServiceDefinition, impl: Record<string, any>): Promise<{ server: grpc.Server; port: number }> {
  return new Promise((resolve, reject) => {
    const server = new grpc.Server();
    server.addService(svc, impl);
    server.bindAsync("localhost:0", grpc.ServerCredentials.createInsecure(), (err, port) => {
      if (err) reject(err);
      else { server.start(); resolve({ server, port }); }
    });
  });
}
