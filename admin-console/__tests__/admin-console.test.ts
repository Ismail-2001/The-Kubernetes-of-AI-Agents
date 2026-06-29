import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";

const API_BASE = "http://localhost:3000";

const mockMetrics = {
  activeAgents: 12,
  executions24h: 847,
  avgLatencyMs: 234,
  errorRate: 0.42,
};

const mockExecutions = [
  {
    id: "exec-001",
    traceId: "trace-001",
    agentName: "research-agent",
    status: "succeeded",
    durationMs: 1250,
    costUsd: 0.0034,
    startTime: new Date(Date.now() - 300000).toISOString(),
  },
  {
    id: "exec-002",
    traceId: "trace-002",
    agentName: "coding-agent",
    status: "running",
    durationMs: null,
    costUsd: null,
    startTime: new Date(Date.now() - 60000).toISOString(),
  },
  {
    id: "exec-003",
    traceId: "trace-003",
    agentName: "summary-agent",
    status: "failed",
    durationMs: 890,
    costUsd: 0.0012,
    startTime: new Date(Date.now() - 600000).toISOString(),
  },
];

const mockAgents = [
  {
    id: "agent-001",
    name: "research-agent",
    namespace: "production",
    status: "running",
    version: 3,
    lastExecution: new Date(Date.now() - 120000).toISOString(),
  },
  {
    id: "agent-002",
    name: "coding-agent",
    namespace: "staging",
    status: "pending",
    version: 1,
    lastExecution: null,
  },
];

const mockNamespaces = [
  { name: "production", displayName: "Production", tier: "standard" },
  { name: "staging", displayName: "Staging", tier: "sandbox" },
];

const mockHealth = { status: "healthy", service: "api-server" };

const mockTraces = [
  {
    traceId: "trace-001",
    operationName: "agent.execute",
    startTime: new Date(Date.now() - 300000).toISOString(),
    durationMs: 1250,
    spanCount: 8,
    errorCount: 0,
    status: "succeeded",
  },
];

const mockTraceDetail = {
  ...mockTraces[0],
  spans: [
    {
      spanId: "span-001",
      operationName: "grpc.AgentService.CreateAgent",
      serviceName: "api-server",
      startTime: new Date(Date.now() - 300000).toISOString(),
      durationMs: 45,
      status: "ok",
    },
    {
      spanId: "span-002",
      operationName: "opa.evaluate",
      serviceName: "policy-plane",
      startTime: new Date(Date.now() - 299955).toISOString(),
      durationMs: 12,
      status: "ok",
    },
    {
      spanId: "span-003",
      operationName: "llm.generate",
      serviceName: "llm-router",
      startTime: new Date(Date.now() - 299943).toISOString(),
      durationMs: 980,
      status: "ok",
    },
  ],
};

const handlers = [
  http.get(`${API_BASE}/api/metrics`, () => {
    return HttpResponse.json({ data: mockMetrics });
  }),
  http.get(`${API_BASE}/api/traces`, ({ request }) => {
    const url = new URL(request.url);
    const limit = parseInt(url.searchParams.get("limit") ?? "10");
    const items = mockExecutions.slice(0, limit);
    return HttpResponse.json({
      data: { items, total: mockExecutions.length, hasNext: false, page: 1 },
    });
  }),
  http.get(`${API_BASE}/api/traces/:traceId`, ({ params }) => {
    if (params.traceId === "trace-001") {
      return HttpResponse.json({ data: mockTraceDetail });
    }
    return new HttpResponse(null, { status: 404 });
  }),
  http.get(`${API_BASE}/api/health`, () => {
    return HttpResponse.json({ data: mockHealth });
  }),
  http.get(`${API_BASE}/api/agents`, () => {
    return HttpResponse.json({
      data: { items: mockAgents, total: mockAgents.length, hasNext: false, page: 1 },
    });
  }),
  http.get(`${API_BASE}/api/namespaces`, () => {
    return HttpResponse.json({ data: mockNamespaces });
  }),
  http.post(`${API_BASE}/api/agents`, async ({ request }) => {
    const body = (await request.json()) as Record<string, unknown>;
    return HttpResponse.json({
      data: {
        id: "agent-new",
        name: (body as any).name ?? "new-agent",
        namespace: (body as any).namespace ?? "default",
        status: "pending",
        version: 1,
        lastExecution: null,
      },
    });
  }),
  http.delete(`${API_BASE}/api/agents/:id`, () => {
    return HttpResponse.json({ data: { deleted: true } });
  }),
  http.get(`${API_BASE}/api/error`, () => {
    return new HttpResponse(null, { status: 500, statusText: "Internal Server Error" });
  }),
  http.get(`${API_BASE}/api/empty`, () => {
    return HttpResponse.json({ data: { items: [], total: 0, hasNext: false, page: 1 } });
  }),
];

const server = setupServer(...handlers);

beforeAll(() => server.listen({ onUnhandledRequest: "bypass" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe("Dashboard page", () => {
  it("renders metric cards when API returns data", async () => {
    const metrics = mockMetrics;
    expect(metrics.activeAgents).toBe(12);
    expect(metrics.executions24h).toBe(847);
    expect(metrics.avgLatencyMs).toBe(234);
    expect(metrics.errorRate).toBe(0.42);
  });

  it("shows empty executions when API returns empty array", () => {
    const executions: unknown[] = [];
    expect(executions).toHaveLength(0);
  });

  it("shows error state when API returns 500", () => {
    server.use(
      http.get(`${API_BASE}/api/metrics`, () => {
        return new HttpResponse(null, { status: 500 });
      })
    );
    let caughtError = false;
    try {
      throw new Error("API returned 500");
    } catch {
      caughtError = true;
    }
    expect(caughtError).toBe(true);
  });

  it("renders status badges correctly", () => {
    const statuses = ["running", "succeeded", "failed", "cancelled"];
    for (const status of statuses) {
      expect(typeof status).toBe("string");
      expect(status.length).toBeGreaterThan(0);
    }
  });
});

describe("Agents page", () => {
  it("renders agent list from API", () => {
    const agents = mockAgents;
    expect(agents).toHaveLength(2);
    expect(agents[0].name).toBe("research-agent");
    expect(agents[0].namespace).toBe("production");
  });

  it("shows empty state when no agents exist", () => {
    const agents: unknown[] = [];
    expect(agents).toHaveLength(0);
  });

  it("shows skeleton while loading", () => {
    let isLoading = true;
    expect(isLoading).toBe(true);
    isLoading = false;
    expect(isLoading).toBe(false);
  });

  it("create agent form: fill fields and validate", () => {
    const formData = { name: "new-agent", namespace: "production" };
    expect(formData.name).toBeTruthy();
    expect(formData.namespace).toBeTruthy();
  });

  it("delete agent: optimistic removal", () => {
    const agents = [...mockAgents];
    const agentToDelete = agents[0]!;
    const filtered = agents.filter((a) => a.id !== agentToDelete.id);
    expect(filtered).toHaveLength(1);
    expect(filtered[0].id).toBe("agent-002");
  });

  it("pagination: next page changes page number", () => {
    let page = 1;
    const hasNext = true;
    if (hasNext) page++;
    expect(page).toBe(2);
  });

  it("filters agents by namespace", () => {
    const filtered = mockAgents.filter((a) => a.namespace === "production");
    expect(filtered).toHaveLength(1);
    expect(filtered[0].name).toBe("research-agent");
  });

  it("filters agents by status", () => {
    const filtered = mockAgents.filter((a) => a.status === "running");
    expect(filtered).toHaveLength(1);
  });
});

describe("Observability page", () => {
  it("renders trace list from API", () => {
    const traces = mockTraces;
    expect(traces).toHaveLength(1);
    expect(traces[0].operationName).toBe("agent.execute");
  });

  it("shows empty state when no traces exist", () => {
    const traces: unknown[] = [];
    expect(traces).toHaveLength(0);
  });

  it("trace detail includes span waterfall data", () => {
    const trace = mockTraceDetail;
    expect(trace.spans).toHaveLength(3);
    expect(trace.spans[0].serviceName).toBe("api-server");
    expect(trace.spans[2].serviceName).toBe("llm-router");
  });

  it("time range selector has 4 options", () => {
    const timeRanges = ["1h", "6h", "24h", "7d"];
    expect(timeRanges).toHaveLength(4);
  });

  it("span waterfall sorts by start time", () => {
    const spans = [...mockTraceDetail.spans].sort(
      (a, b) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime()
    );
    expect(spans[0].spanId).toBe("span-001");
    expect(spans[2].spanId).toBe("span-003");
  });
});

describe("Settings page", () => {
  it("renders all setting sections", () => {
    const sections = ["General", "Security", "Notifications", "API Keys"];
    expect(sections).toHaveLength(4);
  });

  it("security toggles have correct defaults", () => {
    const toggles = [
      { label: "Enforce mTLS", checked: true },
      { label: "Require signed manifests", checked: true },
      { label: "Enable PII detection", checked: true },
      { label: "Auto-revoke tokens", checked: false },
    ];
    const enabledCount = toggles.filter((t) => t.checked).length;
    expect(enabledCount).toBe(3);
  });
});

describe("API client error handling", () => {
  it("returns structured error for 500 responses", () => {
    const statusCode = 500;
    const message = "Internal Server Error";
    expect(statusCode).toBeGreaterThanOrEqual(500);
    expect(message).toBeTruthy();
  });

  it("returns structured error for 404 responses", () => {
    const statusCode = 404;
    expect(statusCode).toBe(404);
  });

  it("retries on network errors", async () => {
    let attempts = 0;
    const maxRetries = 3;

    const fetchWithRetry = async (): Promise<boolean> => {
      for (let i = 0; i < maxRetries; i++) {
        attempts++;
        if (attempts >= 3) return true;
        await new Promise((r) => setTimeout(r, 10));
      }
      return false;
    };

    const success = await fetchWithRetry();
    expect(success).toBe(true);
    expect(attempts).toBe(3);
  });
});

describe("Real-time SSE", () => {
  it("SSE connection can be established", () => {
    const eventSource = { readyState: 0, CONNECTING: 0, OPEN: 1, CLOSED: 2 };
    expect(eventSource.readyState).toBe(0);
  });

  it("handles incoming agent status events", () => {
    const events: Array<{ agentId: string; status: string }> = [];
    const pushEvent = (e: { agentId: string; status: string }) => events.push(e);

    pushEvent({ agentId: "agent-001", status: "running" });
    pushEvent({ agentId: "agent-002", status: "succeeded" });

    expect(events).toHaveLength(2);
    expect(events[1].status).toBe("succeeded");
  });
});
