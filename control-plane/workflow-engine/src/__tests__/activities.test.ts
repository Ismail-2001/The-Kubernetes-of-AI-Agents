import {
  callLLM,
  callLLMStream,
  executeTool,
  persistMemory,
  admitAgent,
  createSandbox,
  terminateSandbox,
  recordObservability,
  reportOutcome,
} from "../temporal/activities";

jest.mock("@e-gaop/shared", () => {
  const quotaInstances: Array<{
    check: jest.Mock;
    release: jest.Mock;
  }> = [];

  class QuotaExceededError extends Error {
    retryAfterMs?: number;
    constructor(message: string, retryAfterMs?: number) {
      super(message);
      this.retryAfterMs = retryAfterMs;
    }
  }

  const QuotaEnforcer = jest.fn().mockImplementation(() => {
    const inst = {
      check: jest.fn().mockResolvedValue(undefined),
      release: jest.fn().mockResolvedValue(undefined),
    };
    quotaInstances.push(inst);
    return inst;
  });

  return {
    QuotaEnforcer,
    QuotaExceededError,
    getClientCredentials: jest.fn().mockReturnValue({}),
    getStandardInterceptors: jest.fn().mockReturnValue([]),
    createAuditEntry: jest.fn(),
    getPool: jest.fn().mockResolvedValue({
      query: jest.fn().mockResolvedValue({ rows: [] }),
    }),
    __quotaInstances: quotaInstances,
  };
});

jest.mock("@grpc/grpc-js", () => {
  const clients: Array<Record<string, jest.Mock>> = [];
  class MockClient {
    constructor() {
      clients.push(this as unknown as Record<string, jest.Mock>);
    }
  }
  return {
    loadPackageDefinition: jest.fn().mockReturnValue({
      egaop: {
        v1: {
          LLMService: MockClient,
          ToolService: MockClient,
          MemoryService: MockClient,
          ObservabilityService: MockClient,
          AgentService: MockClient,
          RuntimeService: MockClient,
        },
      },
    }),
    __clients: clients,
  };
});

jest.mock("@grpc/proto-loader", () => ({
  loadSync: jest.fn().mockReturnValue({}),
}));

jest.mock("@temporalio/activity", () => ({
  Context: {
    current: jest.fn().mockReturnValue({ heartbeat: jest.fn() }),
  },
}));

jest.mock("pino", () =>
  jest.fn().mockReturnValue({
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
  })
);

interface QuotaInstance {
  check: jest.Mock;
  release: jest.Mock;
}

const sharedMock = jest.requireMock("@e-gaop/shared") as {
  QuotaEnforcer: jest.Mock;
  QuotaExceededError: typeof Error & { new (message: string, retryAfterMs?: number): { retryAfterMs?: number } };
  createAuditEntry: jest.Mock;
  getPool: jest.Mock;
  __quotaInstances: QuotaInstance[];
};

const grpcMock = jest.requireMock("@grpc/grpc-js") as {
  __clients: Array<Record<string, jest.Mock>>;
};

// Client instantiation order in activities/index.ts:
// 0 = llmClient, 1 = toolClient, 2 = memoryClient,
// 3 = obsClient, 4 = agentClient, 5 = runtimeClient
function grpcClient(index: number): any {
  return grpcMock.__clients[index]!;
}

function quotaInstance(): QuotaInstance {
  return sharedMock.__quotaInstances[0]!;
}

function generateResponse(overrides: Record<string, unknown> = {}) {
  return {
    content: "The answer is 42",
    model_used: "gpt-4o",
    cost: "$0.001000",
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    ...overrides,
  };
}

describe("callLLM", () => {
  beforeEach(() => {
    quotaInstance().check.mockResolvedValue(undefined);
    quotaInstance().release.mockResolvedValue(undefined);
    grpcClient(0).Generate = jest.fn();
  });

  it("returns a final_answer when the LLM produces plain text", async () => {
    grpcClient(0).Generate.mockImplementation(
      (_args: unknown, _opts: unknown, cb: (err: null, res: unknown) => void) => {
        cb(null, generateResponse());
      }
    );

    const result = await callLLM({
      agentId: "agent-1",
      executionId: "exec-1",
      namespace: "sandbox-a",
      messages: [{ role: "user", content: "hello" }],
    });

    expect(result.type).toBe("final_answer");
    expect(result.content).toBe("The answer is 42");
    expect(result.modelUsed).toBe("gpt-4o");
    expect(result.usage).toEqual({
      promptTokens: 10,
      completionTokens: 5,
      totalTokens: 15,
    });
  });

  it("returns a tool_call with parsed args from structured tool_calls", async () => {
    grpcClient(0).Generate.mockImplementation(
      (_args: unknown, _opts: unknown, cb: (err: null, res: unknown) => void) => {
        cb(
          null,
          generateResponse({
            content: "",
            tool_calls: [
              { id: "call_1", name: "search", args: '{"query":"weather"}' },
            ],
          })
        );
      }
    );

    const result = await callLLM({
      agentId: "agent-1",
      executionId: "exec-1",
      namespace: "sandbox-a",
      messages: [{ role: "user", content: "search" }],
      toolDefinitions: [{ name: "search", description: "search the web" }],
    });

    expect(result.type).toBe("tool_call");
    expect(result.toolName).toBe("search");
    expect(result.toolArgs).toEqual({ query: "weather" });
    expect(result.toolCallId).toBe("call_1");
    expect(result.toolCalls).toHaveLength(1);
  });

  it("tolerates malformed tool_call JSON args", async () => {
    grpcClient(0).Generate.mockImplementation(
      (_args: unknown, _opts: unknown, cb: (err: null, res: unknown) => void) => {
        cb(
          null,
          generateResponse({
            content: "",
            tool_calls: [{ id: "call_1", name: "search", args: "{bad json" }],
          })
        );
      }
    );

    const result = await callLLM({
      agentId: "agent-1",
      executionId: "exec-1",
      namespace: "sandbox-a",
      messages: [{ role: "user", content: "search" }],
    });

    expect(result.type).toBe("tool_call");
    expect(result.toolArgs).toEqual({});
  });

  it("falls back to text classification when no structured tool_calls", async () => {
    grpcClient(0).Generate.mockImplementation(
      (_args: unknown, _opts: unknown, cb: (err: null, res: unknown) => void) => {
        cb(null, generateResponse({ content: "[tool: calculate]" }));
      }
    );

    const result = await callLLM({
      agentId: "agent-1",
      executionId: "exec-1",
      namespace: "sandbox-a",
      messages: [{ role: "user", content: "math" }],
    });

    expect(result.type).toBe("tool_call");
    expect(result.toolName).toBe("calculate");
  });

  it("releases quota in finally after a successful call", async () => {
    grpcClient(0).Generate.mockImplementation(
      (_args: unknown, _opts: unknown, cb: (err: null, res: unknown) => void) => {
        cb(null, generateResponse());
      }
    );

    await callLLM({
      agentId: "agent-1",
      executionId: "exec-1",
      namespace: "sandbox-a",
      messages: [{ role: "user", content: "hello" }],
    });

    expect(quotaInstance().check).toHaveBeenCalledWith(
      "sandbox-a",
      "concurrent_executions",
      1
    );
    expect(quotaInstance().release).toHaveBeenCalledWith(
      "sandbox-a",
      "concurrent_executions",
      1
    );
  });

  it("retries waitForQuota when QuotaExceededError is thrown", async () => {
    jest.useFakeTimers();
    try {
      quotaInstance().check
        .mockRejectedValueOnce(
          new sharedMock.QuotaExceededError("quota exceeded", 500)
        )
        .mockResolvedValueOnce(undefined);
      grpcClient(0).Generate.mockImplementation(
        (_args: unknown, _opts: unknown, cb: (err: null, res: unknown) => void) => {
          cb(null, generateResponse());
        }
      );

      const promise = callLLM({
        agentId: "agent-1",
        executionId: "exec-1",
        namespace: "sandbox-a",
        messages: [{ role: "user", content: "hello" }],
      });

      await jest.advanceTimersByTimeAsync(600);
      const result = await promise;

      expect(result.type).toBe("final_answer");
      expect(quotaInstance().check).toHaveBeenCalledTimes(2);
      expect(quotaInstance().release).toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it("propagates non-quota errors from waitForQuota", async () => {
    quotaInstance().check.mockRejectedValue(new Error("quota service down"));

    await expect(
      callLLM({
        agentId: "agent-1",
        executionId: "exec-1",
        namespace: "sandbox-a",
        messages: [{ role: "user", content: "hello" }],
      })
    ).rejects.toThrow("quota service down");
  });
});

describe("callLLMStream", () => {
  it("yields chunks until a done chunk arrives", async () => {
    const onMock = jest.fn();
    const cancelMock = jest.fn();
    const dataHandlers: Array<(chunk: Record<string, unknown>) => void> = [];
    const endHandlers: Array<() => void> = [];
    const errorHandlers: Array<(err: Error) => void> = [];

    onMock.mockImplementation(
      (event: string, handler: (chunk: Record<string, unknown>) => void) => {
        if (event === "data") dataHandlers.push(handler as (chunk: Record<string, unknown>) => void);
        if (event === "end") endHandlers.push(handler as () => void);
        if (event === "error") errorHandlers.push(handler as unknown as (err: Error) => void);
      }
    );
    grpcClient(0).GenerateStream = jest.fn().mockReturnValue({
      on: onMock,
      cancel: cancelMock,
    });

    const gen = callLLMStream({
      agentId: "agent-1",
      executionId: "exec-1",
      namespace: "sandbox-a",
      messages: [{ role: "user", content: "hello" }],
    });

    const first = gen.next();
    dataHandlers[0]!({ content: "hello", done: false, model_used: "gpt-4o" });
    await expect(first).resolves.toEqual({
      value: {
        content: "hello",
        done: false,
        modelUsed: "gpt-4o",
        usage: undefined,
        cost: undefined,
        finishReason: undefined,
      },
      done: false,
    });

    const second = gen.next();
    dataHandlers[0]!({
      content: " world",
      done: true,
      model_used: "gpt-4o",
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      cost: "$0.001000",
      finish_reason: "stop",
    });
    await expect(second).resolves.toEqual({
      value: {
        content: " world",
        done: true,
        modelUsed: "gpt-4o",
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        cost: "$0.001000",
        finishReason: "stop",
      },
      done: false,
    });

    await expect(gen.next()).resolves.toEqual({ value: undefined, done: true });
    expect(cancelMock).toHaveBeenCalled();
  });

  it("throws when the stream errors", async () => {
    const onMock = jest.fn();
    const errorHandlers: Array<(err: Error) => void> = [];
    onMock.mockImplementation(
      (event: string, handler: (err: Error) => void) => {
        if (event === "error") errorHandlers.push(handler as (err: Error) => void);
      }
    );
    grpcClient(0).GenerateStream = jest.fn().mockReturnValue({
      on: onMock,
      cancel: jest.fn(),
    });

    const gen = callLLMStream({
      agentId: "agent-1",
      executionId: "exec-1",
      namespace: "sandbox-a",
      messages: [{ role: "user", content: "hello" }],
    });

    const pending = gen.next();
    errorHandlers[0]!(new Error("stream failed"));
    await expect(pending).rejects.toThrow("stream failed");
  });

  it("ends cleanly when the stream ends without a done chunk", async () => {
    const onMock = jest.fn();
    const endHandlers: Array<() => void> = [];
    onMock.mockImplementation((event: string, handler: () => void) => {
      if (event === "end") endHandlers.push(handler as () => void);
    });
    grpcClient(0).GenerateStream = jest.fn().mockReturnValue({
      on: onMock,
      cancel: jest.fn(),
    });

    const gen = callLLMStream({
      agentId: "agent-1",
      executionId: "exec-1",
      namespace: "sandbox-a",
      messages: [{ role: "user", content: "hello" }],
    });

    const pending = gen.next();
    endHandlers[0]!();
    await expect(pending).resolves.toEqual({ value: undefined, done: true });
  });

  it("throws when GenerateStream method is missing", async () => {
    grpcClient(0).GenerateStream = undefined as unknown as jest.Mock;

    const gen = callLLMStream({
      agentId: "agent-1",
      executionId: "exec-1",
      namespace: "sandbox-a",
      messages: [{ role: "user", content: "hello" }],
    });

    await expect(gen.next()).rejects.toThrow("GenerateStream not found");
  });
});

describe("executeTool", () => {
  beforeEach(() => {
    grpcClient(1).CallTool = jest.fn();
    quotaInstance().check.mockResolvedValue(undefined);
  });

  it("returns a succeeded result", async () => {
    grpcClient(1).CallTool.mockImplementation(
      (_args: unknown, _opts: unknown, cb: (err: null, res: unknown) => void) => {
        cb(null, { status: "succeeded", result: { data: 42 }, latency_ms: 12 });
      }
    );

    const result = await executeTool({
      agentId: "agent-1",
      executionId: "exec-1",
      namespace: "sandbox-a",
      toolName: "code_interpreter",
      args: { code: "print(1)" },
    });

    expect(result.status).toBe("succeeded");
    expect(result.result).toEqual({ data: 42 });
    expect(result.latencyMs).toBe(12);
  });

  it("returns failed when all required args are missing", async () => {
    const result = await executeTool({
      agentId: "agent-1",
      executionId: "exec-1",
      namespace: "sandbox-a",
      toolName: "write_file",
      args: {},
    });

    expect(result.status).toBe("failed");
    expect(result.errorMessage).toContain("Missing required arguments");
  });

  it("maps a non-succeeded response status to failed", async () => {
    grpcClient(1).CallTool.mockImplementation(
      (_args: unknown, _opts: unknown, cb: (err: null, res: unknown) => void) => {
        cb(null, { status: "failed", error_message: "nope", latency_ms: 3 });
      }
    );

    const result = await executeTool({
      agentId: "agent-1",
      executionId: "exec-1",
      namespace: "sandbox-a",
      toolName: "read_file",
      args: { path: "/x" },
    });

    expect(result.status).toBe("failed");
    expect(result.errorMessage).toBe("nope");
  });

  it("throws PII_VIOLATION when the tool proxy reports PII", async () => {
    const grpcErr = new Error("PII detected") as Error & { details?: string };
    grpcErr.details = "PII_VIOLATION: blocked";
    grpcClient(1).CallTool.mockImplementation(
      (_args: unknown, _opts: unknown, cb: (err: Error | null, res?: unknown) => void) => {
        cb(grpcErr);
      }
    );

    await expect(
      executeTool({
        agentId: "agent-1",
        executionId: "exec-1",
        namespace: "sandbox-a",
        toolName: "code_interpreter",
        args: { code: "x" },
      })
    ).rejects.toThrow("PII_VIOLATION");
  });

  it("throws POLICY_DENIED when the tool proxy denies", async () => {
    const grpcErr = new Error("denied") as Error & { details?: string };
    grpcErr.details = "POLICY_DENIED: nope";
    grpcClient(1).CallTool.mockImplementation(
      (_args: unknown, _opts: unknown, cb: (err: Error | null, res?: unknown) => void) => {
        cb(grpcErr);
      }
    );

    await expect(
      executeTool({
        agentId: "agent-1",
        executionId: "exec-1",
        namespace: "sandbox-a",
        toolName: "code_interpreter",
        args: { code: "x" },
      })
    ).rejects.toThrow("POLICY_DENIED");
  });

  it("returns failed on generic gRPC error", async () => {
    grpcClient(1).CallTool.mockImplementation(
      (_args: unknown, _opts: unknown, cb: (err: Error | null, res?: unknown) => void) => {
        cb(new Error("connection refused"));
      }
    );

    const result = await executeTool({
      agentId: "agent-1",
      executionId: "exec-1",
      namespace: "sandbox-a",
      toolName: "code_interpreter",
      args: { code: "x" },
    });

    expect(result.status).toBe("failed");
    expect(result.errorMessage).toContain("connection refused");
  });
});

describe("persistMemory", () => {
  beforeEach(() => {
    grpcClient(2).Write = jest.fn();
  });

  it("returns status and version on success", async () => {
    grpcClient(2).Write.mockImplementation(
      (_args: unknown, _opts: unknown, cb: (err: null, res: unknown) => void) => {
        cb(null, { status: "success", version: "v3" });
      }
    );

    const result = await persistMemory({
      agentId: "agent-1",
      namespace: "sandbox-a",
      memoryType: "session",
      key: "k",
      data: { foo: "bar" },
    });

    expect(result).toEqual({ status: "success", version: "v3" });
  });

  it("defaults missing fields", async () => {
    grpcClient(2).Write.mockImplementation(
      (_args: unknown, _opts: unknown, cb: (err: null, res: unknown) => void) => {
        cb(null, {});
      }
    );

    const result = await persistMemory({
      agentId: "agent-1",
      namespace: "sandbox-a",
      memoryType: "session",
      key: "k",
      data: {},
    });

    expect(result).toEqual({ status: "success", version: "" });
  });

  it("wraps errors with a descriptive message", async () => {
    grpcClient(2).Write.mockImplementation(
      (_args: unknown, _opts: unknown, cb: (err: Error | null, res?: unknown) => void) => {
        cb(new Error("write failed"));
      }
    );

    await expect(
      persistMemory({
        agentId: "agent-1",
        namespace: "sandbox-a",
        memoryType: "session",
        key: "k",
        data: {},
      })
    ).rejects.toThrow("Memory persist failed");
  });
});

describe("admitAgent", () => {
  beforeEach(() => {
    grpcClient(4).CreateAgent = jest.fn();
  });

  it("returns true when agent reaches Pending phase", async () => {
    grpcClient(4).CreateAgent.mockImplementation(
      (_args: unknown, _opts: unknown, cb: (err: null, res: unknown) => void) => {
        cb(null, { status: { phase: "Pending" } });
      }
    );

    await expect(
      admitAgent({
        agentId: "agent-1",
        namespace: "sandbox-a",
        spec: {},
      })
    ).resolves.toBe(true);
  });

  it("returns false for unknown phase", async () => {
    grpcClient(4).CreateAgent.mockImplementation(
      (_args: unknown, _opts: unknown, cb: (err: null, res: unknown) => void) => {
        cb(null, { status: { phase: "Failed" } });
      }
    );

    await expect(
      admitAgent({
        agentId: "agent-1",
        namespace: "sandbox-a",
        spec: {},
      })
    ).resolves.toBe(false);
  });

  it("returns true when the agent already exists", async () => {
    const grpcErr = new Error("already exists") as Error & { details?: string };
    grpcErr.details = "agent already exists";
    grpcClient(4).CreateAgent.mockImplementation(
      (_args: unknown, _opts: unknown, cb: (err: Error | null, res?: unknown) => void) => {
        cb(grpcErr);
      }
    );

    await expect(
      admitAgent({
        agentId: "agent-1",
        namespace: "sandbox-a",
        spec: {},
      })
    ).resolves.toBe(true);
  });

  it("throws on other admission errors", async () => {
    grpcClient(4).CreateAgent.mockImplementation(
      (_args: unknown, _opts: unknown, cb: (err: Error | null, res?: unknown) => void) => {
        cb(new Error("denied"));
      }
    );

    await expect(
      admitAgent({
        agentId: "agent-1",
        namespace: "sandbox-a",
        spec: {},
      })
    ).rejects.toThrow("Admission failed");
  });
});

describe("createSandbox", () => {
  beforeEach(() => {
    grpcClient(5).CreateSandbox = jest.fn();
  });

  it("returns sandbox details", async () => {
    grpcClient(5).CreateSandbox.mockImplementation(
      (_args: unknown, _opts: unknown, cb: (err: null, res: unknown) => void) => {
        cb(null, {
          sandbox_id: "sb-1",
          status: "Running",
          ip_address: "10.0.0.5",
          init_outputs: ["ready"],
        });
      }
    );

    const result = await createSandbox({
      agentId: "agent-1",
      executionId: "exec-1",
      namespace: "sandbox-a",
      isolationLevel: "Enhanced",
    });

    expect(result).toEqual({
      id: "sb-1",
      status: "Running",
      initOutputs: ["ready"],
      ipAddress: "10.0.0.5",
    });
  });

  it("throws wrapped error on failure", async () => {
    grpcClient(5).CreateSandbox.mockImplementation(
      (_args: unknown, _opts: unknown, cb: (err: Error | null, res?: unknown) => void) => {
        cb(new Error("no capacity"));
      }
    );

    await expect(
      createSandbox({
        agentId: "agent-1",
        executionId: "exec-1",
        namespace: "sandbox-a",
        isolationLevel: "Enhanced",
      })
    ).rejects.toThrow("Sandbox creation failed");
  });
});

describe("terminateSandbox", () => {
  beforeEach(() => {
    grpcClient(5).TerminateSandbox = jest.fn();
  });

  it("returns success when terminated", async () => {
    grpcClient(5).TerminateSandbox.mockImplementation(
      (_args: unknown, _opts: unknown, cb: (err: null, res: unknown) => void) => {
        cb(null, { success: true });
      }
    );

    await expect(
      terminateSandbox({ sandboxId: "sb-1", reason: "done" })
    ).resolves.toEqual({ success: true });
  });

  it("throws wrapped error on failure", async () => {
    grpcClient(5).TerminateSandbox.mockImplementation(
      (_args: unknown, _opts: unknown, cb: (err: Error | null, res?: unknown) => void) => {
        cb(new Error("terminate failed"));
      }
    );

    await expect(
      terminateSandbox({ sandboxId: "sb-1", reason: "done" })
    ).rejects.toThrow("Sandbox termination failed");
  });
});

describe("recordObservability", () => {
  beforeEach(() => {
    grpcClient(3).ExportTrace = jest.fn();
  });

  it("returns success on export", async () => {
    grpcClient(3).ExportTrace.mockImplementation(
      (_args: unknown, _opts: unknown, cb: (err: null, res: unknown) => void) => {
        cb(null, {});
      }
    );

    await expect(
      recordObservability({ executionId: "e1", step: "s1", status: "running" })
    ).resolves.toEqual({ success: true });
  });

  it("returns failure on export error", async () => {
    grpcClient(3).ExportTrace.mockImplementation(
      (_args: unknown, _opts: unknown, cb: (err: Error | null, res?: unknown) => void) => {
        cb(new Error("trace failed"));
      }
    );

    await expect(
      recordObservability({ executionId: "e1", step: "s1", status: "running" })
    ).resolves.toEqual({ success: false });
  });
});

describe("reportOutcome", () => {
  beforeEach(() => {
    sharedMock.getPool.mockReset();
    sharedMock.getPool.mockResolvedValue({
      query: jest.fn().mockResolvedValue({ rows: [] }),
    });
  });

  it("does nothing for non-ERROR results", async () => {
    await reportOutcome({
      agentId: "agent-1",
      executionId: "exec-1",
      namespace: "sandbox-a",
      result: {
        status: "SUCCEEDED",
        output: "ok",
        totalCost: "$0.001000",
        iterations: 1,
        toolCalls: [],
      },
    });

    expect(sharedMock.getPool).not.toHaveBeenCalled();
  });

  it("writes ERROR results to the dead letter queue", async () => {
    const queryMock = jest.fn().mockResolvedValue({ rows: [] });
    sharedMock.getPool.mockResolvedValue({ query: queryMock });

    await reportOutcome({
      agentId: "agent-1",
      executionId: "exec-1",
      namespace: "sandbox-a",
      result: {
        status: "ERROR",
        output: "failed",
        totalCost: "$0.001000",
        iterations: 2,
        toolCalls: [],
        error: "boom",
      },
    });

    expect(queryMock).toHaveBeenCalledTimes(1);
    expect(queryMock.mock.calls[0][1]).toEqual([
      "agent-1",
      "exec-1",
      "sandbox-a",
      "ERROR",
      "boom",
      "failed",
      "$0.001000",
      2,
      "[]",
    ]);
  });

  it("swallows DB errors", async () => {
    sharedMock.getPool.mockResolvedValue({
      query: jest.fn().mockRejectedValue(new Error("db down")),
    });

    await expect(
      reportOutcome({
        agentId: "agent-1",
        executionId: "exec-1",
        namespace: "sandbox-a",
        result: {
          status: "ERROR",
          output: "failed",
          totalCost: "$0.001000",
          iterations: 1,
          toolCalls: [],
          error: "boom",
        },
      })
    ).resolves.toBeUndefined();
  });
});
