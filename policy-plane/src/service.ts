import http from "http";
import crypto from "crypto";
import { trace, SpanStatusCode } from "@opentelemetry/api";

const tracer = trace.getTracer("egaop-policy-plane", "1.0.0");

// ─── Types ────────────────────────────────────────────────────────────────

interface PolicyInput {
  subject: {
    namespace: string;
    clearance: number;
    [key: string]: unknown;
  };
  action: string;
  resource: {
    namespace: string;
    pii_detected?: boolean;
    [key: string]: unknown;
  };
  namespace: string;
  agentId: string;
  claims: Record<string, unknown>;
}

interface PolicyDecision {
  allow: boolean;
  reason: string;
}

interface CacheEntry {
  decision: PolicyDecision;
  expiresAt: number;
}

// ─── Circuit Breaker ──────────────────────────────────────────────────────

enum CircuitState {
  Closed = "CLOSED",
  Open = "OPEN",
  HalfOpen = "HALF_OPEN",
}

class CircuitBreaker {
  private state: CircuitState = CircuitState.Closed;
  private failureCount = 0;
  private lastFailureTime = 0;
  private readonly failureThreshold: number;
  private readonly recoveryTimeMs: number;

  constructor(failureThreshold?: number, recoveryTimeMs?: number) {
    this.failureThreshold = failureThreshold ?? parseInt(process.env.OPA_CIRCUIT_BREAKER_THRESHOLD || "5", 10);
    this.recoveryTimeMs = recoveryTimeMs ?? parseInt(process.env.OPA_CIRCUIT_BREAKER_RECOVERY_MS || "30000", 10);
  }

  recordFailure(): void {
    this.failureCount++;
    this.lastFailureTime = Date.now();
    if (this.failureCount >= this.failureThreshold) {
      this.state = CircuitState.Open;
    }
  }

  recordSuccess(): void {
    this.failureCount = 0;
    this.state = CircuitState.Closed;
  }

  canExecute(): boolean {
    if (this.state === CircuitState.Closed) return true;
    if (this.state === CircuitState.HalfOpen) return true;
    if (this.state === CircuitState.Open) {
      if (Date.now() - this.lastFailureTime >= this.recoveryTimeMs) {
        this.state = CircuitState.HalfOpen;
        return true;
      }
      return false;
    }
    return false;
  }

  getState(): CircuitState {
    return this.state;
  }
}

// ─── LRU Cache ────────────────────────────────────────────────────────────

class LRUCache {
  private readonly store = new Map<string, CacheEntry>();
  private readonly maxSize: number;
  private readonly ttlMs: number;
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(maxSize?: number, ttlMs?: number) {
    this.maxSize = maxSize ?? parseInt(process.env.OPA_CACHE_MAX_SIZE || "500", 10);
    this.ttlMs = ttlMs ?? parseInt(process.env.OPA_CACHE_TTL_MS || "30000", 10);
    const cleanupIntervalMs = Math.max(this.ttlMs, 5000);
    this.cleanupTimer = setInterval(() => this.evictExpired(), cleanupIntervalMs);
    if (this.cleanupTimer && typeof this.cleanupTimer === "object" && "unref" in this.cleanupTimer) {
      this.cleanupTimer.unref();
    }
  }

  get(key: string): PolicyDecision | null {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return null;
    }
    return entry.decision;
  }

  set(key: string, decision: PolicyDecision): void {
    if (this.store.size >= this.maxSize) {
      const oldestKey = this.store.keys().next().value;
      if (oldestKey !== undefined) {
        this.store.delete(oldestKey);
      }
    }
    this.store.set(key, { decision, expiresAt: Date.now() + this.ttlMs });
  }

  private evictExpired(): void {
    const now = Date.now();
    for (const [key, entry] of this.store) {
      if (now > entry.expiresAt) {
        this.store.delete(key);
      }
    }
  }

  dispose(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    this.store.clear();
  }

  get size(): number {
    return this.store.size;
  }
}

// ─── Logger ────────────────────────────────────────────────────────────────

interface LogEntry {
  timestamp: string;
  level: string;
  subject: string;
  action: string;
  resource: string;
  reason: string;
  agentId?: string;
  namespace?: string;
}

function logDeny(entry: LogEntry): void {
  if (process.env.NODE_ENV !== "test") {
    process.stderr.write(JSON.stringify({ ...entry, level: "denied" }) + "\n");
  }
}

function logInfo(message: string, context?: Record<string, unknown>): void {
  if (process.env.NODE_ENV !== "test") {
    const entry = { timestamp: new Date().toISOString(), level: "info", message, ...context };
    process.stdout.write(JSON.stringify(entry) + "\n");
  }
}

// ─── Hashing ───────────────────────────────────────────────────────────────

function hashInput(input: PolicyInput): string {
  const canonical = JSON.stringify(input, Object.keys(input).sort());
  return crypto.createHash("sha256").update(canonical).digest("hex");
}

// ─── OPA HTTP Client ──────────────────────────────────────────────────────

function postJSON(
  url: string,
  body: unknown,
  timeoutMs: number
): Promise<{ status: number; data: unknown }> {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const data = JSON.stringify(body);

    const req = http.request(
      {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port,
        path: parsedUrl.pathname,
        method: "POST",
        timeout: timeoutMs,
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(data),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          try {
            resolve({ status: res.statusCode ?? 0, data: JSON.parse(raw) });
          } catch {
            reject(new Error(`OPA returned invalid JSON: ${raw.substring(0, 200)}`));
          }
        });
      }
    );

    req.on("timeout", () => {
      req.destroy();
      reject(new Error("OPA request timed out"));
    });

    req.on("error", (err: Error) => {
      reject(err);
    });

    req.write(data);
    req.end();
  });
}

// ─── PolicyPlaneService ────────────────────────────────────────────────────

class PolicyPlaneService {
  private readonly opaUrl: string;
  private readonly opaTimeoutMs: number;
  private readonly circuitBreaker: CircuitBreaker;
  private readonly cache: LRUCache;
  private static instance: PolicyPlaneService | null = null;

  private constructor() {
    this.opaUrl = process.env.OPA_URL || "http://localhost:8181";
    this.opaTimeoutMs = parseInt(process.env.OPA_TIMEOUT_MS || "200", 10);
    this.circuitBreaker = new CircuitBreaker();
    this.cache = new LRUCache();
  }

  static getInstance(): PolicyPlaneService {
    if (!PolicyPlaneService.instance) {
      PolicyPlaneService.instance = new PolicyPlaneService();
    }
    return PolicyPlaneService.instance;
  }

  static resetInstance(): void {
    if (PolicyPlaneService.instance) {
      PolicyPlaneService.instance.cache.dispose();
      PolicyPlaneService.instance = null;
    }
  }

  async evaluatePolicy(
    policyPath: string,
    input: PolicyInput
  ): Promise<PolicyDecision> {
    return tracer.startActiveSpan("opa.evaluate", async (span) => {
      try {
        span.setAttribute("opa.policy_path", policyPath);
        span.setAttribute("opa.agent_id", input.agentId);
        span.setAttribute("opa.action", input.action);

        // Circuit breaker check
        if (!this.circuitBreaker.canExecute()) {
          const reason = `Circuit breaker OPEN — OPA unreachable after ${this.circuitBreaker.getState()}`;
          span.setAttribute("opa.decision", "deny");
          span.setAttribute("opa.reason", reason);
          span.setStatus({ code: SpanStatusCode.OK });
          logDeny({
            timestamp: new Date().toISOString(),
            level: "denied",
            subject: input.subject.namespace,
            action: input.action,
            resource: input.resource.namespace,
            reason,
            agentId: input.agentId,
            namespace: input.namespace,
          });
          return { allow: false, reason };
        }

        // Cache check
        const cacheKey = hashInput(input);
        const cached = this.cache.get(cacheKey);
        if (cached) {
          span.setAttribute("opa.cache_hit", true);
          span.setAttribute("opa.decision", cached.allow ? "allow" : "deny");
          span.setStatus({ code: SpanStatusCode.OK });
          return cached;
        }

        span.setAttribute("opa.cache_hit", false);

        // Call OPA
        const url = `${this.opaUrl}/v1/data/${policyPath}`;
        const response = await postJSON(url, { input }, this.opaTimeoutMs);

        if (response.status < 200 || response.status >= 300) {
          throw new Error(`OPA returned HTTP ${response.status}`);
        }

        const result = response.data as Record<string, unknown>;
        const resultObj = result["result"] as Record<string, unknown> | undefined;
        const allow = resultObj?.["allow"] === true;
        const reason = allow ? "" : (resultObj?.["reason"] as string) ?? "Policy denied by OPA";

        const decision: PolicyDecision = { allow, reason };

        // Record success
        this.circuitBreaker.recordSuccess();

        // Cache the decision
        this.cache.set(cacheKey, decision);

        span.setAttribute("opa.decision", allow ? "allow" : "deny");
        if (!allow) {
          span.setAttribute("opa.reason", reason);
        }
        span.setStatus({ code: SpanStatusCode.OK });

        if (!allow) {
          logDeny({
            timestamp: new Date().toISOString(),
            level: "denied",
            subject: input.subject.namespace,
            action: input.action,
            resource: input.resource.namespace,
            reason,
            agentId: input.agentId,
            namespace: input.namespace,
          });
        }

        logInfo("OPA evaluation complete", {
          policyPath,
          allow,
          agentId: input.agentId,
          action: input.action,
        });

        return decision;
      } catch (err: unknown) {
        this.circuitBreaker.recordFailure();

        const errorMessage = err instanceof Error ? err.message : String(err);
        const reason = `OPA call failed: ${errorMessage}`;

        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: reason,
        });
        span.setAttribute("opa.decision", "deny");
        span.setAttribute("opa.reason", reason);

        logDeny({
          timestamp: new Date().toISOString(),
          level: "denied",
          subject: input.subject.namespace,
          action: input.action,
          resource: input.resource.namespace,
          reason,
          agentId: input.agentId,
          namespace: input.namespace,
        });

        // Fail-closed: DENY on any error
        return { allow: false, reason };
      } finally {
        span.end();
      }
    });
  }

  getStats(): { circuitState: string; cacheSize: number } {
    return {
      circuitState: this.circuitBreaker.getState(),
      cacheSize: this.cache.size,
    };
  }
}

export {
  PolicyPlaneService,
  CircuitBreaker,
  LRUCache,
  hashInput,
  postJSON,
  logDeny,
  logInfo,
};

export type { PolicyInput, PolicyDecision };
