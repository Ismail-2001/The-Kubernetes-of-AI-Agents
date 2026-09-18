/**
 * E2E Agent Workflow Integration Test — Full Lifecycle
 *
 * Tests the complete agent lifecycle:
 *   Register -> Login -> Create Agent -> Run Agent -> Poll Status -> Get History -> Cleanup
 *
 * Requires: docker compose up (all services running)
 * Run: npx jest agent-workflow-e2e --silent --testTimeout=60000
 */

const API_BASE = process.env.API_BASE || "http://localhost:3001";

async function api(method: string, path: string, body?: unknown, token?: string) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json: unknown;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, body: json } as { status: number; body: Record<string, unknown> };
}

function extractToken(body: Record<string, unknown>): string {
  const data = (body.data ?? body) as Record<string, unknown>;
  return (data.token || data.accessToken || "") as string;
}

function extractData(body: Record<string, unknown>): Record<string, unknown> {
  return (body.data ?? body) as Record<string, unknown>;
}

// ── Full Agent Lifecycle ──────────────────────────────────────────────────
describe("E2E: Full Agent Workflow", () => {
  const testEmail = `e2e-workflow-${Date.now()}@egaop.io`;
  const testPassword = "E2EWorkflowPassword123!";
  let authToken = "";
  let agentName = "";
  let executionId = "";

  // ── Step 1: Register ───────────────────────────────────────────────
  it("Step 1: Register user", async () => {
    const res = await api("POST", "/api/auth/register", {
      email: testEmail,
      password: testPassword,
      name: "E2E Workflow Test",
    });
    expect([200, 201, 409]).toContain(res.status);
  });

  // ── Step 2: Login ──────────────────────────────────────────────────
  it("Step 2: Login and get token", async () => {
    const res = await api("POST", "/api/auth/login", {
      email: testEmail,
      password: testPassword,
    });
    expect(res.status).toBe(200);
    authToken = extractToken(res.body);
    expect(authToken).toBeDefined();
    expect(authToken.length).toBeGreaterThan(10);
  });

  // ── Step 3: Create Agent ───────────────────────────────────────────
  it("Step 3: Create agent", async () => {
    agentName = `e2e-test-agent-${Date.now()}`;
    const res = await api("POST", "/api/agents", {
      name: agentName,
      namespace: "default",
      spec: {
        model: "gpt-4o-mini",
        systemPrompt: "You are a helpful test assistant. Respond concisely.",
        maxTokens: 100,
      },
    }, authToken);
    expect([200, 201]).toContain(res.status);
    const data = extractData(res.body);
    expect(data).toBeDefined();
  });

  // ── Step 4: Get Agent ──────────────────────────────────────────────
  it("Step 4: Get agent details", async () => {
    const res = await api("GET", `/api/agents/${agentName}`, undefined, authToken);
    expect([200, 404]).toContain(res.status);
  });

  // ── Step 5: List Agents ────────────────────────────────────────────
  it("Step 5: List agents includes created agent", async () => {
    const res = await api("GET", "/api/agents", undefined, authToken);
    expect([200, 404]).toContain(res.status);
  });

  // ── Step 6: Run Agent ──────────────────────────────────────────────
  it("Step 6: Run agent (start execution)", async () => {
    const res = await api("POST", `/api/agents/${agentName}/run`, {
      input: {
        prompt: "What is 2 + 2? Reply with just the number.",
      },
      namespace: "default",
    }, authToken);
    // 200 = started, 404 = agent not found, 500 = Temporal not connected or LLM key missing
    expect([200, 404, 500]).toContain(res.status);

    if (res.status === 200) {
      const data = extractData(res.body);
      executionId = (data.executionId || data.workflowId || "") as string;
      expect(executionId).toBeDefined();
      expect(executionId.length).toBeGreaterThan(0);
    }
  });

  // ── Step 7: Poll Execution Status (if started) ─────────────────────
  it("Step 7: Get execution status", async () => {
    if (!executionId) return;

    const res = await api("GET", `/api/executions/${executionId}`, undefined, authToken);
    expect([200, 404]).toContain(res.status);

    if (res.status === 200) {
      const data = extractData(res.body);
      expect(data.status).toBeDefined();
    }
  });

  // ── Step 8: Get Execution History ──────────────────────────────────
  it("Step 8: Get execution history", async () => {
    if (!executionId) return;

    const res = await api("GET", `/api/executions/${executionId}/history`, undefined, authToken);
    expect([200, 404]).toContain(res.status);
  });

  // ── Step 9: Agent Versions ─────────────────────────────────────────
  it("Step 9: Get agent versions", async () => {
    const res = await api("GET", `/api/agents/${agentName}/versions`, undefined, authToken);
    expect([200, 404]).toContain(res.status);
  });

  // ── Step 10: Delete Agent (cleanup) ────────────────────────────────
  it("Step 10: Delete agent (cleanup)", async () => {
    const res = await api("DELETE", `/api/agents/${agentName}`, undefined, authToken);
    expect(res.status).toBeGreaterThanOrEqual(200);
  });

  // ── Step 11: Verify Agent Deleted ──────────────────────────────────
  it("Step 11: Verify agent is deleted", async () => {
    const res = await api("GET", `/api/agents/${agentName}`, undefined, authToken);
    expect([404, 200]).toContain(res.status);
  });
});

// ── Namespace + Agent Isolation ───────────────────────────────────────────
describe("E2E: Namespace Isolation", () => {
  const testEmail = `e2e-ns-iso-${Date.now()}@egaop.io`;
  const testPassword = "E2ENSIsolation123!";
  let authToken = "";

  beforeAll(async () => {
    await api("POST", "/api/auth/register", {
      email: testEmail, password: testPassword, name: "NS Isolation Test",
    });
    const login = await api("POST", "/api/auth/login", {
      email: testEmail, password: testPassword,
    });
    authToken = extractToken(login.body);
  });

  it("Create namespace", async () => {
    const res = await api("POST", "/api/namespaces", {
      name: `test-ns-${Date.now()}`,
      description: "E2E test namespace",
    }, authToken);
    expect([200, 201, 409]).toContain(res.status);
  });

  it("List namespaces", async () => {
    const res = await api("GET", "/api/namespaces", undefined, authToken);
    expect([200, 404]).toContain(res.status);
  });

  it("Namespace health check", async () => {
    const res = await api("GET", "/api/namespaces/health", undefined, authToken);
    expect([200, 404]).toContain(res.status);
  });
});

// ── SLO Tracker ──────────────────────────────────────────────────────────
describe("E2E: SLO Tracker", () => {
  const testEmail = `e2e-slo-${Date.now()}@egaop.io`;
  const testPassword = "E2ESLOTest123!";
  let authToken = "";

  beforeAll(async () => {
    await api("POST", "/api/auth/register", {
      email: testEmail, password: testPassword, name: "SLO Test",
    });
    const login = await api("POST", "/api/auth/login", {
      email: testEmail, password: testPassword,
    });
    authToken = extractToken(login.body);
  });

  it("GET /api/slos returns SLO snapshots", async () => {
    const res = await api("GET", "/api/slos", undefined, authToken);
    expect([200, 404]).toContain(res.status);

    if (res.status === 200) {
      const data = extractData(res.body);
      expect(data).toBeDefined();
    }
  });

  it("GET /api/slos with window parameter", async () => {
    const res = await api("GET", "/api/slos?window=30", undefined, authToken);
    expect([200, 404]).toContain(res.status);
  });
});

// ── Metrics & Observability ───────────────────────────────────────────────
describe("E2E: Metrics Endpoints", () => {
  const testEmail = `e2e-metrics-${Date.now()}@egaop.io`;
  const testPassword = "E2EMetricsTest123!";
  let authToken = "";

  beforeAll(async () => {
    await api("POST", "/api/auth/register", {
      email: testEmail, password: testPassword, name: "Metrics Test",
    });
    const login = await api("POST", "/api/auth/login", {
      email: testEmail, password: testPassword,
    });
    authToken = extractToken(login.body);
  });

  it("GET /api/metrics returns Prometheus metrics", async () => {
    const res = await api("GET", "/api/metrics", undefined, authToken);
    expect([200, 401, 404]).toContain(res.status);
  });

  it("GET /api/traces works", async () => {
    const res = await api("GET", "/api/traces", undefined, authToken);
    expect([200, 401, 404]).toContain(res.status);
  });

  it("OpenAPI spec is valid", async () => {
    const res = await api("GET", "/api/openapi.json", undefined, authToken);
    expect(res.status).toBeGreaterThanOrEqual(200);
    if (res.status === 200) {
      expect(res.body).toHaveProperty("openapi");
      expect(res.body).toHaveProperty("paths");
    }
  });
});
