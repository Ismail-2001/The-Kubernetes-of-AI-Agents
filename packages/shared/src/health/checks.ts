import type { DependencyCheck } from "./contract.js";

/**
 * Standard dependency check helpers.
 * Each returns a DependencyCheck with name, status, and latency.
 *
 * Usage in a service's health handler:
 *   const checks = await Promise.all([
 *     checkPostgres(pool),
 *     checkRedis(redis),
 *     checkGrpc("temporal", temporalAddress, 2000),
 *   ]);
 */

export async function checkPostgres(
  queryFn: () => Promise<unknown>,
  timeoutMs = 3000,
): Promise<DependencyCheck> {
  const start = Date.now();
  try {
    await Promise.race([
      queryFn(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("timeout")), timeoutMs),
      ),
    ]);
    return {
      name: "postgres",
      status: "healthy",
      latency_ms: Date.now() - start,
    };
  } catch (err) {
    return {
      name: "postgres",
      status: "unhealthy",
      latency_ms: Date.now() - start,
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function checkRedis(
  pingFn: () => Promise<unknown>,
  timeoutMs = 3000,
): Promise<DependencyCheck> {
  const start = Date.now();
  try {
    await Promise.race([
      pingFn(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("timeout")), timeoutMs),
      ),
    ]);
    return {
      name: "redis",
      status: "healthy",
      latency_ms: Date.now() - start,
    };
  } catch (err) {
    return {
      name: "redis",
      status: "unhealthy",
      latency_ms: Date.now() - start,
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Check a TCP-reachable dependency (Temporal, OPA, etc.)
 * Uses raw net.connect to avoid importing gRPC just for health checks.
 */
export async function checkGrpc(
  name: string,
  address: string,
  timeoutMs = 2000,
): Promise<DependencyCheck> {
  const start = Date.now();
  try {
    const { default: net } = await import("net");
    await new Promise<void>((resolve, reject) => {
      const socket = net.createConnection(
        { host: address.split(":")[0], port: parseInt(address.split(":")[1] || "443", 10) },
        () => { socket.destroy(); resolve(); },
      );
      socket.setTimeout(timeoutMs);
      socket.on("timeout", () => { socket.destroy(); reject(new Error("timeout")); });
      socket.on("error", (err) => { socket.destroy(); reject(err); });
    });
    return {
      name,
      status: "healthy",
      latency_ms: Date.now() - start,
    };
  } catch (err) {
    return {
      name,
      status: "unhealthy",
      latency_ms: Date.now() - start,
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Mark a dependency as skipped (optional, not available).
 */
export function checkSkipped(name: string, reason: string): DependencyCheck {
  return { name, status: "skipped", message: reason };
}
