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
import { createAuditEntry } from "@e-gaop/shared";

const handlers = (server as any).handlers as Map<string, { func: any }>;

afterEach(() => {
  jest.clearAllMocks();
});

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

describe("CallTool handler", () => {
  it("returns error for unknown tool", async () => {
    const { err, result } = await callTool({
      agent_id: "default/agent-1",
      execution_id: "exec-1",
      tool_name: "nonexistent_tool",
      args: {},
    });
    expect(err).toBeNull();
    expect(result.status).toBe("failed");
    expect(result.error_message).toMatch(/Unknown tool/);
  });

  it("blocks on rate limit", async () => {
    const { RateLimiter } = require("@e-gaop/shared");
    const instance = RateLimiter.mock.results[0]?.value || RateLimiter();
    instance.check.mockReturnValueOnce({ allowed: false, retryAfterMs: 5000 });

    const { err } = await callTool({
      agent_id: "default/agent-1",
      execution_id: "exec-1",
      tool_name: "google_search",
      args: {},
    });
    expect(err.code).toBe(grpc.status.RESOURCE_EXHAUSTED);
  });

  it("blocks PII in args", async () => {
    (createAuditEntry as jest.Mock).mockImplementation(() => {});
    const { err } = await callTool({
      agent_id: "default/agent-1",
      execution_id: "exec-1",
      tool_name: "google_search",
      args: { q: "My SSN is 123-45-6789" },
    });
    expect(err).toBeDefined();
    expect(err.message).toMatch(/PII/);
  });

  it("succeeds on a simple web search", async () => {
    mockFetch.mockResolvedValue(new Response("search results", { status: 200 }));
    (createAuditEntry as jest.Mock).mockImplementation(() => {});

    const { err, result } = await callTool({
      agent_id: "default/agent-1",
      execution_id: "exec-1",
      tool_name: "google_search",
      args: { q: "test query" },
    });
    expect(err).toBeNull();
    expect(result.status).toBe("succeeded");
    expect(result.result.value).toBe("SUCCESS");
  });

  it("blocks internal hostname URLs in web_fetch", async () => {
    const { err, result } = await callTool({
      agent_id: "default/agent-1",
      execution_id: "exec-1",
      tool_name: "web_fetch",
      args: { url: "http://metadata.google.internal/" },
    });
    expect(err).toBeNull();
    expect(result.status).toBe("failed");
    expect(result.error_message).toMatch(/private or internal/);
  });

  it("blocks non-allowlisted web_fetch hosts", async () => {
    const { err, result } = await callTool({
      agent_id: "default/agent-1",
      execution_id: "exec-1",
      tool_name: "web_fetch",
      args: { url: "https://evil.example.com/steal" },
    });
    expect(err).toBeNull();
    expect(result.status).toBe("failed");
    expect(result.error_message).toMatch(/not in the allowed hosts/);
  });

  it("allows allowlisted web_fetch hosts", async () => {
    mockFetch.mockResolvedValue(new Response("fetched", { status: 200 }));
    (createAuditEntry as jest.Mock).mockImplementation(() => {});

    const { err, result } = await callTool({
      agent_id: "default/agent-1",
      execution_id: "exec-1",
      tool_name: "web_fetch",
      args: { url: "https://en.wikipedia.org/wiki/Test" },
    });
    expect(err).toBeNull();
    expect(result.status).toBe("succeeded");
  });

  it("rejects sandbox tool without sandbox_ip", async () => {
    const { err, result } = await callTool({
      agent_id: "default/agent-1",
      execution_id: "exec-1",
      tool_name: "code_interpreter",
      args: { code: "print('hi')" },
    });
    expect(err).toBeNull();
    expect(result.status).toBe("failed");
    expect(result.error_message).toMatch(/Sandbox IP not provided/);
  });

  it("allows sandbox tool for RFC1918 sandbox_ip by default", async () => {
    mockFetch.mockResolvedValue(new Response("sandbox output", { status: 200 }));
    (createAuditEntry as jest.Mock).mockImplementation(() => {});

    const { err, result } = await callTool({
      agent_id: "default/agent-1",
      execution_id: "exec-1",
      tool_name: "code_interpreter",
      args: { code: "print('hi')" },
      sandbox_ip: "10.0.0.1",
    });
    expect(err).toBeNull();
    expect(result.status).toBe("succeeded");
  });

  it("rejects loopback sandbox_ip", async () => {
    const { err, result } = await callTool({
      agent_id: "default/agent-1",
      execution_id: "exec-1",
      tool_name: "code_interpreter",
      args: { code: "print('hi')" },
      sandbox_ip: "127.0.0.1",
    });
    expect(err).toBeNull();
    expect(result.status).toBe("failed");
    expect(result.error_message).toMatch(/Sandbox IP/);
  });

  it("rejects link-local metadata sandbox_ip", async () => {
    const { err, result } = await callTool({
      agent_id: "default/agent-1",
      execution_id: "exec-1",
      tool_name: "code_interpreter",
      args: { code: "print('hi')" },
      sandbox_ip: "169.254.169.254",
    });
    expect(err).toBeNull();
    expect(result.status).toBe("failed");
    expect(result.error_message).toMatch(/Sandbox IP/);
  });

  it("rejects non-IP sandbox_ip (hostname)", async () => {
    mockFetch.mockResolvedValue(new Response("should not be reached", { status: 200 }));
    (createAuditEntry as jest.Mock).mockImplementation(() => {});

    const { err, result } = await callTool({
      agent_id: "default/agent-1",
      execution_id: "exec-1",
      tool_name: "code_interpreter",
      args: { code: "print('hi')" },
      sandbox_ip: "evil.example.com",
    });
    expect(err).toBeNull();
    expect(result.status).toBe("failed");
    expect(result.error_message).toMatch(/Sandbox IP/);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("honours SANDBOX_IP_ALLOWLIST_CIDRS to allow inside the sandbox network", async () => {
    process.env.SANDBOX_IP_ALLOWLIST_CIDRS = "10.0.0.0/8";
    try {
      mockFetch.mockResolvedValue(new Response("sandbox output", { status: 200 }));
      (createAuditEntry as jest.Mock).mockImplementation(() => {});

      const { err, result } = await callTool({
        agent_id: "default/agent-1",
        execution_id: "exec-1",
        tool_name: "code_interpreter",
        args: { code: "print('hi')" },
        sandbox_ip: "10.0.0.5",
      });
      expect(err).toBeNull();
      expect(result.status).toBe("succeeded");
    } finally {
      delete process.env.SANDBOX_IP_ALLOWLIST_CIDRS;
    }
  });

  it("honours SANDBOX_IP_ALLOWLIST_CIDRS to deny outside the sandbox network", async () => {
    process.env.SANDBOX_IP_ALLOWLIST_CIDRS = "172.30.0.0/16";
    try {
      const { err, result } = await callTool({
        agent_id: "default/agent-1",
        execution_id: "exec-1",
        tool_name: "code_interpreter",
        args: { code: "print('hi')" },
        sandbox_ip: "192.168.1.5",
      });
      expect(err).toBeNull();
      expect(result.status).toBe("failed");
      expect(result.error_message).toMatch(/Sandbox IP/);
    } finally {
      delete process.env.SANDBOX_IP_ALLOWLIST_CIDRS;
    }
  });

  it("does not attach credentials to sandbox-routed calls", async () => {
    process.env.TOOL_DEFAULT_API_KEY = "sekret-default-key";
    try {
      mockFetch.mockResolvedValue(new Response("sandbox output", { status: 200 }));
      (createAuditEntry as jest.Mock).mockImplementation(() => {});

      const { err, result } = await callTool({
        agent_id: "default/agent-1",
        execution_id: "exec-1",
        tool_name: "code_interpreter",
        args: { code: "print('hi')" },
        sandbox_ip: "172.30.0.5",
      });
      expect(err).toBeNull();
      expect(result.status).toBe("succeeded");
      const opts = mockFetch.mock.calls[0][1] as { headers?: Record<string, string> };
      expect(opts.headers?.Authorization).toBeUndefined();
    } finally {
      delete process.env.TOOL_DEFAULT_API_KEY;
    }
  });

  it("does not follow redirects on sandbox calls", async () => {
    mockFetch.mockResolvedValue(
      new Response("", { status: 302, headers: { Location: "http://169.254.169.254/" } })
    );
    (createAuditEntry as jest.Mock).mockImplementation(() => {});

    const { err, result } = await callTool({
      agent_id: "default/agent-1",
      execution_id: "exec-1",
      tool_name: "code_interpreter",
      args: { code: "print('hi')" },
      sandbox_ip: "172.30.0.5",
    });
    expect(err).toBeNull();
    expect(result.status).toBe("failed");
    expect(result.error_message).toMatch(/redirect/i);
    const opts = mockFetch.mock.calls[0][1] as { redirect?: string };
    expect(opts.redirect).toBe("manual");
  });

  it("validates sandbox tool args", async () => {
    const { err, result } = await callTool({
      agent_id: "default/agent-1",
      execution_id: "exec-1",
      tool_name: "code_interpreter",
      args: {},
      sandbox_ip: "172.30.0.5",
    });
    expect(err).toBeNull();
    expect(result.status).toBe("failed");
    expect(result.error_message).toMatch(/Input validation failed/);
  });

  it("executes sandbox tool successfully", async () => {
    mockFetch.mockResolvedValue(new Response("sandbox output", { status: 200 }));
    (createAuditEntry as jest.Mock).mockImplementation(() => {});

    const { err, result } = await callTool({
      agent_id: "default/agent-1",
      execution_id: "exec-1",
      tool_name: "code_interpreter",
      args: { code: "print('hello')" },
      sandbox_ip: "172.30.0.5",
    });
    expect(err).toBeNull();
    expect(result.status).toBe("succeeded");
  });

  it("handles fetch errors gracefully", async () => {
    mockFetch.mockRejectedValue(new Error("network down"));
    (createAuditEntry as jest.Mock).mockImplementation(() => {});

    const { err, result } = await callTool({
      agent_id: "default/agent-1",
      execution_id: "exec-1",
      tool_name: "google_search",
      args: { q: "test" },
    });
    expect(err).toBeNull();
    expect(result.status).toBe("failed");
    expect(result.error_message).toMatch(/Tool execution failed/);
  });

  it("uses user_id for rate limiting when present in metadata", async () => {
    mockFetch.mockResolvedValue(new Response("ok", { status: 200 }));
    (createAuditEntry as jest.Mock).mockImplementation(() => {});

    const { err, result } = await callTool(
      {
        agent_id: "default/agent-1",
        execution_id: "exec-1",
        tool_name: "google_search",
        args: { q: "test" },
      },
      { "x-user-id": "user-42" }
    );
    expect(err).toBeNull();
    expect(result.status).toBe("succeeded");
  });

  it("validates database_query args (blocked chars)", async () => {
    const { err, result } = await callTool({
      agent_id: "default/agent-1",
      execution_id: "exec-1",
      tool_name: "database_query",
      args: { query: "SELECT 1; DROP TABLE users;" },
      sandbox_ip: "172.30.0.5",
    });
    expect(err).toBeNull();
    expect(result.status).toBe("failed");
    expect(result.error_message).toMatch(/blocked characters/);
  });

  it("validates file_write args (oversized)", async () => {
    const { err, result } = await callTool({
      agent_id: "default/agent-1",
      execution_id: "exec-1",
      tool_name: "file_write",
      args: { path: "/tmp/out.txt", content: "x".repeat(1000001) },
      sandbox_ip: "172.30.0.5",
    });
    expect(err).toBeNull();
    expect(result.status).toBe("failed");
    expect(result.error_message).toMatch(/Content too large/);
  });

  it("validates file_read args (traversal)", async () => {
    const { err, result } = await callTool({
      agent_id: "default/agent-1",
      execution_id: "exec-1",
      tool_name: "file_read",
      args: { path: "../secret" },
      sandbox_ip: "172.30.0.5",
    });
    expect(err).toBeNull();
    expect(result.status).toBe("failed");
    expect(result.error_message).toMatch(/Invalid path/);
  });

  it("returns SERVING on health check", async () => {
    const handler = handlers.get("/grpc.health.v1.Health/Check")!;
    const result = await new Promise<any>((resolve) => {
      handler.func({ request: {} }, (err: any, res: any) => resolve({ err, res }));
    });
    expect(result.err).toBeNull();
    expect(result.res.status).toBe("SERVING");
  });
});

