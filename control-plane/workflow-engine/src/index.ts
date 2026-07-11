import { initTracing, shutdownTracing, validateSecrets } from "@e-gaop/shared";

initTracing("workflow-engine");
if (process.env.NODE_ENV !== "test") {
  validateSecrets();
}

import { Worker, NativeConnection } from '@temporalio/worker';
import http from 'http';
import path from 'path';
import pino from 'pino';

const logger = pino({
  level: process.env.NODE_ENV === 'test' ? 'silent' : (process.env.LOG_LEVEL || 'info'),
  transport: process.env.NODE_ENV !== 'test' ? { target: 'pino-pretty' } : undefined,
});

const HEALTH_PORT = parseInt(process.env.WORKFLOW_ENGINE_HEALTH_PORT || '15058', 10);
let workerReady = false;

const healthServer = http.createServer((req, res) => {
  if (req.url === '/healthz' || req.url === '/readyz') {
    const status = workerReady ? 'SERVING' : 'NOT_SERVING';
    const code = workerReady ? 200 : 503;
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status, service: 'workflow-engine' }));
  } else {
    res.writeHead(404);
    res.end();
  }
});

async function run() {
  const temporalAddress = `${process.env.TEMPORAL_HOST || 'temporal'}:${process.env.TEMPORAL_PORT || '7233'}`;
  logger.info(`Connecting to Temporal at ${temporalAddress}`);

  const connection = await NativeConnection.connect({
    address: temporalAddress,
  });

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

  workerReady = true;
  logger.info('Workflow Engine worker started');

  healthServer.listen(HEALTH_PORT, '0.0.0.0', () => {
    logger.info(`Health endpoint listening on port ${HEALTH_PORT}`);
  });

  const shutdown = async () => {
    workerReady = false;
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
