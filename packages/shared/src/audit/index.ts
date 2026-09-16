import crypto from "crypto";
import { getPool } from "../db.js";

export type AuditEventType =
  | "auth.login"
  | "auth.logout"
  | "auth.token_refresh"
  | "auth.failed_login"
  | "policy.decision"
  | "policy.deny"
  | "secret.access"
  | "secret.create"
  | "secret.update"
  | "secret.delete"
  | "sandbox.create"
  | "sandbox.destroy"
  | "sandbox.exec"
  | "namespace.create"
  | "namespace.update"
  | "namespace.suspend"
  | "namespace.delete"
  | "agent.create"
  | "agent.execution_start"
  | "agent.execution_end"
  | "agent.tool_call"
  | "config.change"
  | "certificate.rotate"
  | "key.rotate";

export type AuditSeverity = "info" | "warn" | "error" | "critical";

export interface AuditActor {
  type: "user" | "service" | "agent" | "system";
  id: string;
  namespace?: string;
  authMethod?: "jwt" | "mtls" | "service_token" | "api_key";
  spiffeId?: string;
}

export interface AuditTarget {
  type: string;
  id: string;
  namespace?: string;
}

export interface AuditAction {
  name: string;
  parameters?: Record<string, unknown>;
  result: "allowed" | "denied" | "error" | "pending";
  reason?: string;
}

export interface AuditEntry {
  version: "egaop-audit/1.0";
  timestamp: string;
  eventId: string;
  eventType: AuditEventType;
  severity: AuditSeverity;
  actor: AuditActor;
  target?: AuditTarget;
  action: AuditAction;
  context: {
    requestId?: string;
    sessionId?: string;
    ipAddress?: string;
    userAgent?: string;
  };
  integrity: {
    previousHash: string;
    chainId: string;
  };
}

interface ChainState {
  entries: AuditEntry[];
  lastHash: string;
}

const chains = new Map<string, ChainState>();

function getChain(chainId: string): ChainState {
  let chain = chains.get(chainId);
  if (!chain) {
    chain = { entries: [], lastHash: "0000000000000000000000000000000000000000000000000000000000000000" };
    chains.set(chainId, chain);
  }
  return chain;
}

function hashEntry(entry: Omit<AuditEntry, "integrity">, previousHash: string): string {
  const data = JSON.stringify(entry) + previousHash;
  return crypto.createHash("sha256").update(data).digest("hex");
}

export function createAuditEntry(
  eventType: AuditEventType,
  severity: AuditSeverity,
  actor: AuditActor,
  action: AuditAction,
  target?: AuditTarget,
  context: Partial<AuditEntry["context"]> = {},
): AuditEntry {
  const chainId = process.env.AUDIT_CHAIN_ID || `egaop-${process.env.NODE_ENV || "development"}-${new Date().toISOString().slice(0, 10)}`;
  const chain = getChain(chainId);

  const eventId = crypto.randomUUID();
  const timestamp = new Date().toISOString();
  const previousHash = chain.lastHash;

  const entry: AuditEntry = {
    version: "egaop-audit/1.0",
    timestamp,
    eventId,
    eventType,
    severity,
    actor,
    target,
    action,
    context: {
      requestId: context.requestId,
      sessionId: context.sessionId,
      ipAddress: context.ipAddress,
      userAgent: context.userAgent,
    },
    integrity: {
      previousHash,
      chainId,
    },
  };

  entry.integrity.previousHash = hashEntry(
    { version: entry.version, timestamp, eventId, eventType, severity, actor, target, action, context: entry.context },
    previousHash,
  );

  chain.entries.push(entry);
  chain.lastHash = entry.integrity.previousHash;

  if (chain.entries.length > 10000) {
    chain.entries.splice(0, chain.entries.length - 10000);
  }

  const logEntry = JSON.stringify(entry);
  if (severity === "critical" || severity === "error") {
    process.stderr.write(logEntry + "\n");
  } else {
    process.stdout.write(logEntry + "\n");
  }

  // Persist to PostgreSQL (fire-and-forget with retry)
  if (process.env.NODE_ENV !== "test") {
    persistWithRetry(entry, 3).catch(() => {});
  }

  return entry;
}

// ── PostgreSQL persistence with exponential backoff ──────────────────────────

async function persistWithRetry(entry: AuditEntry, maxRetries: number): Promise<void> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      await persistToPostgres(entry);
      return; // success
    } catch (err: unknown) {
      if (attempt === maxRetries) {
        // All retries exhausted — log and give up
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(
          JSON.stringify({
            timestamp: new Date().toISOString(),
            level: "error",
            message: `Audit entry ${entry.eventId} failed after ${maxRetries + 1} attempts: ${message}`,
          }) + "\n",
        );
        return;
      }
      // Exponential backoff: 100ms, 200ms, 400ms
      const delay = Math.min(100 * Math.pow(2, attempt), 4000);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

async function persistToPostgres(entry: AuditEntry): Promise<void> {
  const pool = await getPool();
  await pool.query(
    `INSERT INTO audit_entries (event_id, event_type, severity, actor, target, action, context, integrity, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (event_id) DO NOTHING`,
    [
      entry.eventId,
      entry.eventType,
      entry.severity,
      JSON.stringify(entry.actor),
      entry.target ? JSON.stringify(entry.target) : null,
      JSON.stringify(entry.action),
      JSON.stringify(entry.context),
      JSON.stringify(entry.integrity),
      entry.timestamp,
    ],
  );
}

export function getAuditChain(chainId: string): AuditEntry[] {
  return getChain(chainId).entries;
}

export function verifyAuditChain(entries: AuditEntry[]): boolean {
  let previousHash = "0000000000000000000000000000000000000000000000000000000000000000";
  for (const entry of entries) {
    const { integrity, ...rest } = entry;
    const expectedHash = hashEntry(rest as Omit<AuditEntry, "integrity">, previousHash);
    if (integrity.previousHash !== expectedHash) return false;
    previousHash = integrity.previousHash;
  }
  return true;
}
