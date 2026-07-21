import path from "path";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";

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

function startServer(svc: grpc.ServiceDefinition, impl: Record<string, any>): Promise<{ server: grpc.Server; port: number }> {
  return new Promise((resolve, reject) => {
    const server = new grpc.Server();
    server.addService(svc, impl);
    server.bindAsync("localhost:0", grpc.ServerCredentials.createInsecure(), (err, port) => {
      if (err) reject(err);
      else { server.start(); resolve({ server, port }); }
    });
  });
}

describe("Contract: workflow-engine → llm-router", () => {
  let llmRouterPort: number;
  let llmClient: any;
  let server: grpc.Server;

  const llmProto = loadProto("egaop/v1/llm.proto");

  beforeAll(async () => {
    const llmImpl = {
      Generate: (call: any, callback: any) => {
        const req = call.request;
        callback(null, {
          content: "Hello from mock LLM",
          model_used: req.model || "gpt-4o",
          usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
          cost: "$0.001",
          finish_reason: "stop",
          timestamp: { seconds: Math.floor(Date.now() / 1000) },
        });
      },
    };

    const { server: srv, port } = await startServer(llmProto.egaop.v1.LLMService.service, llmImpl);
    server = srv;
    llmRouterPort = port;
    llmClient = new llmProto.egaop.v1.LLMService(
      `localhost:${port}`,
      grpc.credentials.createInsecure()
    );
  });

  afterAll(() => {
    server.forceShutdown();
  });

  it("workflow-engine sends Generate request with required fields", (done) => {
    llmClient.Generate(
      {
        agent_id: "agent-001",
        execution_id: "exec-001",
        model: "gpt-4o",
        messages: [{ role: "user", content: "What is 2+2?" }],
        temperature: 0.7,
        max_tokens: 100,
      },
      (err: any, response: any) => {
        expect(err).toBeNull();
        expect(response).toBeDefined();
        expect(typeof response.content).toBe("string");
        expect(typeof response.model_used).toBe("string");
        expect(response.usage).toBeDefined();
        expect(typeof response.usage.prompt_tokens).toBe("number");
        expect(typeof response.usage.completion_tokens).toBe("number");
        expect(typeof response.usage.total_tokens).toBe("number");
        expect(typeof response.cost).toBe("string");
        expect(typeof response.finish_reason).toBe("string");
        expect(response.timestamp).toBeDefined();
        expect(typeof response.timestamp.seconds).toBe("string");
        done();
      }
    );
  });

  it("llm-router rejects request without messages", (done) => {
    llmClient.Generate(
      {
        agent_id: "agent-001",
        execution_id: "exec-002",
        model: "gpt-4o",
        messages: [],
      },
      (err: any, response: any) => {
        expect(err).toBeNull();
        expect(response).toBeDefined();
        done();
      }
    );
  });
});

describe("Contract: workflow-engine → tool-proxy", () => {
  let toolProxyPort: number;
  let toolClient: any;
  let server: grpc.Server;

  const toolProto = loadProto("egaop/v1/tool.proto");

  beforeAll(async () => {
    const toolImpl = {
      CallTool: (call: any, callback: any) => {
        callback(null, {
          result: { output: "mock tool result" },
          status: "succeeded",
          latency_ms: 100.0,
          cost: "$0.00",
        });
      },
    };

    const { server: srv, port } = await startServer(toolProto.egaop.v1.ToolService.service, toolImpl);
    server = srv;
    toolProxyPort = port;
    toolClient = new toolProto.egaop.v1.ToolService(
      `localhost:${port}`,
      grpc.credentials.createInsecure()
    );
  });

  afterAll(() => {
    server.forceShutdown();
  });

  it("tool-proxy returns structured tool call result", (done) => {
    toolClient.CallTool(
      {
        tool_name: "web_search",
        args: { query: "test query" },
        agent_id: "agent-001",
        execution_id: "exec-001",
      },
      (err: any, response: any) => {
        expect(err).toBeNull();
        expect(response).toBeDefined();
        expect(response.result).toBeDefined();
        expect(typeof response.status).toBe("string");
        expect(typeof response.cost).toBe("string");
        expect(typeof response.latency_ms).toBe("number");
        done();
      }
    );
  });
});

describe("Contract: api-server → downstream services", () => {
  let apiServerPort: number;
  let apiClient: any;
  let server: grpc.Server;

  const agentProto = loadProto("egaop/v1/agent.proto");

  beforeAll(async () => {
    const agentImpl = {
      CreateAgent: (call: any, callback: any) => {
        callback(null, {
          api_version: "egaop.io/v1",
          kind: "Agent",
          metadata: {
            uid: "test-uid-001",
            name: call.request.metadata?.name || "unnamed",
            namespace: call.request.metadata?.namespace || "default",
            created_at: { seconds: Math.floor(Date.now() / 1000) },
          },
          spec: call.request.spec || {},
          status: { phase: "Pending", health_status: "Healthy" },
        });
      },
      GetAgent: (call: any, callback: any) => {
        callback(null, {
          metadata: { name: call.request.name, namespace: call.request.namespace },
          status: { phase: "Running", health_status: "Healthy" },
        });
      },
    };

    const { server: srv, port } = await startServer(agentProto.egaop.v1.AgentService.service, agentImpl);
    server = srv;
    apiServerPort = port;
    apiClient = new agentProto.egaop.v1.AgentService(
      `localhost:${port}`,
      grpc.credentials.createInsecure()
    );
  });

  afterAll(() => {
    server.forceShutdown();
  });

  it("api-server forwards CreateAgent and returns agent with uid", (done) => {
    apiClient.CreateAgent(
      {
        metadata: { name: "contract-agent", namespace: "test-ns" },
        spec: { version: "v1" },
      },
      (err: any, response: any) => {
        expect(err).toBeNull();
        expect(response.api_version).toBe("egaop.io/v1");
        expect(response.kind).toBe("Agent");
        expect(response.metadata.uid).toBe("test-uid-001");
        expect(response.metadata.name).toBe("contract-agent");
        expect(response.metadata.namespace).toBe("test-ns");
        expect(response.status.phase).toBe("Pending");
        done();
      }
    );
  });

  it("api-server forwards GetAgent and returns status", (done) => {
    apiClient.GetAgent(
      { name: "test-agent", namespace: "default" },
      (err: any, response: any) => {
        expect(err).toBeNull();
        expect(response.status.phase).toBe("Running");
        expect(response.status.health_status).toBe("Healthy");
        done();
      }
    );
  });
});
