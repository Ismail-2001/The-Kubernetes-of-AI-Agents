import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import http from "http";
import path from "path";
import * as fs from "fs";
import pino from "pino";
import { createServiceTokenServerInterceptor } from "./interceptors.js";
import { createNamespaceServerInterceptor } from "./namespace-enforcement.js";
import { createTraceServerInterceptor } from "./trace-propagation.js";
import { createMTLSServerCredentials, createMTLSClientCredentials, watchCertificateRotation } from "../tls.js";
import type { ServerInterceptor } from "@grpc/grpc-js";

const logger = pino({ level: process.env.LOG_LEVEL || "info" });

export interface GrpcServiceConfig {
  protoPath: string;
  packageDefinition: protoLoader.Options;
  serviceName: string;
  serviceDefinition: grpc.ServiceDefinition<grpc.UntypedHandleCall>;
  implementation: grpc.UntypedServiceImplementation;
}

export interface GrpcServerConfig {
  serviceName: string;
  port: number;
  healthPort: number;
  services: GrpcServiceConfig[];
  interceptors?: ServerInterceptor[];
  enableMTLS?: boolean;
  certDir?: string;
}

export class GrpcServer {
  private server: grpc.Server;
  private healthServer?: http.Server;
  private certWatcher?: fs.FSWatcher;
  private readonly config: GrpcServerConfig;

  constructor(config: GrpcServerConfig) {
    this.config = config;
    const defaultInterceptors = [
      createNamespaceServerInterceptor(),
      createServiceTokenServerInterceptor(),
      createTraceServerInterceptor(),
    ];

    this.server = new grpc.Server({
      interceptors: config.interceptors ?? defaultInterceptors,
    });
  }

  async start(): Promise<void> {
    const { serviceName, port, healthPort, services, enableMTLS, certDir } = this.config;

    // P3: fail-closed — requesting mTLS without a certDir must not silently
    // downgrade to a plaintext server.
    if (enableMTLS && !certDir) {
      throw new Error("enableMTLS requires certDir — refusing to start with plaintext fallback");
    }

    const credentials = enableMTLS && certDir
      ? createMTLSServerCredentials(certDir)
      : grpc.ServerCredentials.createInsecure();

    for (const svc of services) {
      const pkgDef = protoLoader.loadSync(svc.protoPath, {
        keepCase: true,
        longs: String,
        enums: String,
        defaults: true,
        oneofs: true,
        includeDirs: [path.dirname(svc.protoPath)],
        ...svc.packageDefinition,
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const proto = grpc.loadPackageDefinition(pkgDef) as Record<string, any>;
      const sd = proto[svc.serviceName.replace(/\./g, "._")]?.service ?? svc.serviceDefinition;
      if (sd) {
        this.server.addService(sd, svc.implementation);
      }
    }

    if (enableMTLS && certDir) {
      this.certWatcher = watchCertificateRotation(certDir, () => {
        logger.warn("Certificate rotation detected — restart recommended for mTLS update");
      });
    }

    return new Promise((resolve, reject) => {
      this.server.bindAsync(`0.0.0.0:${port}`, credentials, (err, boundPort) => {
        if (err) {
          reject(err);
          return;
        }
        this.server.start();
        logger.info({ service: serviceName, port: boundPort }, "gRPC server started");

        this.healthServer = http.createServer((req, res) => {
          if (req.url === "/healthz" || req.url === "/readyz") {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ status: "SERVING", service: serviceName }));
          } else {
            res.writeHead(404);
            res.end();
          }
        });
        this.healthServer.listen(healthPort, "0.0.0.0", () => {
          logger.info({ service: serviceName, healthPort }, "Health endpoint started");
        });

        resolve();
      });
    });
  }

  async shutdown(timeoutMs: number = 5000): Promise<void> {
    logger.info({ service: this.config.serviceName }, "Shutting down...");
    this.certWatcher?.close();
    return new Promise((resolve) => {
      this.server.tryShutdown(() => {
        if (this.healthServer) {
          this.healthServer.close();
        }
        logger.info({ service: this.config.serviceName }, "Shut down");
        resolve();
      });
      setTimeout(() => {
        logger.error({ service: this.config.serviceName }, "Forced shutdown");
        process.exit(1);
      }, timeoutMs).unref();
    });
  }
}

function getServiceClient<T>(targetService: string, port: number, serviceName: string, enableMTLS?: boolean, certDir?: string): T {
  const credentials = enableMTLS && certDir
    ? createMTLSClientCredentials(certDir)
    : grpc.credentials.createInsecure();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- dynamic gRPC client construction
  const ClientConstructor = (grpc as any).makeGenericClientConstructor(
    {},
    `${targetService}.${serviceName}`,
    { channelCredentials: credentials }
  );
  return new ClientConstructor(`dns:///${targetService}:${port}`) as T;
}

export { getServiceClient };
