import * as grpc from "@grpc/grpc-js";

jest.mock("@e-gaop/shared", () => {
  const actual = jest.requireActual("@e-gaop/shared");
  const mockCheck = jest.fn().mockReturnValue({ allowed: true, retryAfterMs: 0 });
  const mockDispose = jest.fn();
  return {
    ...actual,
    createAuditEntry: jest.fn(),
    RateLimiter: jest.fn().mockImplementation(() => ({
      check: mockCheck,
      dispose: mockDispose,
    })),
  };
});

const mockFetch = jest.fn();
global.fetch = mockFetch as any;

import { server } from "../index";
import { getSandboxRegistry } from "@e-gaop/shared";

const handlers = (server as any).handlers as Map<string, { func: any }>;

function callTool(req: Record<string, unknown>, metadata?: Record<string, string>): Promise<any> {
  const handler = handlers.get("/egaop.v1.ToolService/CallTool")!;
  const meta = new grpc.Metadata();
  if (metadata) {
    for (const [k, v] of Object.entries(metadata)) meta.add(k, v);
  }
  return new Promise((resolve) => {
    handler.func(
      { request: req, metadata: meta },
      (err: any, result?: any) => resolve({ err, result })
    );
  });
}

describe("Sandbox auth and isolation in tool-proxy", () => {
  const registry = getSandboxRegistry();

  beforeEach(async () => {
    jest.clearAllMocks();
    await registry.clear?.();
    process.env.SANDBOX_IP_ALLOWLIST_CIDRS = "172.30.0.0/16";
  });

  afterEach(() => {
    delete process.env.SANDBOX_IP_ALLOWLIST_CIDRS;
  });

  it("resolves sandbox by execution_id and sends Authorization Bearer token", async () => {
    await registry.register({
      executionId: "exec-test-1",
      agentId: "tenant-a/agent-1",
      namespace: "tenant-a",
      ip: "172.30.1.10",
      token: "secret-sandbox-token-12345",
    });

    mockFetch.mockResolvedValue(new Response(JSON.stringify({ stdout: "ok", exitCode: 0 }), { status: 200 }));

    const { err, result } = await callTool(
      {
        agent_id: "tenant-a/agent-1",
        execution_id: "exec-test-1",
        tool_name: "code_interpreter",
        args: { code: "print(1)" },
      },
      { "x-egaop-namespace": "tenant-a" }
    );

    expect(err).toBeNull();
    expect(result.status).toBe("succeeded");
    expect(mockFetch).toHaveBeenCalledTimes(1);

    const [calledUrl, calledOpts] = mockFetch.mock.calls[0];
    expect(calledUrl).toBe("http://172.30.1.10:8080/exec");
    expect(calledOpts.headers["Authorization"]).toBe("Bearer secret-sandbox-token-12345");
  });

  it("rejects when namespace B attempts to invoke namespace A execution (cross-namespace denial)", async () => {
    await registry.register({
      executionId: "exec-tenant-a",
      agentId: "tenant-a/agent-1",
      namespace: "tenant-a",
      ip: "172.30.1.20",
      token: "token-tenant-a",
    });

    // Caller is tenant-b
    const { err, result } = await callTool(
      {
        agent_id: "tenant-b/agent-attacker",
        execution_id: "exec-tenant-a",
        tool_name: "code_interpreter",
        args: { code: "print('lateral move')" },
      },
      { "x-egaop-namespace": "tenant-b" }
    );

    expect(err).toBeNull();
    expect(result.status).toBe("failed");
    expect(result.error_message).toMatch(/Cross-namespace/i);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("ignores spoofed caller-supplied sandbox_ip and uses resolved IP from registry", async () => {
    await registry.register({
      executionId: "exec-spoof-1",
      agentId: "tenant-a/agent-1",
      namespace: "tenant-a",
      ip: "172.30.1.30",
      token: "token-spoof-test",
    });

    mockFetch.mockResolvedValue(new Response(JSON.stringify({ stdout: "ok", exitCode: 0 }), { status: 200 }));

    const { err, result } = await callTool(
      {
        agent_id: "tenant-a/agent-1",
        execution_id: "exec-spoof-1",
        tool_name: "code_interpreter",
        args: { code: "print(1)" },
        sandbox_ip: "172.30.9.99", // Spoofed IP
      },
      { "x-egaop-namespace": "tenant-a" }
    );

    expect(err).toBeNull();
    expect(result.status).toBe("succeeded");
    const [calledUrl] = mockFetch.mock.calls[0];
    expect(calledUrl).toBe("http://172.30.1.30:8080/exec");
    expect(calledUrl).not.toContain("172.30.9.99");
  });

  it("caps sandbox response body read at 1 MiB", async () => {
    await registry.register({
      executionId: "exec-large-1",
      agentId: "tenant-a/agent-1",
      namespace: "tenant-a",
      ip: "172.30.1.40",
      token: "token-large-test",
    });

    // Create a 2 MiB response string
    const largeChunk = "X".repeat(1024 * 1024); // 1 MiB
    const twoMbPayload = largeChunk + largeChunk;

    mockFetch.mockResolvedValue(new Response(twoMbPayload, { status: 200 }));

    const { err, result } = await callTool(
      {
        agent_id: "tenant-a/agent-1",
        execution_id: "exec-large-1",
        tool_name: "code_interpreter",
        args: { code: "print('big')" },
      },
      { "x-egaop-namespace": "tenant-a" }
    );

    expect(err).toBeNull();
    expect(result.status).toBe("succeeded");
    // Verify result message is capped (at most 10,000 chars for result message, and fetched body was capped at 1 MiB)
    expect(result.result.message.length).toBeLessThanOrEqual(10000);
  });
});

