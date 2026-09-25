import { reactWorkflow } from "../temporal/workflows/react-workflow";
import { hitlApprovalGate } from "../temporal/workflows/hitl-gate";
import type { AgentExecutionInput, HITLApprovalInput } from "../temporal/types";

jest.mock("@temporalio/workflow", () => {
  const activities: Record<string, jest.Mock> = {};
  const handlers: Record<string, (...args: unknown[]) => unknown> = {};

  class ApplicationFailure extends Error {}

  return {
    proxyActivities: jest.fn().mockImplementation(() => {
      return new Proxy(activities, {
        get: (target, prop) => {
          if (typeof prop !== "string") return undefined;
          if (!(prop in target)) target[prop] = jest.fn();
          return target[prop];
        },
      });
    }),
    sleep: jest.fn().mockResolvedValue(undefined),
    setHandler: jest.fn((signal: string, handler: (...args: unknown[]) => unknown) => {
      handlers[signal] = handler;
    }),
    defineSignal: jest.fn((name: string) => name),
    defineQuery: jest.fn((name: string) => name),
    workflowInfo: jest.fn().mockReturnValue({
      startTime: new Date("2026-01-01T00:00:00.000Z"),
    }),
    condition: jest.fn(),
    ApplicationFailure,
    __activities: activities,
    __handlers: handlers,
  };
});

const workflowMock = jest.requireMock("@temporalio/workflow") as {
  proxyActivities: jest.Mock;
  setHandler: jest.Mock;
  condition: jest.Mock;
  __activities: Record<string, jest.Mock>;
  __handlers: Record<string, (...args: unknown[]) => unknown>;
};

const activities: Record<string, any> = workflowMock.__activities;
const handlers: Record<string, any> = workflowMock.__handlers;

function finalAnswer(overrides: Record<string, unknown> = {}) {
  return {
    type: "final_answer",
    content: "[FINAL ANSWER] Done",
    modelUsed: "gpt-4o",
    cost: "$0.001000",
    usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    ...overrides,
  };
}

function toolCall(overrides: Record<string, unknown> = {}) {
  return {
    type: "tool_call",
    content: "[tool: search]",
    toolName: "search",
    toolArgs: { query: "test" },
    modelUsed: "gpt-4o",
    cost: "$0.001000",
    usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    ...overrides,
  };
}

function baseInput(overrides: Partial<AgentExecutionInput> = {}): AgentExecutionInput {
  return {
    agentId: "agent-1",
    executionId: "exec-1",
    namespace: "test",
    maxIterations: 10,
    ...overrides,
  };
}

describe("reactWorkflow", () => {
  beforeEach(() => {
    for (const name of Object.keys(activities)) {
      activities[name].mockReset();
    }
    Object.keys(handlers).forEach((k) => delete handlers[k]);
    activities.admitAgent.mockResolvedValue(true);
    activities.evaluatePolicy.mockResolvedValue({ allow: true, reason: "" });
    activities.createSandbox.mockResolvedValue({
      id: "sb-1",
      status: "Running",
      initOutputs: ["ready"],
      ipAddress: "10.0.0.5",
    });
    activities.terminateSandbox.mockResolvedValue({ success: true });
    activities.persistMemory.mockResolvedValue({ status: "success", version: "v1" });
    activities.recordObservability.mockResolvedValue({ success: true });
    activities.reportOutcome.mockResolvedValue(undefined);
  });

  it("completes with a final answer", async () => {
    activities.callLLM.mockResolvedValue(finalAnswer());

    const result = await reactWorkflow(baseInput());

    expect(result.status).toBe("SUCCEEDED");
    expect(result.iterations).toBe(1);
    expect(result.output).toContain("FINAL ANSWER");
    expect(activities.admitAgent).toHaveBeenCalledTimes(1);
    expect(activities.evaluatePolicy).toHaveBeenCalledTimes(1);
    expect(activities.createSandbox).toHaveBeenCalledTimes(1);
    expect(activities.terminateSandbox).toHaveBeenCalledTimes(1);
    expect(activities.reportOutcome).toHaveBeenCalledTimes(1);
    expect(activities.reportOutcome.mock.calls[0][0].result.status).toBe("SUCCEEDED");
  });

  it("executes a tool call then returns a final answer", async () => {
    activities.callLLM
      .mockResolvedValueOnce(toolCall())
      .mockResolvedValueOnce(finalAnswer());
    activities.executeTool.mockResolvedValue({
      toolName: "search",
      status: "succeeded",
      result: { data: "test" },
      latencyMs: 100,
    });

    const result = await reactWorkflow(baseInput());

    expect(result.status).toBe("SUCCEEDED");
    expect(result.iterations).toBe(2);
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]!.toolName).toBe("search");
    expect(result.toolCalls[0]!.status).toBe("succeeded");
    expect(activities.executeTool).toHaveBeenCalledTimes(1);
  });

  it("stops at maxIterations and returns MAX_ITERATIONS_REACHED", async () => {
    activities.callLLM.mockResolvedValue(toolCall());
    activities.executeTool.mockResolvedValue({
      toolName: "search",
      status: "succeeded",
      result: { data: "test" },
      latencyMs: 100,
    });

    const result = await reactWorkflow(baseInput({ maxIterations: 3 }));

    expect(result.status).toBe("MAX_ITERATIONS_REACHED");
    expect(result.iterations).toBe(3);
    expect(result.error).toContain("3 iterations");
  });

  it("returns CANCELLED when the cancel signal arrives mid-execution", async () => {
    activities.callLLM.mockImplementation(async () => {
      handlers["cancel"]();
      return toolCall();
    });
    activities.executeTool.mockResolvedValue({
      toolName: "search",
      status: "succeeded",
      result: { data: "test" },
      latencyMs: 100,
    });

    const result = await reactWorkflow(baseInput());

    expect(result.status).toBe("CANCELLED");
    expect(result.toolCalls.length).toBeGreaterThanOrEqual(0);
    expect(activities.reportOutcome.mock.calls[0][0].result.status).toBe("CANCELLED");
  });

  it("returns ERROR when admission is denied", async () => {
    activities.callLLM.mockResolvedValue(finalAnswer());
    activities.admitAgent.mockResolvedValue(false);

    const result = await reactWorkflow(baseInput());

    expect(result.status).toBe("ERROR");
    expect(result.output).toContain("admission");
    expect(activities.createSandbox).not.toHaveBeenCalled();
  });

  it("returns ERROR when admission throws", async () => {
    activities.callLLM.mockResolvedValue(finalAnswer());
    activities.admitAgent.mockRejectedValue(new Error("admission down"));

    const result = await reactWorkflow(baseInput());

    expect(result.status).toBe("ERROR");
    expect(result.output).toContain("Agent admission failed");
  });

  it("returns ERROR when policy denies execution", async () => {
    activities.callLLM.mockResolvedValue(finalAnswer());
    activities.evaluatePolicy.mockResolvedValue({ allow: false, reason: "nope" });

    const result = await reactWorkflow(baseInput());

    expect(result.status).toBe("ERROR");
    expect(result.output).toContain("Policy denied: nope");
    expect(activities.createSandbox).not.toHaveBeenCalled();
  });

  it("aborts when the cost budget is exceeded", async () => {
    activities.callLLM.mockResolvedValue(finalAnswer({ cost: "$2.000000" }));

    const result = await reactWorkflow(baseInput({ costBudgetUsd: 1 }));

    expect(result.status).toBe("ERROR");
    expect(result.output).toContain("Cost budget exceeded");
  });

  it("aborts on PII_VIOLATION tool errors", async () => {
    activities.callLLM.mockResolvedValue(toolCall());
    activities.executeTool.mockRejectedValue(new Error("PII_VIOLATION: blocked"));

    const result = await reactWorkflow(baseInput());

    expect(result.status).toBe("ERROR");
    expect(result.output).toContain("PII_VIOLATION");
  });

  it("continues after a generic tool failure", async () => {
    activities.callLLM
      .mockResolvedValueOnce(toolCall())
      .mockResolvedValueOnce(finalAnswer());
    activities.executeTool.mockRejectedValue(new Error("transient"));

    const result = await reactWorkflow(baseInput());

    expect(result.status).toBe("SUCCEEDED");
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]!.status).toBe("failed");
  });

  it("returns ERROR when sandbox creation fails", async () => {
    activities.callLLM.mockResolvedValue(finalAnswer());
    activities.createSandbox.mockRejectedValue(new Error("no capacity"));

    const result = await reactWorkflow(baseInput());

    expect(result.status).toBe("ERROR");
    expect(result.output).toContain("Sandbox creation failed");
    expect(activities.terminateSandbox).not.toHaveBeenCalled();
  });

  it("does not execute the same tool call twice (loop detection)", async () => {
    activities.callLLM
      .mockResolvedValueOnce(toolCall())
      .mockResolvedValueOnce(toolCall())
      .mockResolvedValueOnce(finalAnswer());
    activities.executeTool.mockResolvedValue({
      toolName: "search",
      status: "succeeded",
      result: { data: "test" },
      latencyMs: 100,
    });

    const result = await reactWorkflow(baseInput());

    expect(result.status).toBe("SUCCEEDED");
    expect(activities.executeTool).toHaveBeenCalledTimes(1);
    expect(result.iterations).toBe(3);
  });

  it("supports structured tool calls with toolCallId", async () => {
    activities.callLLM
      .mockResolvedValueOnce(
        toolCall({
          toolCallId: "call_9",
          toolCalls: [
            { id: "call_9", name: "search", args: '{"query":"test"}' },
          ],
        })
      )
      .mockResolvedValueOnce(finalAnswer());
    activities.executeTool.mockResolvedValue({
      toolName: "search",
      status: "succeeded",
      result: { data: "test" },
      latencyMs: 100,
    });

    const result = await reactWorkflow(baseInput());

    expect(result.status).toBe("SUCCEEDED");
    expect(result.toolCalls[0]!.toolCallId).toBe("call_9");
  });

  it("reports status via the status query handler", async () => {
    activities.callLLM.mockResolvedValue(finalAnswer());

    await reactWorkflow(baseInput());

    const statusHandler = handlers["status"];
    expect(statusHandler).toBeDefined();
    const status = statusHandler() as { iteration: number; lastAction: string; startTime: string };
    expect(status.iteration).toBe(1);
    expect(status.lastAction).toBe("final_answer");
    expect(status.startTime).toBe("2026-01-01T00:00:00.000Z");
  });
});

describe("hitlApprovalGate", () => {
  beforeEach(() => {
    for (const name of Object.keys(activities)) {
      activities[name].mockReset();
    }
    Object.keys(handlers).forEach((k) => delete handlers[k]);
    activities.persistMemory.mockResolvedValue({ status: "success", version: "v1" });
    activities.recordObservability.mockResolvedValue({ success: true });
  });

  function hitlInput(overrides: Partial<HITLApprovalInput> = {}): HITLApprovalInput {
    return {
      agentId: "agent-1",
      executionId: "exec-hitl",
      namespace: "test",
      toolName: "stripe.charges.create",
      toolArgs: { amount: 5000 },
      requesterNotes: "charge the customer",
      timeoutMs: 1000,
      ...overrides,
    };
  }

  it("returns the decision when the request is approved", async () => {
    workflowMock.condition.mockImplementation(async (_predicate: () => boolean) => {
      handlers["approval"]({ approver: "admin@example.com", decision: "approve", reason: "ok" });
      return true;
    });

    const result = await hitlApprovalGate(hitlInput());

    expect(result.decision).toBe("approve");
    expect(result.approver).toBe("admin@example.com");
    expect(result.reason).toBe("ok");
    expect(activities.persistMemory).toHaveBeenCalled();
    expect(activities.recordObservability).toHaveBeenCalled();
  });

  it("throws when the request is rejected", async () => {
    workflowMock.condition.mockImplementation(async (_predicate: () => boolean) => {
      handlers["approval"]({ approver: "admin@example.com", decision: "reject", reason: "too risky" });
      return true;
    });

    await expect(hitlApprovalGate(hitlInput())).rejects.toThrow("Human rejected execution");
  });

  it("auto-rejects on timeout", async () => {
    workflowMock.condition.mockResolvedValue(false);

    await expect(hitlApprovalGate(hitlInput())).rejects.toThrow("Human rejected execution");
  });
});
