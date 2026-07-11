import http from "http";
import fs from "fs";
import path from "path";

// ─── Mock HTTP server for policy-plane ─────────────────────────────────────

function createMockPolicyServer(
  handler: (
    req: http.IncomingMessage,
    res: http.ServerResponse,
    body: string
  ) => void
): Promise<{ server: http.Server; port: number }> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        handler(req, res, Buffer.concat(chunks).toString());
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port =
        typeof addr === "object" && addr !== null ? addr.port : 0;
      resolve({ server, port });
    });
  });
}

// ─── Tests ─────────────────────────────────────────────────────────────────

// Import the evaluatePolicy function directly (it only uses http, no gRPC)
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { evaluatePolicy } = require("../temporal/activities") as typeof import("../temporal/activities");

describe("Workflow Engine — evaluatePolicy (real OPA path)", () => {
  const savedEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...savedEnv };
  });

  it("should return allow when OPA permits", async () => {
    const { server, port } = await createMockPolicyServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ result: { allow: true, reason: "" } }));
    });

    process.env.POLICY_PLANE_ADDR = `http://127.0.0.1:${port}`;
    try {
      const result = await evaluatePolicy({
        agentId: "agent-1",
        executionId: "exec-1",
        namespace: "sandbox-a",
        action: "execute",
      });
      expect(result.allow).toBe(true);
      expect(result.reason).toBe("");
    } finally {
      server.close();
    }
  }, 10000);

  it("should return deny when OPA denies", async () => {
    const { server, port } = await createMockPolicyServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          result: { allow: false, reason: "Cross-namespace access denied" },
        })
      );
    });

    process.env.POLICY_PLANE_ADDR = `http://127.0.0.1:${port}`;
    try {
      const result = await evaluatePolicy({
        agentId: "agent-1",
        executionId: "exec-1",
        namespace: "sandbox-b",
        action: "execute",
      });
      expect(result.allow).toBe(false);
      expect(result.reason).toContain("Cross-namespace");
    } finally {
      server.close();
    }
  });

  it("should fail-closed (deny) when policy-plane is unreachable", async () => {
    process.env.POLICY_PLANE_ADDR = "http://127.0.0.1:1";
    const result = await evaluatePolicy({
      agentId: "agent-1",
      executionId: "exec-1",
      namespace: "sandbox-a",
      action: "execute",
    });
    expect(result.allow).toBe(false);
    expect(result.reason).toContain("failed");
  });

  it("should deny when OPA returns non-200 status", async () => {
    const { server, port } = await createMockPolicyServer((_req, res) => {
      res.writeHead(503);
      res.end("Service Unavailable");
    });

    process.env.POLICY_PLANE_ADDR = `http://127.0.0.1:${port}`;
    try {
      const result = await evaluatePolicy({
        agentId: "agent-1",
        executionId: "exec-1",
        namespace: "sandbox-a",
        action: "execute",
      });
      expect(result.allow).toBe(false);
      expect(result.reason).toContain("503");
    } finally {
      server.close();
    }
  });

  it("should deny when OPA returns invalid JSON", async () => {
    const { server, port } = await createMockPolicyServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("not json");
    });

    process.env.POLICY_PLANE_ADDR = `http://127.0.0.1:${port}`;
    try {
      const result = await evaluatePolicy({
        agentId: "agent-1",
        executionId: "exec-1",
        namespace: "sandbox-a",
        action: "execute",
      });
      // Non-JSON 200 response: postJSON resolves with { error: "not json" }
      // evaluatePolicy sees no result.allow field, defaults to deny
      expect(result.allow).toBe(false);
      expect(result.reason).toBeTruthy();
    } finally {
      server.close();
    }
  });

  it("should deny when connection times out", async () => {
    process.env.POLICY_PLANE_ADDR = "http://192.0.2.1:1";
    const result = await evaluatePolicy({
      agentId: "agent-1",
      executionId: "exec-1",
      namespace: "sandbox-a",
      action: "execute",
    });
    expect(result.allow).toBe(false);
    expect(result.reason).toContain("failed");
  }, 15000);
});

describe("Workflow Engine — No fake evaluatePolicy stub", () => {
  it("should not contain a hardcoded allow pattern in temporal activities", () => {
    const activitiesPath = path.resolve(
      __dirname,
      "..",
      "temporal",
      "activities",
      "index.ts"
    );
    const content = fs.readFileSync(activitiesPath, "utf8");

    expect(content).not.toContain("return { status: 'allow' as const");
    expect(content).not.toContain('return { status: "allow"');
    expect(content).toContain("/v1/data/");
    expect(content).toContain("policy-plane");
  });

  it("should not have legacy activities/agent.ts file", () => {
    const legacyPath = path.resolve(__dirname, "..", "activities", "agent.ts");
    expect(fs.existsSync(legacyPath)).toBe(false);
  });

  it("should not have legacy workflows/agent.ts file", () => {
    const legacyPath = path.resolve(__dirname, "..", "workflows", "agent.ts");
    expect(fs.existsSync(legacyPath)).toBe(false);
  });

  it("should not have legacy client.ts file", () => {
    const legacyPath = path.resolve(__dirname, "..", "client.ts");
    expect(fs.existsSync(legacyPath)).toBe(false);
  });

  it("Worker.create should point to temporal/ path, not root workflows/", () => {
    const indexPath = path.resolve(__dirname, "..", "index.ts");
    const content = fs.readFileSync(indexPath, "utf8");

    expect(content).toContain(
      "path.join(__dirname, 'temporal', 'workflows')"
    );
    expect(content).toContain(
      "path.join(__dirname, 'temporal', 'activities')"
    );
    expect(content).not.toContain("path.join(__dirname, 'workflows')");
    expect(content).not.toContain("path.join(__dirname, 'activities')");
  });
});
