const mocks: { current: { services: Record<string, Record<string, (cb: Function) => void>> } } = {
  current: { services: {} }
};

function applyMock() {
  const srv = mocks.current.services;
  jest.doMock("@grpc/grpc-js", () => {
    const actual = jest.requireActual("@grpc/grpc-js");
    function makeCtor(methods: Record<string, (cb: Function) => void>) {
      const ctor: any = function () {};
      for (const [name, handler] of Object.entries(methods)) {
        ctor.prototype[name] = jest.fn((...args: any[]) => {
          const cb = typeof args[args.length - 1] === 'function' ? args[args.length - 1] : null;
          if (cb) handler(cb);
        });
      }
      return ctor;
    }
    return {
      ...actual,
      loadPackageDefinition: () => ({
        egaop: {
          v1: {
            AgentService: makeCtor(srv.AgentService || {}),
            RuntimeService: makeCtor(srv.RuntimeService || {}),
            ObservabilityService: makeCtor(srv.ObservabilityService || {}),
            LLMService: makeCtor(srv.LLMService || {}),
          }
        }
      }),
      credentials: { createInsecure: () => ({}) },
    };
  });
  jest.doMock("@grpc/proto-loader", () => ({ loadSync: () => ({}) }));
}

describe("Workflow Engine - Activities", () => {
  beforeEach(() => {
    jest.resetModules();
  });

  describe("evaluatePolicy", () => {
    it("should return allow for any input", async () => {
      jest.resetModules();
      const { evaluatePolicy } = jest.requireActual("../activities/agent");
      const result = await evaluatePolicy({ agentId: "agent-1", action: "start" });
      expect(result.status).toBe("allow");
      expect(result.reason).toBe("");
    });
  });

  describe("admitAgent", () => {
    it("should return true when admission phase is Pending", async () => {
      mocks.current.services = {
        AgentService: { CreateAgent: (cb: Function) => cb(null, { status: { phase: "Pending", health_status: "Healthy" } }) }
      };
      applyMock();
      const { admitAgent } = jest.requireActual("../activities/agent");
      const result = await admitAgent({ agentId: "agent-1", spec: {} });
      expect(result).toBe(true);
    });

    it("should throw when admission fails", async () => {
      mocks.current.services = {
        AgentService: { CreateAgent: (cb: Function) => cb({ code: 13, details: "Admission policy denied" }) }
      };
      applyMock();
      const { admitAgent } = jest.requireActual("../activities/agent");
      await expect(admitAgent({ agentId: "agent-1", spec: {} })).rejects.toThrow("Admission failed");
    });
  });

  describe("createSandbox", () => {
    it("should return sandbox id on success", async () => {
      mocks.current.services = {
        RuntimeService: { CreateSandbox: (cb: Function) => cb(null, { sandbox_id: "sbx-abc123", status: "running" }) }
      };
      applyMock();
      const { createSandbox } = jest.requireActual("../activities/agent");
      const result = await createSandbox({ agentId: "agent-1", executionId: "exec-1", isolation: "Enhanced" });
      expect(result.id).toBe("sbx-abc123");
      expect(result.status).toBe("running");
    });

    it("should throw on sandbox failure", async () => {
      mocks.current.services = {
        RuntimeService: { CreateSandbox: (cb: Function) => cb({ code: 13, details: "Out of memory" }) }
      };
      applyMock();
      const { createSandbox } = jest.requireActual("../activities/agent");
      await expect(createSandbox({ agentId: "agent-1", executionId: "exec-1", isolation: "Enhanced" })).rejects.toThrow("Sandbox creation failed");
    });
  });

  describe("recordTrace", () => {
    it("should return success when trace is recorded", async () => {
      mocks.current.services = {
        ObservabilityService: { ExportTrace: (cb: Function) => cb(null, { success: true }) }
      };
      applyMock();
      const { recordTrace } = jest.requireActual("../activities/agent");
      const result = await recordTrace({ executionId: "exec-1", step: "test", status: "running" });
      expect(result.success).toBe(true);
    });

    it("should gracefully handle trace failure", async () => {
      mocks.current.services = {
        ObservabilityService: { ExportTrace: (cb: Function) => cb({ code: 14, details: "Unavailable" }) }
      };
      applyMock();
      const { recordTrace } = jest.requireActual("../activities/agent");
      const result = await recordTrace({ executionId: "exec-1", step: "test", status: "running" });
      expect(result.success).toBe(false);
    });
  });

  describe("llmGenerate", () => {
    it("should return content and model info on success", async () => {
      mocks.current.services = {
        LLMService: { Generate: (cb: Function) => cb(null, { content: "Hello!", model_used: "gpt-4o", usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }, cost: "$0.0001" }) }
      };
      applyMock();
      const { llmGenerate } = jest.requireActual("../activities/agent");
      const result = await llmGenerate({ agentId: "agent-1", executionId: "exec-1", messages: [{ role: "user", content: "Hi" }] });
      expect(result.content).toBe("Hello!");
      expect(result.model_used).toBe("gpt-4o");
      expect(result.cost).toBe("$0.0001");
    });

    it("should throw on LLM failure", async () => {
      mocks.current.services = {
        LLMService: { Generate: (cb: Function) => cb({ code: 4, details: "Rate limited" }) }
      };
      applyMock();
      const { llmGenerate } = jest.requireActual("../activities/agent");
      await expect(llmGenerate({ agentId: "agent-1", executionId: "exec-1", messages: [{ role: "user", content: "Hi" }] })).rejects.toThrow("LLM generation failed");
    });
  });
});
