/**
 * Health/Readiness Contract for E-GAOP Services
 *
 * Every service MUST implement this contract. Kubernetes probes hit /healthz
 * (liveness) and /readyz (readiness). The semantics are strict:
 *
 *   LIVENESS  (/healthz)  → Is the process alive and not deadlocked?
 *                           Return 200 if the event loop is responsive.
 *                           Return 503 only if the process is fundamentally broken
 *                           and a restart is the only recovery path.
 *
 *   READINESS (/readyz)   → Can this service accept and process traffic RIGHT NOW?
 *                           Return 200 only if all REQUIRED dependencies are reachable.
 *                           Return 503 if the service cannot fulfill its core contract.
 *
 *   DEGRADED  (internal)  → The service is alive and partially functional, but cannot
 *                           serve its full feature set. Readiness depends on whether
 *                           the degraded capabilities still satisfy upstream consumers.
 *
 * RULES:
 *   1. Liveness must NEVER check external dependencies. A flaky Postgres connection
 *      is NOT a reason to restart the process — it's a reason to return 503 on readiness.
 *   2. Readiness must check ALL dependencies that are required to serve the primary API.
 *      If a dependency is optional (e.g. OTel collector), do NOT include it in readiness.
 *   3. The "checks" field must list every dependency checked, with status and latency.
 *   4. Use HealthStatus enum, not raw strings.
 */

export enum HealthStatus {
  SERVING = "SERVING",
  DEGRADED = "DEGRADED",
  NOT_SERVING = "NOT_SERVING",
}

export interface DependencyCheck {
  name: string;
  status: "healthy" | "unhealthy" | "skipped";
  latency_ms?: number;
  message?: string;
}

export interface HealthResponse {
  /** Current health status */
  status: HealthStatus;
  /** Service name (e.g. "api-server", "workflow-engine") */
  service: string;
  /** Semver or build version */
  version: string;
  /** Uptime in seconds since last start */
  uptime_s: number;
  /** ISO-8601 timestamp of this response */
  timestamp: string;
  /** Individual dependency checks */
  checks: DependencyCheck[];
  /** True if running in degraded mode (missing optional dependencies) */
  degraded: boolean;
  /** Human-readable summary of why degraded or NOT_SERVING */
  reason?: string;
}

/**
 * Helper to build a standard health response.
 */
export function buildHealthResponse(
  service: string,
  version: string,
  startTime: Date,
  checks: DependencyCheck[],
): HealthResponse {
  const degraded = checks.some(c => c.status === "skipped" || c.status === "unhealthy");
  const allRequiredHealthy = checks
    .filter(c => c.status !== "skipped")
    .every(c => c.status === "healthy");

  const status = allRequiredHealthy
    ? degraded
      ? HealthStatus.DEGRADED
      : HealthStatus.SERVING
    : HealthStatus.NOT_SERVING;

  const failedChecks = checks.filter(c => c.status === "unhealthy");
  const reason = failedChecks.length > 0
    ? `Unhealthy dependencies: ${failedChecks.map(c => c.name).join(", ")}`
    : degraded
      ? `Degraded: ${checks.filter(c => c.status === "skipped").map(c => c.name).join(", ")} unavailable`
      : undefined;

  return {
    status,
    service,
    version,
    uptime_s: Math.floor((Date.now() - startTime.getTime()) / 1000),
    timestamp: new Date().toISOString(),
    checks,
    degraded,
    reason,
  };
}

/**
 * Map HealthResponse to HTTP status code.
 *   SERVING     → 200
 *   DEGRADED    → 200 (service is functional, just not fully)
 *   NOT_SERVING → 503
 */
export function healthToHttpStatus(status: HealthStatus): number {
  return status === HealthStatus.NOT_SERVING ? 503 : 200;
}
