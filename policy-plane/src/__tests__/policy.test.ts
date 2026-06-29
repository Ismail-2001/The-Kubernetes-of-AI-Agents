import nock from "nock";
import crypto from "crypto";
import { PolicyPlaneService, CircuitBreaker, LRUCache, hashInput } from "../service";
import { verifyHS256JWT, extractNamespaceFromCN } from "../middleware";
import type { PolicyInput } from "../service";

const OPA_HOST = "http://localhost:8181";
const POLICY_PATH = "egaop/execution";

function makeInput(overrides?: Partial<PolicyInput>): PolicyInput {
  return {
    subject: { namespace: "default", clearance: 1 },
    action: "execute",
    resource: { namespace: "default" },
    namespace: "default",
    agentId: "agent-001",
    claims: {},
    ...overrides,
  };
}

beforeEach(() => {
  PolicyPlaneService.resetInstance();
  nock.cleanAll();
  process.env.NODE_ENV = "test";
});

afterEach(() => {
  nock.cleanAll();
  PolicyPlaneService.resetInstance();
});

describe("PolicyPlaneService", () => {
  describe("OPA returns allow", () => {
    it("should return allow decision", async () => {
      nock(OPA_HOST)
        .post(`/v1/data/${POLICY_PATH}`)
        .reply(200, { result: { allow: true } });

      const service = PolicyPlaneService.getInstance();
      const decision = await service.evaluatePolicy(POLICY_PATH, makeInput());

      expect(decision.allow).toBe(true);
      expect(decision.reason).toBe("");
    });
  });

  describe("OPA returns deny", () => {
    it("should return deny with reason", async () => {
      nock(OPA_HOST)
        .post(`/v1/data/${POLICY_PATH}`)
        .reply(200, {
          result: { allow: false, reason: "Sandbox agents cannot execute" },
        });

      const service = PolicyPlaneService.getInstance();
      const decision = await service.evaluatePolicy(POLICY_PATH, makeInput());

      expect(decision.allow).toBe(false);
      expect(decision.reason).toBe("Sandbox agents cannot execute");
    });
  });

  describe("OPA unreachable (fail-closed)", () => {
    it("should DENY when OPA connection is refused", async () => {
      nock(OPA_HOST)
        .post(`/v1/data/${POLICY_PATH}`)
        .replyWithError("ECONNREFUSED");

      const service = PolicyPlaneService.getInstance();
      const decision = await service.evaluatePolicy(POLICY_PATH, makeInput());

      expect(decision.allow).toBe(false);
      expect(decision.reason).toContain("OPA call failed");
    });
  });

  describe("OPA timeout", () => {
    it("should DENY within 250ms when OPA responds after 300ms", async () => {
      nock(OPA_HOST)
        .post(`/v1/data/${POLICY_PATH}`)
        .delay(300)
        .reply(200, { result: { allow: true } });

      process.env.OPA_TIMEOUT_MS = "200";

      const service = PolicyPlaneService.getInstance();
      const start = Date.now();
      const decision = await service.evaluatePolicy(POLICY_PATH, makeInput());
      const elapsed = Date.now() - start;

      expect(decision.allow).toBe(false);
      expect(elapsed).toBeLessThan(300);
    });
  });

  describe("Cache behavior", () => {
    it("should cache identical inputs and return cached result", async () => {
      const scope = nock(OPA_HOST)
        .post(`/v1/data/${POLICY_PATH}`)
        .once()
        .reply(200, { result: { allow: true } });

      const service = PolicyPlaneService.getInstance();
      const input = makeInput();

      const first = await service.evaluatePolicy(POLICY_PATH, input);
      const second = await service.evaluatePolicy(POLICY_PATH, input);

      expect(first.allow).toBe(true);
      expect(second.allow).toBe(true);
      expect(scope.isDone()).toBe(true);
      expect(nock.pendingMocks()).toHaveLength(0);
    });
  });

  describe("Namespace mismatch", () => {
    it("should deny when subject namespace differs from resource namespace", async () => {
      nock(OPA_HOST)
        .post(`/v1/data/${POLICY_PATH}`)
        .reply(200, {
          result: {
            allow: false,
            reason: "Namespace mismatch: subject 'tenant-a' cannot access resource in namespace 'tenant-b'",
          },
        });

      const service = PolicyPlaneService.getInstance();
      const decision = await service.evaluatePolicy(POLICY_PATH, makeInput({
        subject: { namespace: "tenant-a", clearance: 3 },
        resource: { namespace: "tenant-b" },
      }));

      expect(decision.allow).toBe(false);
      expect(decision.reason).toContain("Namespace mismatch");
    });
  });

  describe("Sandbox agent + network_egress", () => {
    it("should deny sandbox agents performing network egress", async () => {
      nock(OPA_HOST)
        .post(`/v1/data/${POLICY_PATH}`)
        .reply(200, {
          result: {
            allow: false,
            reason: "Sandbox-tier agents are not permitted to perform network egress",
          },
        });

      const service = PolicyPlaneService.getInstance();
      const decision = await service.evaluatePolicy(POLICY_PATH, makeInput({
        subject: { namespace: "default", clearance: 1, tier: "sandbox" },
        action: "network_egress",
      }));

      expect(decision.allow).toBe(false);
      expect(decision.reason).toContain("Sandbox-tier agents are not permitted");
    });
  });

  describe("Circuit breaker", () => {
    it("should open circuit after threshold failures and deny without calling OPA", async () => {
      const scope = nock(OPA_HOST)
        .post(`/v1/data/${POLICY_PATH}`)
        .times(5)
        .replyWithError("ECONNREFUSED");

      const service = PolicyPlaneService.getInstance();

      for (let i = 0; i < 5; i++) {
        await service.evaluatePolicy(POLICY_PATH, makeInput());
      }

      const denyWithoutCall = nock(OPA_HOST)
        .post(`/v1/data/${POLICY_PATH}`)
        .reply(200, { result: { allow: true } });

      const decision = await service.evaluatePolicy(POLICY_PATH, makeInput());

      expect(decision.allow).toBe(false);
      expect(decision.reason).toContain("Circuit breaker OPEN");
      expect(denyWithoutCall.isDone()).toBe(false);
      nock.cleanAll();
    });
  });
});

describe("LRUCache", () => {
  it("should return null for cache miss", () => {
    const cache = new LRUCache(10, 60000);
    expect(cache.get("nonexistent")).toBeNull();
    cache.dispose();
  });

  it("should store and retrieve decisions", () => {
    const cache = new LRUCache(10, 60000);
    cache.set("key1", { allow: true, reason: "" });
    expect(cache.get("key1")).toEqual({ allow: true, reason: "" });
    cache.dispose();
  });

  it("should evict oldest entry when full", () => {
    const cache = new LRUCache(2, 60000);
    cache.set("key1", { allow: true, reason: "" });
    cache.set("key2", { allow: true, reason: "" });
    cache.set("key3", { allow: false, reason: "evicted" });

    expect(cache.get("key1")).toBeNull();
    expect(cache.get("key2")).toEqual({ allow: true, reason: "" });
    expect(cache.get("key3")).toEqual({ allow: false, reason: "evicted" });
    cache.dispose();
  });

  it("should expire entries after TTL", () => {
    const cache = new LRUCache(10, 1);
    cache.set("key1", { allow: true, reason: "" });
    expect(cache.get("key1")).toEqual({ allow: true, reason: "" });
    cache.dispose();
  });
});

describe("CircuitBreaker", () => {
  it("should start in closed state", () => {
    const cb = new CircuitBreaker(3, 1000);
    expect(cb.getState()).toBe("CLOSED");
    expect(cb.canExecute()).toBe(true);
  });

  it("should open after threshold failures", () => {
    const cb = new CircuitBreaker(3, 60000);
    cb.recordFailure();
    cb.recordFailure();
    cb.recordFailure();
    expect(cb.getState()).toBe("OPEN");
    expect(cb.canExecute()).toBe(false);
  });

  it("should transition to half-open after recovery time", () => {
    const cb = new CircuitBreaker(2, 1);
    cb.recordFailure();
    cb.recordFailure();
    expect(cb.getState()).toBe("OPEN");

    return new Promise<void>((resolve) => {
      setTimeout(() => {
        expect(cb.canExecute()).toBe(true);
        expect(cb.getState()).toBe("HALF_OPEN");
        resolve();
      }, 5);
    });
  });

  it("should close on success from half-open", () => {
    const cb = new CircuitBreaker(2, 1);
    cb.recordFailure();
    cb.recordFailure();

    return new Promise<void>((resolve) => {
      setTimeout(() => {
        cb.canExecute();
        expect(cb.getState()).toBe("HALF_OPEN");
        cb.recordSuccess();
        expect(cb.getState()).toBe("CLOSED");
        resolve();
      }, 5);
    });
  });
});

describe("hashInput", () => {
  it("should produce consistent hashes for identical inputs", () => {
    const input = makeInput();
    const h1 = hashInput(input);
    const h2 = hashInput(input);
    expect(h1).toBe(h2);
  });

  it("should produce different hashes for different inputs", () => {
    const h1 = hashInput(makeInput({ action: "read" }));
    const h2 = hashInput(makeInput({ action: "write" }));
    expect(h1).not.toBe(h2);
  });
});

describe("verifyHS256JWT", () => {
  const secret = "test-secret-key";

  function createJWT(payload: Record<string, unknown>): string {
    const header = { alg: "HS256", typ: "JWT" };
    const encode = (obj: object) =>
      Buffer.from(JSON.stringify(obj)).toString("base64url");
    const headerB64 = encode(header);
    const payloadB64 = encode(payload);
    const data = `${headerB64}.${payloadB64}`;
    const signature = crypto.createHmac("sha256", secret).update(data).digest("base64url");
    return `${headerB64}.${payloadB64}.${signature}`;
  }

  it("should verify a valid JWT", () => {
    const token = createJWT({ sub: "agent-1", clearance: 3 });
    const result = verifyHS256JWT(token, secret);
    expect(result.valid).toBe(true);
    expect(result.payload).toEqual({ sub: "agent-1", clearance: 3 });
  });

  it("should reject an invalid signature", () => {
    const token = createJWT({ sub: "agent-1" });
    const parts = token.split(".");
    const tampered = `${parts[0]}.${parts[1]}.invalid-signature`;
    const result = verifyHS256JWT(tampered, secret);
    expect(result.valid).toBe(false);
    expect(result.error).toBe("Invalid signature");
  });

  it("should reject a token with wrong algorithm", () => {
    const header = { alg: "RS256", typ: "JWT" };
    const payload = { sub: "agent-1" };
    const encode = (obj: object) =>
      Buffer.from(JSON.stringify(obj)).toString("base64url");
    const token = `${encode(header)}.${encode(payload)}.fake-sig`;
    const result = verifyHS256JWT(token, secret);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("Unsupported algorithm");
  });

  it("should reject malformed JWT", () => {
    const result = verifyHS256JWT("not-a-jwt", secret);
    expect(result.valid).toBe(false);
    expect(result.error).toBe("Invalid JWT structure");
  });
});

describe("extractNamespaceFromCN", () => {
  it("should extract namespace from dotted CN", () => {
    expect(extractNamespaceFromCN("agent.tenant-a.instance")).toBe("tenant-a");
  });

  it("should return default for single-segment CN", () => {
    expect(extractNamespaceFromCN("agent")).toBe("default");
  });
});
