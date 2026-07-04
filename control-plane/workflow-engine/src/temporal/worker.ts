import { Worker, NativeConnection } from "@temporalio/worker";
import http from "http";
import fs from "fs";
import path from "path";

interface Logger {
  info: (msg: string, ...args: unknown[]) => void;
  error: (err: Error, msg: string) => void;
}

interface WorkerConfig {
  address: string;
  namespace: string;
  taskQueue: string;
  maxConcurrentActivityTaskExecutions?: number;
  maxConcurrentWorkflowTaskExecutions?: number;
  tlsCertPath?: string;
  tlsKeyPath?: string;
  healthPort?: number;
}

type WorkerState = "starting" | "running" | "shutdown" | "error";

interface TemporalConnectionOptions {
  address: string;
  tls?: {
    clientCertPair: {
      crt: Buffer;
      key: Buffer;
    };
  };
}

export async function createTemporalWorker(
  config: WorkerConfig,
  logger: Logger
): Promise<{ worker: Worker; healthServer: http.Server }> {
  const {
    address,
    namespace,
    taskQueue,
    maxConcurrentActivityTaskExecutions = 50,
    maxConcurrentWorkflowTaskExecutions = 10,
    tlsCertPath,
    tlsKeyPath,
    healthPort = parseInt(process.env.WORKFLOW_ENGINE_HEALTH_PORT || "15058", 10),
  } = config;

  let state: WorkerState = "starting";

  // Build connection options with optional mTLS
  const connectionOptions: TemporalConnectionOptions = { address };

  if (tlsCertPath && tlsKeyPath) {
    const tlsCert = fs.readFileSync(tlsCertPath);
    const tlsKey = fs.readFileSync(tlsKeyPath);
    connectionOptions.tls = {
      clientCertPair: {
        crt: tlsCert,
        key: tlsKey,
      },
    };
    logger.info("Using mTLS for Temporal connection");
  } else if (process.env.TEMPORAL_TLS_CERT && process.env.TEMPORAL_TLS_KEY) {
    const tlsCert = fs.readFileSync(process.env.TEMPORAL_TLS_CERT);
    const tlsKey = fs.readFileSync(process.env.TEMPORAL_TLS_KEY);
    connectionOptions.tls = {
      clientCertPair: {
        crt: tlsCert,
        key: tlsKey,
      },
    };
    logger.info("Using mTLS for Temporal connection (from env)");
  }

  const connection = await NativeConnection.connect(connectionOptions);

  const worker = await Worker.create({
    connection,
    namespace,
    taskQueue,
    workflowsPath: path.join(__dirname, "..", "workflows"),
    activities: path.join(__dirname, "activities") as string & object,
    maxConcurrentActivityTaskExecutions,
    maxConcurrentWorkflowTaskExecutions,
  });

  // Health endpoint
  const healthServer = http.createServer((req, res) => {
    if (req.url === "/health" || req.url === "/healthz") {
      const statusCode = state === "running" ? 200 : 503;
      res.writeHead(statusCode, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          status: state,
          service: "workflow-engine",
          timestamp: new Date().toISOString(),
        })
      );
    } else {
      res.writeHead(404);
      res.end();
    }
  });

  // Track worker state
  const originalShutdown = worker.shutdown.bind(worker);
  worker.shutdown = async () => {
    state = "shutdown";
    logger.info("Worker shutting down...");
    await originalShutdown();
  };

  // Start health server
  await new Promise<void>((resolve) => {
    healthServer.listen(healthPort, "0.0.0.0", () => {
      logger.info(`Health endpoint listening on port ${healthPort}`);
      resolve();
    });
  });

  // Start worker in background
  state = "running";
  worker.run().catch((err) => {
    state = "error";
    logger.error(err, "Worker failed");
  });

  // Graceful shutdown
  const shutdown = async () => {
    state = "shutdown";
    logger.info("Shutting down workflow engine...");
    await worker.shutdown();
    healthServer.close();
    connection.close();
    logger.info("Workflow engine shut down");
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  return { worker, healthServer };
}
