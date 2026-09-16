import crypto from "crypto";
import { getPool } from "../db.js";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface WebhookPayload {
  event: string;
  timestamp: string;
  data: Record<string, unknown>;
  metadata?: Record<string, string>;
}

export interface WebhookDelivery {
  id: string;
  channelId: string;
  url: string;
  payload: WebhookPayload;
  status: "pending" | "delivered" | "failed" | "retrying";
  attempts: number;
  maxAttempts: number;
  nextRetryAt: string | null;
  lastError: string | null;
  responseCode: number | null;
  responseTimeMs: number | null;
  createdAt: string;
  deliveredAt: string | null;
}

export interface WebhookConfig {
  maxRetries: number;
  retryDelayMs: number;
  maxRetryDelayMs: number;
  timeoutMs: number;
  signatureHeader: string;
  timestampHeader: string;
}

const DEFAULT_CONFIG: WebhookConfig = {
  maxRetries: 5,
  retryDelayMs: 1000,
  maxRetryDelayMs: 300000,
  timeoutMs: 10000,
  signatureHeader: "X-Egaop-Signature",
  timestampHeader: "X-Egaop-Timestamp",
};

// ─── Signing ────────────────────────────────────────────────────────────────

export function signWebhookPayload(payload: string, secret: string): string {
  return crypto.createHmac("sha256", secret).update(payload, "utf8").digest("hex");
}

export function verifyWebhookSignature(payload: string, signature: string, secret: string): boolean {
  const expected = signWebhookPayload(payload, secret);
  const sigBuf = Buffer.from(signature, "hex");
  const expectedBuf = Buffer.from(expected, "hex");
  if (sigBuf.length !== expectedBuf.length) return false;
  return crypto.timingSafeEqual(sigBuf, expectedBuf);
}

// ─── Delivery ───────────────────────────────────────────────────────────────

function generateId(): string {
  return `whd_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
}

function mergeConfig(partial?: Partial<WebhookConfig>): WebhookConfig {
  return { ...DEFAULT_CONFIG, ...partial };
}

function computeRetryDelay(attempt: number, config: WebhookConfig): number {
  const delay = config.retryDelayMs * Math.pow(2, attempt);
  return Math.min(delay, config.maxRetryDelayMs);
}

export async function deliverWebhook(
  url: string,
  payload: WebhookPayload,
  secret: string,
  config?: Partial<WebhookConfig>,
): Promise<WebhookDelivery> {
  const cfg = mergeConfig(config);
  const body = JSON.stringify(payload);
  const signature = signWebhookPayload(body, secret);
  const timestamp = payload.timestamp;

  const delivery: WebhookDelivery = {
    id: generateId(),
    channelId: "",
    url,
    payload,
    status: "pending",
    attempts: 0,
    maxAttempts: cfg.maxRetries,
    nextRetryAt: null,
    lastError: null,
    responseCode: null,
    responseTimeMs: null,
    createdAt: new Date().toISOString(),
    deliveredAt: null,
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);

  const start = Date.now();
  try {
    delivery.attempts++;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        [cfg.signatureHeader]: signature,
        [cfg.timestampHeader]: timestamp,
      },
      body,
      signal: controller.signal,
    });

    delivery.responseCode = res.status;
    delivery.responseTimeMs = Date.now() - start;

    if (res.ok) {
      delivery.status = "delivered";
      delivery.deliveredAt = new Date().toISOString();
    } else {
      delivery.status = "failed";
      delivery.lastError = `HTTP ${res.status}: ${res.statusText}`;
    }
  } catch (err: unknown) {
    delivery.responseTimeMs = Date.now() - start;
    delivery.status = "failed";
    delivery.lastError = err instanceof Error ? err.message : String(err);
  } finally {
    clearTimeout(timer);
  }

  return delivery;
}

export async function deliverWithRetry(
  url: string,
  payload: WebhookPayload,
  secret: string,
  config?: Partial<WebhookConfig>,
): Promise<WebhookDelivery> {
  const cfg = mergeConfig(config);
  const body = JSON.stringify(payload);
  const signature = signWebhookPayload(body, secret);
  const timestamp = payload.timestamp;

  const delivery: WebhookDelivery = {
    id: generateId(),
    channelId: "",
    url,
    payload,
    status: "pending",
    attempts: 0,
    maxAttempts: cfg.maxRetries,
    nextRetryAt: null,
    lastError: null,
    responseCode: null,
    responseTimeMs: null,
    createdAt: new Date().toISOString(),
    deliveredAt: null,
  };

  for (let attempt = 0; attempt <= cfg.maxRetries; attempt++) {
    delivery.attempts = attempt + 1;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
    const start = Date.now();

    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          [cfg.signatureHeader]: signature,
          [cfg.timestampHeader]: timestamp,
        },
        body,
        signal: controller.signal,
      });

      delivery.responseCode = res.status;
      delivery.responseTimeMs = Date.now() - start;

      if (res.ok) {
        delivery.status = "delivered";
        delivery.deliveredAt = new Date().toISOString();
        delivery.nextRetryAt = null;
        return delivery;
      }

      delivery.lastError = `HTTP ${res.status}: ${res.statusText}`;

      if (res.status >= 400 && res.status < 500) {
        delivery.status = "failed";
        delivery.nextRetryAt = null;
        return delivery;
      }
    } catch (err: unknown) {
      delivery.responseTimeMs = Date.now() - start;
      delivery.lastError = err instanceof Error ? err.message : String(err);
    } finally {
      clearTimeout(timer);
    }

    if (attempt < cfg.maxRetries) {
      delivery.status = "retrying";
      const delay = computeRetryDelay(attempt, cfg);
      delivery.nextRetryAt = new Date(Date.now() + delay).toISOString();
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  delivery.status = "failed";
  delivery.nextRetryAt = null;
  return delivery;
}

export async function batchDeliver(
  payload: WebhookPayload,
  channels: Array<{ url: string; secret: string }>,
  config?: Partial<WebhookConfig>,
): Promise<WebhookDelivery[]> {
  return Promise.all(
    channels.map((ch) => deliverWithRetry(ch.url, payload, ch.secret, config)),
  );
}

// ─── Persistence ────────────────────────────────────────────────────────────

export async function storeDelivery(delivery: WebhookDelivery): Promise<void> {
  const pool = await getPool();
  await pool.query(
    `INSERT INTO webhook_deliveries
       (id, channel_id, url, payload, status, attempts, max_attempts,
        next_retry_at, last_error, response_code, response_time_ms,
        created_at, delivered_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     ON CONFLICT (id) DO UPDATE SET
       status = EXCLUDED.status,
       attempts = EXCLUDED.attempts,
       next_retry_at = EXCLUDED.next_retry_at,
       last_error = EXCLUDED.last_error,
       response_code = EXCLUDED.response_code,
       response_time_ms = EXCLUDED.response_time_ms,
       delivered_at = EXCLUDED.delivered_at`,
    [
      delivery.id,
      delivery.channelId,
      delivery.url,
      JSON.stringify(delivery.payload),
      delivery.status,
      delivery.attempts,
      delivery.maxAttempts,
      delivery.nextRetryAt,
      delivery.lastError,
      delivery.responseCode,
      delivery.responseTimeMs,
      delivery.createdAt,
      delivery.deliveredAt,
    ],
  );
}

export async function getDeliveryStats(
  channelId: string,
): Promise<{ delivered: number; failed: number; pending: number }> {
  const pool = await getPool();
  const result = await pool.query(
    `SELECT
       COUNT(*) FILTER (WHERE status = 'delivered') AS delivered,
       COUNT(*) FILTER (WHERE status = 'failed')   AS failed,
       COUNT(*) FILTER (WHERE status IN ('pending', 'retrying')) AS pending
     FROM webhook_deliveries
     WHERE channel_id = $1`,
    [channelId],
  );

  const row = result.rows[0];
  return {
    delivered: parseInt(row?.["delivered"] ?? "0", 10),
    failed: parseInt(row?.["failed"] ?? "0", 10),
    pending: parseInt(row?.["pending"] ?? "0", 10),
  };
}

export async function getDeadLetters(
  channelId: string,
  limit: number = 50,
): Promise<WebhookDelivery[]> {
  const pool = await getPool();
  const result = await pool.query(
    `SELECT id, channel_id, url, payload, status, attempts, max_attempts,
            next_retry_at, last_error, response_code, response_time_ms,
            created_at, delivered_at
     FROM webhook_deliveries
     WHERE channel_id = $1 AND status = 'failed'
     ORDER BY created_at DESC
     LIMIT $2`,
    [channelId, limit],
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
