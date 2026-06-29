/**
 * E-GAOP Sliding-Window Rate Limiter
 *
 * Per-agent in-memory rate limiter using a sliding window log.
 * Each agent gets a bucket of timestamps; expired entries are pruned
 * on every check and via a periodic cleanup interval.
 *
 * Env vars:
 *   RATE_LIMIT_RPM           Max requests per minute per agent (default: 60)
 *   RATE_LIMIT_WINDOW_MS     Window in milliseconds (default: 60000)
 *   RATE_LIMIT_CLEANUP_MS    Cleanup interval (default: 60000)
 *
 * Canonical implementation. Each service inlines the same RateLimiter class.
 */

import pino from "pino";

const logger = pino({ level: process.env.LOG_LEVEL || "info" });

export class RateLimiter {
  private readonly buckets = new Map<string, number[]>();
  private readonly maxRequests: number;
  private readonly windowMs: number;
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(maxRequests?: number, windowMs?: number) {
    this.maxRequests = maxRequests ?? parseInt(process.env.RATE_LIMIT_RPM || "60", 10);
    this.windowMs = windowMs ?? parseInt(process.env.RATE_LIMIT_WINDOW_MS || "60000", 10);
    const cleanupMs = parseInt(process.env.RATE_LIMIT_CLEANUP_MS || "60000", 10);
    this.cleanupTimer = setInterval(() => this.cleanup(), cleanupMs);
    if (this.cleanupTimer && typeof this.cleanupTimer === "object" && "unref" in this.cleanupTimer) {
      this.cleanupTimer.unref();
    }
  }

  check(key: string): { allowed: boolean; retryAfterMs: number } {
    const now = Date.now();
    const cutoff = now - this.windowMs;
    let timestamps = this.buckets.get(key);
    if (!timestamps) {
      timestamps = [];
      this.buckets.set(key, timestamps);
    }
    const active = timestamps.filter((t) => t > cutoff);
    this.buckets.set(key, active);
    if (active.length >= this.maxRequests) {
      const oldest = active[0]!;
      const retryAfterMs = oldest + this.windowMs - now;
      logger.warn({ key, retryAfterMs }, "Rate limit exceeded");
      return { allowed: false, retryAfterMs: Math.max(1, retryAfterMs) };
    }
    active.push(now);
    return { allowed: true, retryAfterMs: 0 };
  }

  private cleanup(): void {
    const now = Date.now();
    const cutoff = now - this.windowMs;
    for (const [key, timestamps] of this.buckets) {
      const active = timestamps.filter((t) => t > cutoff);
      if (active.length === 0) {
        this.buckets.delete(key);
      } else {
        this.buckets.set(key, active);
      }
    }
  }

  dispose(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    this.buckets.clear();
  }
}
