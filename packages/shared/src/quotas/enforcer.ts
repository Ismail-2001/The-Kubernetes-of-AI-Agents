import { QuotaExceededError } from "../errors/index.js";

export interface QuotaEnforcerConfig {
  redisUrl?: string;
  windowSeconds?: number;
}

interface QuotaCheckResult {
  allowed: boolean;
  current: number;
  limit: number;
  retryAfterMs: number;
}

export class QuotaEnforcer {
  private redisClient: unknown | null = null;
  private redisUrl: string;
  private windowSeconds: number;
  private fallbackCounts = new Map<string, { count: number; windowStart: number }>();

  constructor(config: QuotaEnforcerConfig = {}) {
    this.redisUrl = config.redisUrl ?? process.env.REDIS_URL ?? "redis://localhost:6379";
    this.windowSeconds = config.windowSeconds ?? 60;
  }

  private async getRedis(): Promise<unknown> {
    if (this.redisClient) return this.redisClient;

    try {
      const redis = await import("redis");
      const createClient = (redis as Record<string, unknown>).default ?? (redis as Record<string, unknown>).createClient;
      if (typeof createClient === "function") {
        const client = await (createClient as (opts: { url: string }) => Promise<unknown>)({
          url: this.redisUrl,
        });
        this.redisClient = client;
        return client;
      }
      return null;
    } catch {
      return null;
    }
  }

  private getFallbackKey(namespace: string, resource: string): string {
    return `${namespace}:${resource}`;
  }

  private checkFallback(namespace: string, resource: string, limit: number, isConcurrent: boolean): QuotaCheckResult {
    const key = this.getFallbackKey(namespace, resource);
    const now = Date.now();

    let entry = this.fallbackCounts.get(key);

    if (isConcurrent) {
      // For concurrent: just check current count without sliding window
      const current = entry?.count ?? 0;
      if (current >= limit) {
        return { allowed: false, current, limit, retryAfterMs: 1000 };
      }
      if (!entry) {
        entry = { count: 0, windowStart: now };
        this.fallbackCounts.set(key, entry);
      }
      entry.count++;
      return { allowed: true, current: entry.count, limit, retryAfterMs: 0 };
    }

    // For rate-based: sliding window
    const windowStart = now - this.windowSeconds * 1000;
    if (!entry || entry.windowStart < windowStart) {
      entry = { count: 0, windowStart: now };
      this.fallbackCounts.set(key, entry);
    }

    entry.count++;
    const current = entry.count;
    if (current <= limit) {
      return { allowed: true, current, limit, retryAfterMs: 0 };
    }

    // Undo the increment
    entry.count = Math.max(0, entry.count - 1);
    const retryAfterMs = (entry.windowStart + this.windowSeconds * 1000) - now;
    return { allowed: false, current: entry.count, limit, retryAfterMs: Math.max(0, retryAfterMs) };
  }

  private async checkRedis(
    namespace: string,
    resource: string,
    limit: number,
    isConcurrent: boolean
  ): Promise<QuotaCheckResult> {
    const client = (await this.getRedis()) as {
      incr: (key: string) => Promise<number>;
      decr: (key: string) => Promise<number>;
      expire: (key: string, seconds: number) => Promise<void>;
      ttl: (key: string) => Promise<number>;
      get: (key: string) => Promise<string | null>;
    } | null;

    if (!client) {
      return this.checkFallback(namespace, resource, limit, isConcurrent);
    }

    const key = `quota:${namespace}:${resource}`;

    if (isConcurrent) {
      // For concurrent executions: GET (read-only) first, INCR only if under limit
      const raw = await client.get(key);
      const current = raw ? parseInt(raw, 10) : 0;
      if (current >= limit) {
        const retryAfterMs = 1000; // poll every 1s for concurrency
        return { allowed: false, current, limit, retryAfterMs };
      }
      const newCurrent = await client.incr(key);
      await client.expire(key, 30);
      return { allowed: true, current: newCurrent, limit, retryAfterMs: 0 };
    }

    // For rate-based resources: INCR, then DECR on failure to avoid ballooning
    const current = await client.incr(key);
    await client.expire(key, this.windowSeconds);

    if (current <= limit) {
      return { allowed: true, current, limit, retryAfterMs: 0 };
    }

    // Undo the increment since the limit was exceeded
    await client.decr(key);
    const retryAfterMs = this.windowSeconds * 1000;
    return { allowed: false, current: current - 1, limit, retryAfterMs };
  }

  async check(namespace: string, resource: string, amount: number = 1): Promise<void> {
    const limits = await this.getLimits(namespace);
    const limit = limits[resource];

    if (limit === undefined) {
      return;
    }

    const isConcurrent = resource === "concurrent_executions";
    const result = await this.checkRedis(namespace, resource, limit * amount, isConcurrent);

    if (!result.allowed) {
      throw new QuotaExceededError({
        namespace,
        resource,
        limit: result.limit,
        current: result.current,
        retryAfterMs: result.retryAfterMs,
      });
    }
  }

  async getLimits(namespace: string): Promise<Record<string, number>> {
    return {
      agents: this.getTierLimit(namespace, "maxAgents"),
      concurrent_executions: this.getTierLimit(namespace, "maxConcurrentExecutions"),
      tool_calls_per_minute: this.getTierLimit(namespace, "maxToolCallsPerMinute"),
    };
  }

  private getTierLimit(_namespace: string, resource: string): number {
    const defaults: Record<string, number> = {
      maxAgents: 5,
      maxConcurrentExecutions: 2,
      maxMemoryMB: 512,
      maxToolCallsPerMinute: 30,
    };
    return defaults[resource] ?? 100;
  }

  async reset(namespace: string, resource: string): Promise<void> {
    const client = (await this.getRedis()) as { del: (key: string) => Promise<number>; decr: (key: string) => Promise<number> } | null;
    if (client) {
      await client.del(`quota:${namespace}:${resource}`);
    } else {
      this.fallbackCounts.delete(this.getFallbackKey(namespace, resource));
    }
  }

  async release(namespace: string, resource: string, amount: number = 1): Promise<void> {
    const client = (await this.getRedis()) as { decr: (key: string) => Promise<number> } | null;
    const key = `quota:${namespace}:${resource}`;
    if (client) {
      for (let i = 0; i < amount; i++) {
        await client.decr(key);
      }
    } else {
      const fKey = this.getFallbackKey(namespace, resource);
      const entry = this.fallbackCounts.get(fKey);
      if (entry) {
        entry.count = Math.max(0, entry.count - amount);
      }
    }
  }

  async shutdown(): Promise<void> {
    const client = (await this.getRedis()) as { quit: () => Promise<void> } | null;
    if (client) {
      await client.quit();
      this.redisClient = null;
    }
  }
}
