import crypto from "crypto";
import * as grpc from "@grpc/grpc-js";
import { PolicyPlaneService } from "../service";
import {
  createPolicyInterceptor,
  verifyHS256JWT,
  extractPeerInfo,
  extractClaims,
} from "../middleware";

jest.mock("../service", () => ({
  PolicyPlaneService: {
    getInstance: jest.fn(),
    resetInstance: jest.fn(),
  },
}));

const mockGetInstance = jest.mocked(PolicyPlaneService.getInstance);

function createJWT(payload: Record<string, unknown>, secret: string): string {
  const header = { alg: "HS256", typ: "JWT" };
  const encode = (obj: object) =>
    Buffer.from(JSON.stringify(obj)).toString("base64url");
  const headerB64 = encode(header);
  const payloadB64 = encode(payload);
  const data = `${headerB64}.${payloadB64}`;
  const signature = crypto.createHmac("sha256", secret).update(data).digest("base64url");
  return `${headerB64}.${payloadB64}.${signature}`;
}

function makeCall(options?: {
  claims?: string;
  path?: string;
  peer?: string;
}) {
  const metadata = new grpc.Metadata();
  if (options?.claims) {
    metadata.add("x-agent-claims", options.claims);
  }
  return {
    metadata,
    getPeer: jest.fn(() => options?.peer ?? "ipv6:[::1]:12345"),
    getPath: jest.fn(() => options?.path ?? "/egaop.v1.ExecutionService/StartAgent"),
    callback: jest.fn(),
  } as unknown as grpc.ServerUnaryCall<unknown, unknown>;
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  process.env.NODE_ENV = "test";
  mockGetInstance.mockReset();
});

describe("verifyHS256JWT", () => {
  it("should reject token with invalid header", () => {
    const token = `!!!.${Buffer.from(JSON.stringify({ sub: "x" })).toString("base64url")}.sig`;
    const result = verifyHS256JWT(token, "secret");
    expect(result.valid).toBe(false);
    expect(result.error).toBe("Invalid JWT header");
  });

  it("should reject expired token", () => {
    const token = createJWT(
      { sub: "agent-1", exp: Math.floor(Date.now() / 1000) - 60 },
      "secret"
    );
    const result = verifyHS256JWT(token, "secret");
    expect(result.valid).toBe(false);
    expect(result.error).toBe("Token expired");
  });

  it("should reject token that is not yet valid", () => {
    const token = createJWT(
      { sub: "agent-1", nbf: Math.floor(Date.now() / 1000) + 60, exp: Math.floor(Date.now() / 1000) + 600 },
      "secret"
    );
    const result = verifyHS256JWT(token, "secret");
    expect(result.valid).toBe(false);
    expect(result.error).toBe("Token not yet valid");
  });

  it("should reject token without exp (P1-4: non-expiring tokens)", () => {
    const token = createJWT({ sub: "agent-1" }, "secret");
    const result = verifyHS256JWT(token, "secret");
    expect(result.valid).toBe(false);
    expect(result.error).toBe("Token missing expiration");
  });

  it("should reject token with invalid payload", () => {
    const headerB64 = Buffer.from(JSON.stringify({ alg: "HS256" })).toString("base64url");
    const data = `${headerB64}.not-json`;
    const signature = crypto.createHmac("sha256", "secret").update(data).digest("base64url");
    const token = `${headerB64}.not-json.${signature}`;
    const result = verifyHS256JWT(token, "secret");
    expect(result.valid).toBe(false);
    expect(result.error).toBe("Invalid JWT payload");
  });
});

describe("extractPeerInfo", () => {
  it("should extract CN and organization from peer string", () => {
    const call = makeCall({ peer: "ipv6:[::1]:50051, CN=agent.tenant-a.svc, O=TenantA" });
    expect(extractPeerInfo(call)).toEqual({
      CN: "agent.tenant-a.svc",
      organization: "TenantA",
    });
  });

  it("should return unknown CN when peer has no matching segments", () => {
    const call = makeCall({ peer: "ipv6:[::1]:50051" });
    expect(extractPeerInfo(call)).toEqual({ CN: "unknown" });
  });

  it("should return unknown CN for empty peer", () => {
    const call = makeCall({ peer: "" });
    expect(extractPeerInfo(call)).toEqual({ CN: "unknown" });
  });
});

describe("extractClaims", () => {
  it("should return empty claims when no header present", () => {
    const call = makeCall();
    expect(extractClaims(call)).toEqual({});
  });

  it("should parse JSON string claims", () => {
    const call = makeCall({ claims: createJWT({ sub: "agent-1", clearance: 3, exp: Math.floor(Date.now() / 1000) + 600 }, "sec") });
    expect(extractClaims(call, "sec")).toEqual({ sub: "agent-1", clearance: 3, exp: expect.any(Number) });
  });

  it("should parse Buffer claims", () => {
    const metadata = {
      get: jest.fn(() => [Buffer.from(createJWT({ sub: "agent-2", exp: Math.floor(Date.now() / 1000) + 600 }, "sec"))]),
    };
    const call = {
      ...makeCall(),
      metadata,
    } as unknown as grpc.ServerUnaryCall<unknown, unknown>;
    expect(extractClaims(call, "sec")).toEqual({ sub: "agent-2", exp: expect.any(Number) });
  });

  it("should reject raw JSON claims when no JWT secret is configured (P1-4 fail-closed)", () => {
    const call = makeCall({ claims: JSON.stringify({ sub: "attacker", role: "admin" }) });
    expect(extractClaims(call)).toEqual({});
  });

  it("should return empty claims for invalid JSON", () => {
    const call = makeCall({ claims: "not-json" });
    expect(extractClaims(call)).toEqual({});
  });

  it("should verify JWT claims when jwtSecret is provided", () => {
    const call = makeCall({ claims: createJWT({ sub: "agent-1", clearance: 3, exp: Math.floor(Date.now() / 1000) + 600 }, "sec") });
    expect(extractClaims(call, "sec")).toEqual({ sub: "agent-1", clearance: 3, exp: expect.any(Number) });
  });

  it("should return empty claims and warn when JWT verification fails", () => {
    const stderrSpy = jest.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const call = makeCall({ claims: "bad.token.data" });
      expect(extractClaims(call, "sec")).toEqual({});
      expect(stderrSpy).toHaveBeenCalled();
    } finally {
      stderrSpy.mockRestore();
    }
  });
});

describe("createPolicyInterceptor", () => {
  it("should call next when policy allows", async () => {
    mockGetInstance.mockReturnValue({
      evaluatePolicy: jest.fn().mockResolvedValue({ allow: true, reason: "" }),
    } as unknown as PolicyPlaneService);

    const interceptor = createPolicyInterceptor({ policyPath: "egaop/execution" });
    const call = makeCall();
    const next = jest.fn();
    interceptor(call, new grpc.Metadata(), next);
    await flush();

    expect(next).toHaveBeenCalled();
  });

  it("should deny with PERMISSION_DENIED when policy denies", async () => {
    mockGetInstance.mockReturnValue({
      evaluatePolicy: jest.fn().mockResolvedValue({
        allow: false,
        reason: "No permission",
      }),
    } as unknown as PolicyPlaneService);

    const interceptor = createPolicyInterceptor({ policyPath: "egaop/execution" });
    const call = makeCall() as unknown as { callback: jest.Mock };
    interceptor(call as unknown as grpc.ServerUnaryCall<unknown, unknown>, new grpc.Metadata(), jest.fn());
    await flush();

    expect(call.callback).toHaveBeenCalledTimes(1);
    const error = call.callback.mock.calls[0]?.[0] as grpc.ServiceError;
    expect(error.code).toBe(grpc.status.PERMISSION_DENIED);
    expect(error.metadata.get("egaop-policy-reason")[0]).toBe("No permission");
    expect(error.metadata.get("egaop-policy-action")[0]).toBe("startagent");
    expect(error.metadata.get("egaop-agent-id")[0]).toBe("unknown");
  });

  it("should deny when evaluatePolicy rejects", async () => {
    mockGetInstance.mockReturnValue({
      evaluatePolicy: jest.fn().mockRejectedValue(new Error("OPA down")),
    } as unknown as PolicyPlaneService);

    const interceptor = createPolicyInterceptor({ policyPath: "egaop/execution" });
    const call = makeCall() as unknown as { callback: jest.Mock };
    interceptor(call as unknown as grpc.ServerUnaryCall<unknown, unknown>, new grpc.Metadata(), jest.fn());
    await flush();

    const error = call.callback.mock.calls[0]?.[0] as grpc.ServiceError;
    expect(error.code).toBe(grpc.status.PERMISSION_DENIED);
    expect(error.metadata.get("egaop-policy-reason")[0]).toBe("OPA down");
  });

  it("should forward a PERMISSION_DENIED rejection as-is", async () => {
    const serviceError = new Error("already denied") as grpc.ServiceError;
    serviceError.code = grpc.status.PERMISSION_DENIED;
    mockGetInstance.mockReturnValue({
      evaluatePolicy: jest.fn().mockRejectedValue(serviceError),
    } as unknown as PolicyPlaneService);

    const interceptor = createPolicyInterceptor({ policyPath: "egaop/execution" });
    const call = makeCall() as unknown as { callback: jest.Mock };
    interceptor(call as unknown as grpc.ServerUnaryCall<unknown, unknown>, new grpc.Metadata(), jest.fn());
    await flush();

    expect(call.callback).toHaveBeenCalledWith(serviceError);
  });

  it("should extract namespace and claims from JWT when jwtSecret is provided", async () => {
    const evaluatePolicy = jest.fn().mockResolvedValue({ allow: true, reason: "" });
    mockGetInstance.mockReturnValue({
      evaluatePolicy,
    } as unknown as PolicyPlaneService);

    const claims = createJWT(
      { agentId: "agent-9", namespace: "tenant-b", clearance: 5, exp: Math.floor(Date.now() / 1000) + 600 },
      "opt-secret"
    );
    const interceptor = createPolicyInterceptor({
      policyPath: "egaop/execution",
      jwtSecret: "opt-secret",
    });
    const call = makeCall({ claims });
    const next = jest.fn();
    interceptor(call, new grpc.Metadata(), next);
    await flush();

    expect(next).toHaveBeenCalled();
    const input = evaluatePolicy.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(input).toMatchObject({
      namespace: "tenant-b",
      agentId: "agent-9",
      action: "startagent",
    });
    expect((input.subject as Record<string, unknown>).clearance).toBe(5);
    expect((input.subject as Record<string, unknown>).namespace).toBe("tenant-b");
  });

  it("should derive namespace from peer CN when claims are absent", async () => {
    const evaluatePolicy = jest.fn().mockResolvedValue({ allow: true, reason: "" });
    mockGetInstance.mockReturnValue({
      evaluatePolicy,
    } as unknown as PolicyPlaneService);

    const interceptor = createPolicyInterceptor({ policyPath: "egaop/execution" });
    const call = makeCall({ peer: "ipv6:[::1]:50051, CN=agent.tenant-c.svc" });
    const next = jest.fn();
    interceptor(call, new grpc.Metadata(), next);
    await flush();

    expect(next).toHaveBeenCalled();
    const input = evaluatePolicy.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(input).toMatchObject({
      namespace: "tenant-c",
      agentId: "unknown",
    });
  });
});
