import { status as grpcStatus } from "@grpc/grpc-js";

// ── RFC 7807 Problem Details ────────────────────────────────────────────────
// https://www.rfc-editor.org/rfc/rfc7807

export interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  detail: string;
  instance: string;
  traceId: string;
  [key: string]: unknown;
}

const ERROR_TYPE_MAP: Record<string, string> = {
  UNAUTHORIZED: "https://api.egaop.io/errors/unauthorized",
  INVALID_CREDENTIALS: "https://api.egaop.io/errors/invalid-credentials",
  NOT_FOUND: "https://api.egaop.io/errors/not-found",
  CONFLICT: "https://api.egaop.io/errors/conflict",
  VALIDATION_ERROR: "https://api.egaop.io/errors/validation",
  FORBIDDEN: "https://api.egaop.io/errors/forbidden",
  RATE_LIMITED: "https://api.egaop.io/errors/rate-limited",
  INTERNAL: "https://api.egaop.io/errors/internal",
  POLICY_DENIED: "https://api.egaop.io/errors/policy-denied",
  TIMEOUT: "https://api.egaop.io/errors/timeout",
  QUOTA_EXCEEDED: "https://api.egaop.io/errors/quota-exceeded",
  ACCOUNT_LOCKED: "https://api.egaop.io/errors/account-locked",
};

const ERROR_TITLE_MAP: Record<string, string> = {
  UNAUTHORIZED: "Unauthorized",
  INVALID_CREDENTIALS: "Invalid Credentials",
  NOT_FOUND: "Not Found",
  CONFLICT: "Conflict",
  VALIDATION_ERROR: "Validation Error",
  FORBIDDEN: "Forbidden",
  RATE_LIMITED: "Rate Limited",
  INTERNAL: "Internal Server Error",
  POLICY_DENIED: "Policy Denied",
  TIMEOUT: "Request Timeout",
  QUOTA_EXCEEDED: "Quota Exceeded",
  ACCOUNT_LOCKED: "Account Locked",
};

const ERROR_STATUS_MAP: Record<string, number> = {
  UNAUTHORIZED: 401,
  INVALID_CREDENTIALS: 401,
  NOT_FOUND: 404,
  CONFLICT: 409,
  VALIDATION_ERROR: 400,
  FORBIDDEN: 403,
  RATE_LIMITED: 429,
  INTERNAL: 500,
  POLICY_DENIED: 403,
  TIMEOUT: 504,
  QUOTA_EXCEEDED: 429,
  ACCOUNT_LOCKED: 429,
};

export function toProblemDetails(
  code: string,
  detail: string,
  instance: string,
  traceId: string,
  extra?: Record<string, unknown>,
): ProblemDetails {
  return {
    type: ERROR_TYPE_MAP[code] ?? "https://api.egaop.io/errors/internal",
    title: ERROR_TITLE_MAP[code] ?? "Internal Server Error",
    status: ERROR_STATUS_MAP[code] ?? 500,
    detail,
    instance,
    traceId,
    ...extra,
  };
}

export class AgentError extends Error {
  public readonly code: string;
  public readonly namespace: string;
  public readonly agentId: string;
  public readonly traceId: string;

  constructor(
    message: string,
    opts: { code: string; namespace: string; agentId: string; traceId: string }
  ) {
    super(message);
    this.name = "AgentError";
    this.code = opts.code;
    this.namespace = opts.namespace;
    this.agentId = opts.agentId;
    this.traceId = opts.traceId;
  }
}

export class PolicyDeniedError extends AgentError {
  constructor(message: string, opts: { namespace: string; agentId: string; traceId: string }) {
    super(message, { code: "POLICY_DENIED", ...opts });
    this.name = "PolicyDeniedError";
  }
}

export class PersistenceError extends AgentError {
  constructor(message: string, opts: { namespace: string; agentId: string; traceId: string }) {
    super(message, { code: "PERSISTENCE_ERROR", ...opts });
    this.name = "PersistenceError";
  }
}

export class TimeoutError extends AgentError {
  constructor(message: string, opts: { namespace: string; agentId: string; traceId: string }) {
    super(message, { code: "TIMEOUT", ...opts });
    this.name = "TimeoutError";
  }
}

export class NamespaceNotFoundError extends Error {
  public readonly namespace: string;

  constructor(namespace: string) {
    super(`Namespace not found: ${namespace}`);
    this.name = "NamespaceNotFoundError";
    this.namespace = namespace;
  }
}

export class NamespaceSuspendedError extends Error {
  public readonly namespace: string;

  constructor(namespace: string) {
    super(`Namespace is suspended: ${namespace}`);
    this.name = "NamespaceSuspendedError";
    this.namespace = namespace;
  }
}

export class CrossNamespaceError extends Error {
  public readonly callerNamespace: string;
  public readonly targetNamespace: string;
  public readonly callerRole: string;

  constructor(callerNamespace: string, targetNamespace: string, callerRole: string) {
    super(
      `Cross-namespace operation denied: caller in '${callerNamespace}' cannot access '${targetNamespace}' (role: ${callerRole})`
    );
    this.name = "CrossNamespaceError";
    this.callerNamespace = callerNamespace;
    this.targetNamespace = targetNamespace;
    this.callerRole = callerRole;
  }
}

export class QuotaExceededError extends Error {
  public readonly namespace: string;
  public readonly resource: string;
  public readonly limit: number;
  public readonly current: number;
  public readonly retryAfterMs: number;

  constructor(opts: {
    namespace: string;
    resource: string;
    limit: number;
    current: number;
    retryAfterMs?: number;
  }) {
    super(
      `Quota exceeded for namespace '${opts.namespace}': ${opts.resource} limit ${opts.limit} (current: ${opts.current})`
    );
    this.name = "QuotaExceededError";
    this.namespace = opts.namespace;
    this.resource = opts.resource;
    this.limit = opts.limit;
    this.current = opts.current;
    this.retryAfterMs = opts.retryAfterMs ?? 60_000;
  }
}

export class LLM400Error extends Error {
  public readonly statusCode: number;
  public readonly model: string;

  constructor(message: string, opts: { statusCode: number; model: string }) {
    super(message);
    this.name = "LLM400Error";
    this.statusCode = opts.statusCode;
    this.model = opts.model;
  }
}

export class LLMAuthError extends Error {
  public readonly model: string;

  constructor(message: string, opts: { model: string }) {
    super(message);
    this.name = "LLMAuthError";
    this.model = opts.model;
  }
}

export class LLMRateLimitError extends Error {
  public readonly model: string;
  public readonly retryAfterMs: number;

  constructor(message: string, opts: { model: string; retryAfterMs?: number }) {
    super(message);
    this.name = "LLMRateLimitError";
    this.model = opts.model;
    this.retryAfterMs = opts.retryAfterMs ?? 60_000;
  }
}

export class FatalConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FatalConfigError";
  }
}

export class PIIViolationError extends Error {
  public readonly toolName: string;
  public readonly detectedPatterns: string[];

  constructor(message: string, opts: { toolName: string; detectedPatterns: string[] }) {
    super(message);
    this.name = "PIIViolationError";
    this.toolName = opts.toolName;
    this.detectedPatterns = opts.detectedPatterns;
  }
}

export function grpcStatusFromError(err: Error): grpcStatus {
  if (err instanceof AgentError) {
    switch (err.code) {
      case "POLICY_DENIED":
        return grpcStatus.PERMISSION_DENIED;
      case "PERSISTENCE_ERROR":
        return grpcStatus.INTERNAL;
      case "TIMEOUT":
        return grpcStatus.DEADLINE_EXCEEDED;
      default:
        return grpcStatus.INTERNAL;
    }
  }
  if (err instanceof NamespaceNotFoundError) {
    return grpcStatus.NOT_FOUND;
  }
  if (err instanceof NamespaceSuspendedError) {
    return grpcStatus.UNAVAILABLE;
  }
  if (err instanceof CrossNamespaceError) {
    return grpcStatus.PERMISSION_DENIED;
  }
  if (err instanceof QuotaExceededError) {
    return grpcStatus.RESOURCE_EXHAUSTED;
  }
  return grpcStatus.INTERNAL;
}

export function toStructuredLog(err: Error): Record<string, unknown> {
  const base: Record<string, unknown> = {
    error_name: err.name,
    error_message: err.message,
  };

  if (err instanceof AgentError) {
    base.error_code = err.code;
    base.namespace = err.namespace;
    base.agent_id = err.agentId;
    base.trace_id = err.traceId;
  } else if (err instanceof NamespaceSuspendedError || err instanceof NamespaceNotFoundError) {
    base.namespace = err.namespace;
  } else if (err instanceof CrossNamespaceError) {
    base.caller_namespace = err.callerNamespace;
    base.target_namespace = err.targetNamespace;
    base.caller_role = err.callerRole;
  } else if (err instanceof QuotaExceededError) {
    base.namespace = err.namespace;
    base.resource = err.resource;
    base.limit = err.limit;
    base.current = err.current;
  }

  return base;
}
