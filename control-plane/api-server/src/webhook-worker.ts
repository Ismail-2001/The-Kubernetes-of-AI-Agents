import { getPool } from "@e-gaop/shared";
import pino from "pino";
import { signWebhookPayload, type WebhookDelivery, type WebhookPayload } from "@e-gaop/shared";

const logger = pino({
  level: process.env.LOG_LEVEL || "info",
});

const POLL_INTERVAL_MS = parseInt(process.env.WEBHOOK_POLL_INTERVAL_MS || "5000", 10);
const BATCH_SIZE = parseInt(process.env.WEBHOOK_BATCH_SIZE || "10", 10);
const REQUEST_TIMEOUT_MS = parseInt(process.env.WEBHOOK_TIMEOUT_MS || "10000", 10);
const MAX_RETRIES = parseInt(process.env.WEBHOOK_MAX_RETRIES || "5", 10);
const RETRY_DELAY_MS = parseInt(process.env.WEBHOOK_RETRY_DELAY_MS || "1000", 10);

let running = false;
let timer: ReturnType<typeof setTimeout> | null = null;

function computeRetryDelay(attempt: number): number {
  const delay = RETRY_DELAY_MS * Math.pow(2, attempt);
  return Math.min(delay, 300000);
}

async function fetchPendingDeliveries(pool: Awaited<ReturnType<typeof getPool>>): Promise<WebhookDelivery[]> {
  const result = await pool.query(
    `SELECT id, channel_id, url, payload, status, attempts, max_attempts,
            next_retry_at, last_error, response_code, response_time_ms,
            created_at, delivered_at
     FROM webhook_deliveries
     WHERE status IN ('pending', 'retrying')
       AND (next_retry_at IS NULL OR next_retry_at <= NOW())
     ORDER BY created_at ASC
     LIMIT $1`,
    [BATCH_SIZE],
  );

  return result.rows.map((row) => ({
    id: row["id"] as string,
    channelId: row["channel_id"] as string,
    url: row["url"] as string,
    payload: typeof row["payload"] === "string"
      ? JSON.parse(row["payload"] as string) as WebhookPayload
      : (row["payload"] as WebhookPayload),
    status: row["status"] as WebhookDelivery["status"],
    attempts: row["attempts"] as number,
    maxAttempts: row["max_attempts"] as number,
    nextRetryAt: row["next_retry_at"] as string | null,
    lastError: row["last_error"] as string | null,
    responseCode: row["response_code"] as number | null,
    responseTimeMs: row["response_time_ms"] as number | null,
    createdAt: row["created_at"] as string,
    deliveredAt: row["delivered_at"] as string | null,
  }));
}

async function processDelivery(delivery: WebhookDelivery, pool: Awaited<ReturnType<typeof getPool>>): Promise<void> {
  const { id, url, payload } = delivery;
  const body = JSON.stringify(payload);

  // Resolve channel secret from notification_channels.config
  const channelResult = await pool.query(
    `SELECT config FROM notification_channels WHERE id = $1`,
    [delivery.channelId],
  );
  const channelConfig = channelResult.rows[0]?.["config"] as Record<string, unknown> | undefined;
  const secret = (channelConfig?.["secret"] as string) || "";

  const signature = signWebhookPayload(body, secret);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const start = Date.now();

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Egaop-Signature": signature,
        "X-Egaop-Timestamp": payload.timestamp,
      },
      body,
      signal: controller.signal,
    });

    const responseTimeMs = Date.now() - start;
    const responseCode = res.status;

    if (res.ok) {
      await pool.query(
        `UPDATE webhook_deliveries
         SET status = 'delivered',
             response_code = $2,
             response_time_ms = $3,
             delivered_at = NOW()
         WHERE id = $1`,
        [id, responseCode, responseTimeMs],
      );
      logger.info({ deliveryId: id, responseCode, responseTimeMs }, "Webhook delivered successfully");
    } else {
      await handleFailure(delivery, `HTTP ${responseCode}: ${res.statusText}`, pool);
    }
  } catch (err: unknown) {
    const responseTimeMs = Date.now() - start;
    const errorMsg = err instanceof Error ? err.message : String(err);
    await handleFailure(delivery, errorMsg, pool);
    logger.warn({ deliveryId: id, error: errorMsg, responseTimeMs }, "Webhook delivery attempt failed");
  } finally {
    clearTimeout(timeout);
  }
}

async function handleFailure(
  delivery: WebhookDelivery,
  error: string,
  pool: Awaited<ReturnType<typeof getPool>>,
): Promise<void> {
  const { id, attempts, maxAttempts } = delivery;
  const nextAttempt = attempts + 1;

  if (nextAttempt >= maxAttempts) {
    await pool.query(
      `UPDATE webhook_deliveries
       SET status = 'failed',
           attempts = $2,
           last_error = $3,
           next_retry_at = NULL
       WHERE id = $1`,
      [id, nextAttempt, error],
    );
    logger.error(
      { deliveryId: id, attempts: nextAttempt, error },
      "Webhook moved to dead-letter queue after max retries",
    );
  } else {
    const delay = computeRetryDelay(attempts);
    const nextRetryAt = new Date(Date.now() + delay).toISOString();
    await pool.query(
      `UPDATE webhook_deliveries
       SET status = 'retrying',
           attempts = $2,
           last_error = $3,
           next_retry_at = $4
       WHERE id = $1`,
      [id, nextAttempt, error, nextRetryAt],
    );
    logger.debug(
      { deliveryId: id, attempt: nextAttempt, maxAttempts, nextRetryAt },
      "Webhook scheduled for retry",
    );
  }
}

async function pollCycle(): Promise<void> {
  if (!running) return;

  try {
    const pool = await getPool();
    const deliveries = await fetchPendingDeliveries(pool);

    if (deliveries.length > 0) {
      logger.info({ count: deliveries.length }, "Processing pending webhook deliveries");
    }

    for (const delivery of deliveries) {
      if (!running) break;
      await processDelivery(delivery, pool);
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ error: msg }, "Webhook worker poll cycle error");
  }

  if (running) {
    timer = setTimeout(pollCycle, POLL_INTERVAL_MS);
  }
}

export function startWebhookWorker(): void {
  if (running) {
    logger.warn("Webhook worker is already running");
    return;
  }

  running = true;
  logger.info(
    { pollIntervalMs: POLL_INTERVAL_MS, batchSize: BATCH_SIZE, maxRetries: MAX_RETRIES },
    "Starting webhook delivery worker",
  );
  pollCycle();
}

export function stopWebhookWorker(): void {
  running = false;
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  logger.info("Webhook delivery worker stopped");
}

// Auto-start when run directly (not when imported)
if (process.argv[1] && process.argv[1].endsWith("webhook-worker.js")) {
  startWebhookWorker();

  process.on("SIGTERM", () => {
    logger.info("Received SIGTERM, shutting down webhook worker");
    stopWebhookWorker();
    process.exit(0);
  });

  process.on("SIGINT", () => {
    logger.info("Received SIGINT, shutting down webhook worker");
    stopWebhookWorker();
    process.exit(0);
  });
}
