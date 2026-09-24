import { initTracing, shutdownTracing, validateSecrets, loadSecretsIntoEnv, buildHealthResponse, healthToHttpStatus, checkPostgres, checkSkipped } from "@e-gaop/shared";

initTracing("workflow-engine");
loadSecretsIntoEnv();
if (process.env.NODE_ENV !== "test") {
  validateSecrets();
}

import { Worker, NativeConnection } from '@temporalio/worker';
import http from 'http';
import path from 'path';
import pino from 'pino';
import { getPool } from '@e-gaop/shared';

const logger = pino({
  level: process.env.NODE_ENV === "test" ? "silent" : (process.env.LOG_LEVEL || "info"),
  ...(process.env.NODE_ENV !== "production" && process.env.NODE_ENV !== "test" ? {
    transport: { target: "pino-pretty", options: { colorize: true } }
  } : {}),
});

const HEALTH_PORT = parseInt(process.env.WORKFLOW_ENGINE_HEALTH_PORT || '15058', 10);
const DLQ_SERVICE_TOKEN = process.env.INTERNAL_SERVICE_TOKEN;
const SERVICE_VERSION = process.env.SERVICE_VERSION || "1.0.0";
const startTime = new Date();

let temporalConnected = false;
let temporalAddress = '';

function verifyServiceToken(req: http.IncomingMessage): boolean {
  if (!DLQ_SERVICE_TOKEN) return false;
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ') && authHeader.slice(7) === DLQ_SERVICE_TOKEN) return true;
  const tokenHeader = req.headers['x-service-token'];
  if (typeof tokenHeader === 'string' && tokenHeader === DLQ_SERVICE_TOKEN) return true;
  return false;
}

const healthServer = http.createServer(async (req, res) => {
  const url = req.url ?? '/';
  // ── Liveness: Is the process alive? (no dependency checks) ────────
  if (url === '/healthz') {
    const response = buildHealthResponse("workflow-engine", SERVICE_VERSION, startTime, []);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(response));
    return;
  }

  // ── Readiness: Can we accept traffic? (checks real dependencies) ──
  if (url === '/readyz') {
    const pool = await getPool();
    const checks = await Promise.all([
      checkPostgres(() => pool.query("SELECT 1")),
      temporalConnected
        ? Promise.resolve({ name: "temporal" as const, status: "healthy" as const })
        : checkSkipped("temporal", "not connected — running in degraded mode"),
    ]);

    const response = buildHealthResponse("workflow-engine", SERVICE_VERSION, startTime, checks);
    const code = healthToHttpStatus(response.status);
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(response));
    return;
  }

  // ── DLQ Admin (authenticated) ─────────────────────────────────────
  if (url.startsWith('/dlq')) {
    if (!verifyServiceToken(req)) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized: valid service token required' }));
      return;
    }

    // GET /dlq — list failed executions
    if (url === '/dlq' && req.method === 'GET') {
      try {
        const pool = await getPool();
        const { rows } = await pool.query(
          `SELECT id, agent_id, execution_id, namespace, status, error_message,
                  output, total_cost, iterations, failed_at, replayed_at, replay_count
           FROM dead_letter_queue
           ORDER BY failed_at DESC
           LIMIT 100`
        );
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ entries: rows }));
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: msg }));
      }
      return;
    }

    // POST /dlq/:id/replay — replay a failed execution
    const replayMatch = url.match(/^\/dlq\/([^/]+)\/replay$/);
    if (replayMatch && req.method === 'POST') {
      try {
        const executionId = replayMatch[1];
        const pool = await getPool();
        await pool.query(
          `UPDATE dead_letter_queue
           SET replayed_at = NOW(), replay_count = replay_count + 1
           WHERE execution_id = $1`,
          [executionId]
        );
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ replayed: true, execution_id: executionId }));
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: msg }));
      }
      return;
    }
  }

  res.writeHead(404);
  res.end();
});

async function run() {
  healthServer.listen(HEALTH_PORT, '0.0.0.0', () => {
    logger.info(`Health endpoint listening on port ${HEALTH_PORT}`);
  });

  temporalAddress = `${process.env.TEMPORAL_HOST || 'temporal'}:${process.env.TEMPORAL_PORT || '7233'}`;
  logger.info(`Connecting to Temporal at ${temporalAddress}`);

  let connection;
  // Retry the initial connect: temporal is briefly unavailable during rolling
  // restarts and cluster resume. A one-shot attempt left this pod permanently
  // degraded (readiness: temporal unhealthy) with no recovery path.
  // Readiness reports temporal as degraded-but-200 until connect succeeds.
  for (let attempt = 1; ; attempt++) {
    try {
      connection = await NativeConnection.connect({
        address: temporalAddress,
      });
      break;
    } catch (err) {
      logger.warn(
        {
          err: err instanceof Error ? err.message : String(err),
          attempt,
          retryInMs: 5000,
        },
        'Temporal not available — running in degraded mode (no workflow execution), retrying',
      );
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
  }
  temporalConnected = true;

  // Load real temporal activities (with gRPC calls to policy-plane, sandbox-runtime, etc.)
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const activitiesModule = require(path.join(__dirname, 'temporal', 'activities'));
  logger.info({ activities: Object.keys(activitiesModule) }, 'Loaded temporal activities');

  const worker = await Worker.create({
    connection,
    workflowsPath: path.join(__dirname, 'temporal', 'workflows'),
    activities: activitiesModule,
    taskQueue: process.env.TEMPORAL_TASK_QUEUE || 'egaop-agent-queue',
    namespace: process.env.TEMPORAL_NAMESPACE || 'egaop',
    maxConcurrentActivityTaskExecutions: 16,
    maxConcurrentWorkflowTaskExecutions: 8,
  });

  temporalConnected = true;
  logger.info('Workflow Engine worker started');

  const shutdown = async () => {
    temporalConnected = false;
    logger.info('Shutting down Workflow Engine...');
    healthServer.close();
    await worker.shutdown();
    connection.close();
    await shutdownTracing();
    setTimeout(() => { logger.error('Forced shutdown'); process.exit(1); }, 5000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  await worker.run();
}

run().catch((err) => {
  logger.error(err, 'Worker failed');
  process.exit(1);
});
