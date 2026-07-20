import {
  AgentError,
  PolicyDeniedError,
  PersistenceError,
  TimeoutError,
  NamespaceNotFoundError,
  NamespaceSuspendedError,
  CrossNamespaceError,
  QuotaExceededError,
  LLM400Error,
  LLMAuthError,
  LLMRateLimitError,
  PIIViolationError,
  grpcStatusFromError,
  toStructuredLog,
} from "../errors/index.js";
import { status as grpcStatus } from "@grpc/grpc-js";

describe("Error Classes", () => {
  const baseOpts = { namespace: "test-ns", agentId: "agent-1", traceId: "trace-1" };

  describe("AgentError", () => {
    it("should create error with code and metadata", () => {
      const err = new AgentError("test message", { code: "TEST_CODE", ...baseOpts });
      expect(err.message).toBe("test message");
      expect(err.name).toBe("AgentError");
      expect(err.code).toBe("TEST_CODE");
      expect(err.namespace).toBe("test-ns");
      expect(err.agentId).toBe("agent-1");
      expect(err.traceId).toBe("trace-1");
      expect(err).toBeInstanceOf(Error);
    });
  });

  describe("PolicyDeniedError", () => {
    it("should create error with POLICY_DENIED code", () => {
      const err = new PolicyDeniedError("denied", baseOpts);
      expect(err.name).toBe("PolicyDeniedError");
      expect(err.code).toBe("POLICY_DENIED");
      expect(err).toBeInstanceOf(AgentError);
    });
  });

  describe("PersistenceError", () => {
    it("should create error with PERSISTENCE_ERROR code", () => {
      const err = new PersistenceError("db failed", baseOpts);
      expect(err.name).toBe("PersistenceError");
      expect(err.code).toBe("PERSISTENCE_ERROR");
    });
  });

  describe("TimeoutError", () => {
    it("should create error with TIMEOUT code", () => {
      const err = new TimeoutError("timed out", baseOpts);
      expect(err.name).toBe("TimeoutError");
      expect(err.code).toBe("TIMEOUT");
    });
  });

  describe("NamespaceNotFoundError", () => {
    it("should create error with namespace", () => {
      const err = new NamespaceNotFoundError("missing-ns");
      expect(err.name).toBe("NamespaceNotFoundError");
      expect(err.namespace).toBe("missing-ns");
      expect(err.message).toContain("missing-ns");
    });
  });

  describe("NamespaceSuspendedError", () => {
    it("should create error with namespace", () => {
      const err = new NamespaceSuspendedError("suspended-ns");
      expect(err.name).toBe("NamespaceSuspendedError");
      expect(err.namespace).toBe("suspended-ns");
    });
  });

  describe("CrossNamespaceError", () => {
    it("should create error with caller/target info", () => {
      const err = new CrossNamespaceError("caller", "target", "admin");
      expect(err.name).toBe("CrossNamespaceError");
      expect(err.callerNamespace).toBe("caller");
      expect(err.targetNamespace).toBe("target");
      expect(err.callerRole).toBe("admin");
    });
  });

  describe("QuotaExceededError", () => {
    it("should create error with quota details", () => {
      const err = new QuotaExceededError({
        namespace: "ns",
        resource: "concurrent_executions",
        limit: 10,
        current: 12,
        retryAfterMs: 5000,
      });
      expect(err.name).toBe("QuotaExceededError");
      expect(err.resource).toBe("concurrent_executions");
      expect(err.limit).toBe(10);
      expect(err.current).toBe(12);
      expect(err.retryAfterMs).toBe(5000);
    });

    it("should default retryAfterMs to 60s", () => {
      const err = new QuotaExceededError({
        namespace: "ns",
        resource: "r",
        limit: 1,
        current: 2,
      });
      expect(err.retryAfterMs).toBe(60_000);
    });
  });

  describe("LLM400Error", () => {
    it("should create error with status code and model", () => {
      const err = new LLM400Error("bad request", { statusCode: 400, model: "gpt-4o" });
      expect(err.name).toBe("LLM400Error");
      expect(err.statusCode).toBe(400);
      expect(err.model).toBe("gpt-4o");
    });
  });

  describe("LLMAuthError", () => {
    it("should create error with model", () => {
      const err = new LLMAuthError("unauthorized", { model: "gpt-4o" });
      expect(err.name).toBe("LLMAuthError");
      expect(err.model).toBe("gpt-4o");
    });
  });

  describe("LLMRateLimitError", () => {
    it("should create error with retryAfterMs", () => {
      const err = new LLMRateLimitError("rate limited", { model: "gpt-4o", retryAfterMs: 30000 });
      expect(err.name).toBe("LLMRateLimitError");
      expect(err.retryAfterMs).toBe(30000);
    });

    it("should default retryAfterMs to 60s", () => {
      const err = new LLMRateLimitError("rate limited", { model: "gpt-4o" });
      expect(err.retryAfterMs).toBe(60_000);
    });
  });

  describe("PIIViolationError", () => {
    it("should create error with detected patterns", () => {
      const err = new PIIViolationError("PII detected", {
        toolName: "file_write",
        detectedPatterns: ["SSN", "EMAIL"],
      });
      expect(err.name).toBe("PIIViolationError");
      expect(err.toolName).toBe("file_write");
      expect(err.detectedPatterns).toEqual(["SSN", "EMAIL"]);
    });
  });
});

describe("grpcStatusFromError", () => {
  const baseOpts = { namespace: "ns", agentId: "a", traceId: "t" };

  it("should map PolicyDeniedError to PERMISSION_DENIED", () => {
    const err = new PolicyDeniedError("denied", baseOpts);
    expect(grpcStatusFromError(err)).toBe(grpcStatus.PERMISSION_DENIED);
  });

  it("should map PersistenceError to INTERNAL", () => {
    const err = new PersistenceError("fail", baseOpts);
    expect(grpcStatusFromError(err)).toBe(grpcStatus.INTERNAL);
  });

  it("should map TimeoutError to DEADLINE_EXCEEDED", () => {
    const err = new TimeoutError("timeout", baseOpts);
    expect(grpcStatusFromError(err)).toBe(grpcStatus.DEADLINE_EXCEEDED);
  });

  it("should map NamespaceNotFoundError to NOT_FOUND", () => {
    const err = new NamespaceNotFoundError("ns");
    expect(grpcStatusFromError(err)).toBe(grpcStatus.NOT_FOUND);
  });

  it("should map NamespaceSuspendedError to UNAVAILABLE", () => {
    const err = new NamespaceSuspendedError("ns");
    expect(grpcStatusFromError(err)).toBe(grpcStatus.UNAVAILABLE);
  });

  it("should map CrossNamespaceError to PERMISSION_DENIED", () => {
    const err = new CrossNamespaceError("a", "b", "user");
    expect(grpcStatusFromError(err)).toBe(grpcStatus.PERMISSION_DENIED);
  });

  it("should map QuotaExceededError to RESOURCE_EXHAUSTED", () => {
    const err = new QuotaExceededError({ namespace: "ns", resource: "r", limit: 1, current: 2 });
    expect(grpcStatusFromError(err)).toBe(grpcStatus.RESOURCE_EXHAUSTED);
  });

  it("should map unknown error to INTERNAL", () => {
    expect(grpcStatusFromError(new Error("unknown"))).toBe(grpcStatus.INTERNAL);
  });
});

describe("toStructuredLog", () => {
  it("should serialize AgentError with metadata", () => {
    const err = new AgentError("msg", { code: "CODE", namespace: "ns", agentId: "a", traceId: "t" });
    const log = toStructuredLog(err);
    expect(log.error_name).toBe("AgentError");
    expect(log.error_code).toBe("CODE");
    expect(log.namespace).toBe("ns");
    expect(log.agent_id).toBe("a");
    expect(log.trace_id).toBe("t");
  });

  it("should serialize NamespaceSuspendedError", () => {
    const err = new NamespaceSuspendedError("ns");
    const log = toStructuredLog(err);
    expect(log.namespace).toBe("ns");
  });

  it("should serialize CrossNamespaceError", () => {
    const err = new CrossNamespaceError("caller", "target", "admin");
    const log = toStructuredLog(err);
    expect(log.caller_namespace).toBe("caller");
    expect(log.target_namespace).toBe("target");
    expect(log.caller_role).toBe("admin");
  });

  it("should serialize QuotaExceededError", () => {
    const err = new QuotaExceededError({ namespace: "ns", resource: "r", limit: 5, current: 6 });
    const log = toStructuredLog(err);
    expect(log.resource).toBe("r");
    expect(log.limit).toBe(5);
    expect(log.current).toBe(6);
  });

  it("should handle plain Error", () => {
    const log = toStructuredLog(new Error("plain"));
    expect(log.error_name).toBe("Error");
    expect(log.error_message).toBe("plain");
  });
});
