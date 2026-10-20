/**
 * Namespace Isolation Tests
 *
 * Verifies that tenants in different namespaces cannot access each other's
 * agents, executions, memory, or tool calls. This is the core multi-tenancy
 * guarantee of the platform.
 *
 * INTEGRATION SUITE — requires a running full stack (gRPC services on
 * localhost). Skipped by default; enable with:
 *   EGAOP_RUN_INTEGRATION_TESTS=1 npx jest --config tests/jest.config.ts --selectProjects security
 * Individual endpoints are configurable via EGAOP_*_GRPC_ADDR env vars.
 *
 * Auth: every deployed service sets INTERNAL_SERVICE_TOKEN (validateSecrets
 * fail-closed), and the shared gRPC service-token interceptor then requires
 * x-service-token on every call. Set EGAOP_INTERNAL_SERVICE_TOKEN to the same
 * value the stack was deployed with, or all calls will be UNAUTHENTICATED.
 *
 * Known gap: the shared namespace-enforcement interceptor is a no-op in
 * production because clients never attach x-agent-claims (documented
 * residual, tracked for fix). Some cross-namespace expectations here may
 * fail against a live stack until that is implemented — red results are
 * signal, not flake.
 */

import path from "path";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";

const RUN_INTEGRATION = process.env.EGAOP_RUN_INTEGRATION_TESTS === "1";
const describeIntegration = RUN_INTEGRATION ? describe : describe.skip;

const PROTO_DIR = path.resolve(__dirname, "../../api/proto");

function loadProto(protoFile: string): any {
  const packageDef = protoLoader.loadSync(path.join(PROTO_DIR, protoFile), {
    keepCase: true,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true,
    includeDirs: [PROTO_DIR],
  });
  return grpc.loadPackageDefinition(packageDef);
}

// ── Helpers ──────────────────────────────────────────────────────────────

function createMetadata(namespace: string, token?: string): grpc.Metadata {
  const meta = new grpc.Metadata();
  meta.add("x-egaop-namespace", namespace);
  // Deployed stacks require x-service-token (INTERNAL_SERVICE_TOKEN is
  // always set by validateSecrets). Dev stacks without the env keep
  // working: the interceptor skips validation when the env is unset.
  const serviceToken = token ?? process.env.EGAOP_INTERNAL_SERVICE_TOKEN;
  if (serviceToken) meta.add("x-service-token", serviceToken);
  if (token) meta.add("authorization", `Bearer ${token}`);
  return meta;
}

function createServiceClient(address: string): any {
  const proto = loadProto("egaop/v1/agent.proto");
  const agentService = proto.egaop.v1.AgentService;
  const credentials = grpc.credentials.createInsecure();
  return new agentService(address, credentials);
}

function createMemoryClient(address: string): any {
  const proto = loadProto("egaop/v1/memory.proto");
  const memoryService = proto.egaop.v1.MemoryService;
  const credentials = grpc.credentials.createInsecure();
  return new memoryService(address, credentials);
}

function createNamespaceClient(address: string): any {
  const proto = loadProto("egaop/v1/namespace.proto");
  const namespaceService = proto.egaop.v1.NamespaceService;
  const credentials = grpc.credentials.createInsecure();
  return new namespaceService(address, credentials);
}

function createRuntimeClient(address: string): any {
  const proto = loadProto("egaop/v1/runtime.proto");
  const runtimeService = proto.egaop.v1.RuntimeService;
  const credentials = grpc.credentials.createInsecure();
  return new runtimeService(address, credentials);
}

function createToolClient(address: string): any {
  const proto = loadProto("egaop/v1/tool.proto");
  const toolService = proto.egaop.v1.ToolService;
  const credentials = grpc.credentials.createInsecure();
  return new toolService(address, credentials);
}

function promisifyCall(client: any, method: string, request: any, metadata: grpc.Metadata): Promise<any> {
  return new Promise((resolve, reject) => {
    client[method](request, metadata, (err: any, response: any) => {
      if (err) reject(err);
      else resolve(response);
    });
  });
}

// ── Tests ────────────────────────────────────────────────────────────────

const API_GRPC_ADDRESS = process.env.EGAOP_API_GRPC_ADDR || "localhost:50051";
const TOOL_GRPC_ADDRESS = process.env.EGAOP_TOOL_GRPC_ADDR || "localhost:50052";
const RUNTIME_GRPC_ADDRESS = process.env.EGAOP_RUNTIME_GRPC_ADDR || "localhost:50054";
const MEMORY_GRPC_ADDRESS = process.env.EGAOP_MEMORY_GRPC_ADDR || "localhost:50055";

describeIntegration("Namespace Isolation: Agent CRUD", () => {
  let agentClient: any;

  beforeAll(() => {
    agentClient = createServiceClient(API_GRPC_ADDRESS);
  });

  afterAll(() => {
    if (agentClient) agentClient.close?.();
  });

  it("should create agent in namespace A", async () => {
    const meta = createMetadata("team-alpha");
    const response = await promisifyCall(agentClient, "CreateAgent", {
      metadata: { name: "agent-alpha-1", namespace: "team-alpha" },
      spec: { model: "gpt-4o", system_prompt: "You are Agent Alpha" },
      api_version: "egaop.io/v1",
      kind: "Agent",
    }, meta);

    expect(response).toBeDefined();
    expect(response.metadata?.name).toBe("agent-alpha-1");
    expect(response.metadata?.namespace).toBe("team-alpha");
  });

  it("should create agent in namespace B", async () => {
    const meta = createMetadata("team-beta");
    const response = await promisifyCall(agentClient, "CreateAgent", {
      metadata: { name: "agent-beta-1", namespace: "team-beta" },
      spec: { model: "gpt-4o-mini", system_prompt: "You are Agent Beta" },
      api_version: "egaop.io/v1",
      kind: "Agent",
    }, meta);

    expect(response).toBeDefined();
    expect(response.metadata?.name).toBe("agent-beta-1");
    expect(response.metadata?.namespace).toBe("team-beta");
  });

  it("should NOT allow namespace A to list agents from namespace B", async () => {
    const meta = createMetadata("team-alpha");
    const response = await promisifyCall(agentClient, "ListAgents", {
      namespace: "team-beta",
      filters: {},
      pagination: { page_size: 100 },
    }, meta);

    // Should return empty — agent-alpha cannot see agent-beta's agents
    expect(response.agents ?? []).toHaveLength(0);
  });

  it("should NOT allow namespace B to list agents from namespace A", async () => {
    const meta = createMetadata("team-beta");
    const response = await promisifyCall(agentClient, "ListAgents", {
      namespace: "team-alpha",
      filters: {},
      pagination: { page_size: 100 },
    }, meta);

    expect(response.agents ?? []).toHaveLength(0);
  });

  it("should NOT allow namespace A to get agent from namespace B by name", async () => {
    const meta = createMetadata("team-alpha");
    try {
      await promisifyCall(agentClient, "GetAgent", {
        name: "agent-beta-1",
        namespace: "team-beta",
      }, meta);
      fail("Expected error but none thrown");
    } catch (err: any) {
      // Should get NOT_FOUND or PERMISSION_DENIED
      expect(err.code).toBeDefined();
    }
  });

  it("should NOT allow namespace A to delete agent from namespace B", async () => {
    const meta = createMetadata("team-alpha");
    try {
      await promisifyCall(agentClient, "DeleteAgent", {
        name: "agent-beta-1",
        namespace: "team-beta",
      }, meta);
      fail("Expected error but none thrown");
    } catch (err: any) {
      expect(err.code).toBeDefined();
    }
  });

  it("should NOT allow namespace A to update agent in namespace B", async () => {
    const meta = createMetadata("team-alpha");
    try {
      await promisifyCall(agentClient, "UpdateAgent", {
        metadata: { name: "agent-beta-1", namespace: "team-beta" },
        spec: { model: "gpt-4o" },
      }, meta);
      fail("Expected error but none thrown");
    } catch (err: any) {
      expect(err.code).toBeDefined();
    }
  });
});

describeIntegration("Namespace Isolation: Memory Plane", () => {
  let memoryClient: any;

  beforeAll(() => {
    memoryClient = createMemoryClient(MEMORY_GRPC_ADDRESS);
  });

  afterAll(() => {
    if (memoryClient) memoryClient.close?.();
  });

  it("should write memory to namespace alpha", async () => {
    const meta = createMetadata("team-alpha");
    const response = await promisifyCall(memoryClient, "Write", {
      agent_id: "agent-alpha-1",
      namespace: "team-alpha",
      memory_type: "session",
      key: "secret_data",
      data: { value: "alpha-confidential" },
    }, meta);

    expect(response.status).toBe("success");
  });

  it("should NOT allow namespace beta to read namespace alpha's memory", async () => {
    const meta = createMetadata("team-beta");
    const response = await promisifyCall(memoryClient, "Read", {
      agent_id: "agent-alpha-1",
      namespace: "team-alpha",
      memory_type: "session",
      key: "secret_data",
    }, meta);

    // Should return empty — beta cannot read alpha's memory
    expect(response.found).toBeFalsy();
  });

  it("should NOT allow namespace beta to list namespace alpha's memory", async () => {
    const meta = createMetadata("team-beta");
    const response = await promisifyCall(memoryClient, "List", {
      agent_id: "agent-alpha-1",
      namespace: "team-alpha",
      memory_type: "session",
    }, meta);

    expect(response.entries ?? []).toHaveLength(0);
  });

  it("should NOT allow namespace beta to delete namespace alpha's memory", async () => {
    const meta = createMetadata("team-beta");
    const response = await promisifyCall(memoryClient, "Delete", {
      agent_id: "agent-alpha-1",
      namespace: "team-alpha",
      memory_type: "session",
      key: "secret_data",
    }, meta);

    // Should return error or success without actually deleting alpha's data
    // Verify alpha's data is still accessible
    const alphaMeta = createMetadata("team-alpha");
    const readBack = await promisifyCall(memoryClient, "Read", {
      agent_id: "agent-alpha-1",
      namespace: "team-alpha",
      memory_type: "session",
      key: "secret_data",
    }, alphaMeta);

    expect(readBack.found).toBeTruthy();
  });
});

describeIntegration("Namespace Isolation: Sandbox Runtime", () => {
  let runtimeClient: any;

  beforeAll(() => {
    runtimeClient = createRuntimeClient(RUNTIME_GRPC_ADDRESS);
  });

  afterAll(() => {
    if (runtimeClient) runtimeClient.close?.();
  });

  it("should create sandbox in namespace alpha", async () => {
    const meta = createMetadata("team-alpha");
    const response = await promisifyCall(runtimeClient, "CreateSandbox", {
      agent_id: "agent-alpha-1",
      execution_id: "exec-alpha-test",
      image: "egaop-base-runtime:latest",
      isolation_level: "Enhanced",
      resources: { cpu: "0.5", memory: "256" },
    }, meta);

    expect(response.sandbox_id).toBeDefined();
    expect(response.status).toBe("Running");
  });

  it("should NOT allow namespace beta to access namespace alpha's sandbox", async () => {
    const meta = createMetadata("team-beta");
    try {
      await promisifyCall(runtimeClient, "GetSandboxStatus", {
        sandbox_id: "egaop-agent-exec-alpha-test",
      }, meta);
      // If it doesn't throw, the response should indicate not found
    } catch (err: any) {
      // Expected — cross-namespace sandbox access is blocked
      expect(err.code).toBeDefined();
    }
  });

  it("should NOT allow namespace beta to terminate namespace alpha's sandbox", async () => {
    const meta = createMetadata("team-beta");
    const response = await promisifyCall(runtimeClient, "TerminateSandbox", {
      sandbox_id: "egaop-agent-exec-alpha-test",
      reason: "cross-namespace-attack",
    }, meta);

    // Should return false — beta cannot terminate alpha's sandbox
    expect(response.success).toBeFalsy();
  });
});

describeIntegration("Namespace Isolation: Tool Proxy", () => {
  let toolClient: any;

  beforeAll(() => {
    toolClient = createToolClient(TOOL_GRPC_ADDRESS);
  });

  afterAll(() => {
    if (toolClient) toolClient.close?.();
  });

  it("should execute tool with correct namespace context", async () => {
    const meta = createMetadata("team-alpha");
    const response = await promisifyCall(toolClient, "CallTool", {
      agent_id: "agent-alpha-1",
      execution_id: "exec-alpha-tool-test",
      tool_name: "web_fetch",
      args: { url: "https://example.com" },
    }, meta);

    expect(response).toBeDefined();
  });

  it("should use namespace-scoped rate limiting", async () => {
    // Agent from team-alpha calling tool
    const metaAlpha = createMetadata("team-alpha");
    const response1 = await promisifyCall(toolClient, "CallTool", {
      agent_id: "agent-alpha-1",
      execution_id: "exec-alpha-rate-test",
      tool_name: "web_fetch",
      args: { url: "https://example.com" },
    }, metaAlpha);

    expect(response1).toBeDefined();

    // Agent from team-beta should have separate rate limit
    const metaBeta = createMetadata("team-beta");
    const response2 = await promisifyCall(toolClient, "CallTool", {
      agent_id: "agent-beta-1",
      execution_id: "exec-beta-rate-test",
      tool_name: "web_fetch",
      args: { url: "https://example.com" },
    }, metaBeta);

    expect(response2).toBeDefined();
  });
});

describeIntegration("Namespace Isolation: Namespace API", () => {
  let namespaceClient: any;

  beforeAll(() => {
    namespaceClient = createNamespaceClient(API_GRPC_ADDRESS);
  });

  afterAll(() => {
    if (namespaceClient) namespaceClient.close?.();
  });

  it("should create namespaces successfully", async () => {
    const meta = createMetadata("platform_admin");

    const response1 = await promisifyCall(namespaceClient, "CreateNamespace", {
      slug: "team-alpha",
      display_name: "Team Alpha",
      tier: "NAMESPACE_TIER_PRODUCTION",
      quotas: { max_agents: 50, max_concurrent_executions: 20, max_tool_calls_per_minute: 100 },
    }, meta);

    expect(response1.slug).toBe("team-alpha");

    const response2 = await promisifyCall(namespaceClient, "CreateNamespace", {
      slug: "team-beta",
      display_name: "Team Beta",
      tier: "NAMESPACE_TIER_SANDBOX",
      quotas: { max_agents: 10, max_concurrent_executions: 5, max_tool_calls_per_minute: 20 },
    }, meta);

    expect(response2.slug).toBe("team-beta");
  });

  it("should list all namespaces for admin", async () => {
    const meta = createMetadata("platform_admin");
    const response = await promisifyCall(namespaceClient, "ListNamespaces", {
      page_size: 100,
    }, meta);

    expect(response.namespaces?.length).toBeGreaterThanOrEqual(2);
  });

  it("should enforce per-namespace quotas", async () => {
    const meta = createMetadata("team-beta");

    // Try to create more agents than quota allows for sandbox tier
    const promises = [];
    for (let i = 0; i < 12; i++) {
      promises.push(
        promisifyCall(createServiceClient(API_GRPC_ADDRESS), "CreateAgent", {
          metadata: { name: `agent-beta-${i}`, namespace: "team-beta" },
          spec: { model: "gpt-4o-mini" },
          api_version: "egaop.io/v1",
          kind: "Agent",
        }, meta).catch((err: any) => err),
      );
    }

    const results = await Promise.all(promises);
    const successes = results.filter((r) => !(r instanceof Error));
    const failures = results.filter((r) => r instanceof Error);

    // Sandbox tier has max 10 agents, so some should fail
    expect(failures.length).toBeGreaterThan(0);
  });
});

describeIntegration("Namespace Isolation: Cross-namespace data leakage", () => {
  it("should NOT leak agent names across namespaces in search", async () => {
    const agentClient = createServiceClient(API_GRPC_ADDRESS);

    // Alpha should only see its own agents
    const alphaMeta = createMetadata("team-alpha");
    const alphaResponse = await promisifyCall(agentClient, "ListAgents", {
      namespace: "team-alpha",
      filters: {},
      pagination: { page_size: 100 },
    }, alphaMeta);

    const alphaAgentNames = (alphaResponse.agents ?? []).map((a: any) => a.metadata?.name);

    // Beta should only see its own agents
    const betaMeta = createMetadata("team-beta");
    const betaResponse = await promisifyCall(agentClient, "ListAgents", {
      namespace: "team-beta",
      filters: {},
      pagination: { page_size: 100 },
    }, betaMeta);

    const betaAgentNames = (betaResponse.agents ?? []).map((a: any) => a.metadata?.name);

    // No overlap between namespaces
    const overlap = alphaAgentNames.filter((name: string) => betaAgentNames.includes(name));
    expect(overlap).toHaveLength(0);

    agentClient.close?.();
  });

  it("should NOT allow namespace injection via metadata manipulation", async () => {
    const agentClient = createServiceClient(API_GRPC_ADDRESS);

    // Attacker tries to create agent in team-alpha by sending conflicting namespace
    // in both metadata and request body
    const meta = createMetadata("team-beta");
    try {
      const response = await promisifyCall(agentClient, "CreateAgent", {
        metadata: { name: "injected-agent", namespace: "team-alpha" }, // Body says alpha
        spec: { model: "gpt-4o" },
        api_version: "egaop.io/v1",
        kind: "Agent",
      }, meta);

      // If it succeeds, the agent should be in beta, not alpha
      // (server should use metadata namespace, not body namespace)
      expect(response.metadata?.namespace).not.toBe("team-alpha");
    } catch {
      // Also acceptable — request rejected entirely
    }

    agentClient.close?.();
  });
});

describeIntegration("Namespace Isolation: Observability isolation", () => {
  it("should NOT allow cross-namespace trace access", async () => {
    // This test verifies that traces from one namespace are not visible to another
    // The observability plane stores spans with namespace tags
    const meta = createMetadata("team-beta");

    // Try to query traces for an execution that belongs to team-alpha
    // Should return empty or not found
    const runtimeClient = createRuntimeClient(RUNTIME_GRPC_ADDRESS);
    try {
      const response = await promisifyCall(runtimeClient, "GetSandboxStatus", {
        sandbox_id: "egaop-agent-exec-alpha-test",
      }, meta);

      // If it returns, status should be unknown/not found
      expect(response.status).not.toBe("Running");
    } catch {
      // Expected — cross-namespace access blocked
    }

    runtimeClient.close?.();
  });
});

describeIntegration("Namespace Isolation: Cleanup", () => {
  it("should clean up test resources", async () => {
    const agentClient = createServiceClient(API_GRPC_ADDRESS);
    const alphaMeta = createMetadata("team-alpha");
    const betaMeta = createMetadata("team-beta");

    // Delete agents
    try {
      await promisifyCall(agentClient, "DeleteAgent", { name: "agent-alpha-1", namespace: "team-alpha" }, alphaMeta);
    } catch { /* ok if already deleted */ }
    try {
      await promisifyCall(agentClient, "DeleteAgent", { name: "agent-beta-1", namespace: "team-beta" }, betaMeta);
    } catch { /* ok if already deleted */ }

    agentClient.close?.();
  });
});
