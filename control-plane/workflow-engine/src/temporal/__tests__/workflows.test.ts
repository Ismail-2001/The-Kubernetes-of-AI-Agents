import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import path from "path";
import {
  reactWorkflow,
  cancelSignal,
  statusQuery,
} from "../workflows/react-workflow";
import { hitlApprovalGate, approvalSignal } from "../workflows/hitl-gate";
import type { AgentExecutionInput, HITLApprovalInput, HITLResult } from "../types";

// ─── Mock Activities ───────────────────────────────────────────────────────

function createMockActivities() {
  return {
    callLLM: jest.fn(),
    executeTool: jest.fn(),
    persistMemory: jest.fn().mockResolvedValue({ status: "success", version: "v1" }),
    recordObservability: jest.fn().mockResolvedValue({ success: true }),
  };
}

// ─── Test Environment ──────────────────────────────────────────────────────

describe("Temporal Workflows", () => {
  let testEnv: TestWorkflowEnvironment;
  let mockActivities: ReturnType<typeof createMockActivities>;

  beforeAll(async () => {
    testEnv = await TestWorkflowEnvironment.createTimeSkipping();
    mockActivities = createMockActivities();
  });

  afterAll(async () => {
    await testEnv?.teardown();
  });

  beforeEach(() => {
    mockActivities = createMockActivities();
  });

  // ─── ReAct Workflow Tests ──────────────────────────────────────────────

  describe("reactWorkflow", () => {
    it("should complete in 3 iterations with final answer", async () => {
      // Mock LLM responses: 2 tool calls then final answer
      mockActivities.callLLM
        .mockResolvedValueOnce({
          type: "tool_call",
          content: '[tool: search] "args": {"query": "test"}',
          toolName: "search",
          toolArgs: { query: "test" },
          modelUsed: "gpt-4o",
          cost: "$0.001",
          usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
        })
        .mockResolvedValueOnce({
          type: "tool_call",
          content: '[tool: calculate] "args": {"expression": "2+2"}',
          toolName: "calculate",
          toolArgs: { expression: "2+2" },
          modelUsed: "gpt-4o",
          cost: "$0.001",
          usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
        })
        .mockResolvedValueOnce({
          type: "final_answer",
          content: "[FINAL ANSWER] The answer is 4",
          modelUsed: "gpt-4o",
          cost: "$0.001",
          usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
        });

      mockActivities.executeTool.mockResolvedValue({
        toolName: "search",
        status: "succeeded",
        result: { data: "test" },
        latencyMs: 100,
      });

      const worker = await Worker.create({
        workflowsPath: path.join(__dirname, "../workflows"),
        activities: mockActivities,
        taskQueue: "test-react",
      });

      const result = await testEnv.client.workflow.execute(reactWorkflow, {
        taskQueue: "test-react",
        workflowId: "test-react-1",
        args: [
          {
            agentId: "agent-1",
            executionId: "exec-1",
            namespace: "test",
            maxIterations: 10,
          } as AgentExecutionInput,
        ],
      });

      expect(result.status).toBe("SUCCEEDED");
      expect(result.iterations).toBe(3);
      expect(result.toolCalls).toHaveLength(2);
      expect(result.toolCalls[0]!.toolName).toBe("search");
      expect(result.toolCalls[1]!.toolName).toBe("calculate");
      expect(result.output).toContain("FINAL ANSWER");

      await worker.shutdown();
    });

    it("should stop at maxIterations and return partial result", async () => {
      // Mock LLM to always return tool calls (never final answer)
      mockActivities.callLLM.mockResolvedValue({
        type: "tool_call",
        content: '[tool: search] "args": {"query": "test"}',
        toolName: "search",
        toolArgs: { query: "test" },
        modelUsed: "gpt-4o",
        cost: "$0.001",
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      });

      mockActivities.executeTool.mockResolvedValue({
        toolName: "search",
        status: "succeeded",
        result: { data: "test" },
        latencyMs: 100,
      });

      const worker = await Worker.create({
        workflowsPath: path.join(__dirname, "../workflows"),
        activities: mockActivities,
        taskQueue: "test-max-iter",
      });

      const result = await testEnv.client.workflow.execute(reactWorkflow, {
        taskQueue: "test-max-iter",
        workflowId: "test-max-iter-1",
        args: [
          {
            agentId: "agent-1",
            executionId: "exec-2",
            namespace: "test",
            maxIterations: 3,
          } as AgentExecutionInput,
        ],
      });

      expect(result.status).toBe("MAX_ITERATIONS_REACHED");
      expect(result.iterations).toBe(3);
      expect(result.toolCalls).toHaveLength(3);
      expect(result.error).toContain("3 iterations");

      await worker.shutdown();
    });

    it("should handle cancel signal mid-execution", async () => {
      // Mock LLM to take some iterations
      let callCount = 0;
      mockActivities.callLLM.mockImplementation(async () => {
        callCount++;
        if (callCount === 2) {
          // Send cancel signal after 2nd call
          const handle = testEnv.client.workflow.getHandle("exec-cancel-test");
          await handle.signal(cancelSignal);
        }
        return {
          type: "tool_call",
          content: '[tool: search] "args": {"query": "test"}',
          toolName: "search",
          toolArgs: { query: "test" },
          modelUsed: "gpt-4o",
          cost: "$0.001",
          usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
        };
      });

      mockActivities.executeTool.mockResolvedValue({
        toolName: "search",
        status: "succeeded",
        result: { data: "test" },
        latencyMs: 100,
      });

      const worker = await Worker.create({
        workflowsPath: path.join(__dirname, "../workflows"),
        activities: mockActivities,
        taskQueue: "test-cancel",
      });

      const result = await testEnv.client.workflow.execute(reactWorkflow, {
        taskQueue: "test-cancel",
        workflowId: "exec-cancel-test",
        args: [
          {
            agentId: "agent-1",
            executionId: "exec-cancel-test",
            namespace: "test",
            maxIterations: 10,
          } as AgentExecutionInput,
        ],
      });

      expect(result.status).toBe("CANCELLED");
      expect(result.iterations).toBeGreaterThanOrEqual(2);

      await worker.shutdown();
    });

    it("should return workflow status via query", async () => {
      let resolveLLM: () => void;
      const llmPromise = new Promise<void>((resolve) => {
        resolveLLM = resolve;
      });

      mockActivities.callLLM.mockImplementation(async () => {
        await llmPromise;
        return {
          type: "final_answer",
          content: "[FINAL ANSWER] Done",
          modelUsed: "gpt-4o",
          cost: "$0.001",
          usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
        };
      });

      const worker = await Worker.create({
        workflowsPath: path.join(__dirname, "../workflows"),
        activities: mockActivities,
        taskQueue: "test-query",
      });

      const handle = await testEnv.client.workflow.start(reactWorkflow, {
        taskQueue: "test-query",
        workflowId: "exec-query",
        args: [
          {
            agentId: "agent-1",
            executionId: "exec-query",
            namespace: "test",
          } as AgentExecutionInput,
        ],
      });

      // Wait a bit for workflow to start
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Query status
      const status = await handle.query(statusQuery);
      expect(status).toBeDefined();
      expect(status.iteration).toBeGreaterThanOrEqual(0);
      expect(status.lastAction).toBeDefined();

      // Complete the workflow
      resolveLLM!();
      await handle.result();

      await worker.shutdown();
    });

    it("should handle LLM activity failure with retries", async () => {
      // Mock LLM to fail twice then succeed
      mockActivities.callLLM
        .mockRejectedValueOnce(new Error("Rate limited"))
        .mockRejectedValueOnce(new Error("Rate limited"))
        .mockResolvedValueOnce({
          type: "final_answer",
          content: "[FINAL ANSWER] Success after retries",
          modelUsed: "gpt-4o",
          cost: "$0.001",
          usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
        });

      const worker = await Worker.create({
        workflowsPath: path.join(__dirname, "../workflows"),
        activities: mockActivities,
        taskQueue: "test-retry",
      });

      const result = await testEnv.client.workflow.execute(reactWorkflow, {
        taskQueue: "test-retry",
        workflowId: "test-retry-1",
        args: [
          {
            agentId: "agent-1",
            executionId: "exec-retry",
            namespace: "test",
            maxIterations: 5,
          } as AgentExecutionInput,
        ],
      });

      expect(result.status).toBe("SUCCEEDED");
      expect(result.output).toContain("Success after retries");

      await worker.shutdown();
    });
  });

  // ─── HITL Gate Tests ──────────────────────────────────────────────────

  describe("hitlApprovalGate", () => {
    it("should block until approve signal arrives", async () => {
      const worker = await Worker.create({
        workflowsPath: path.join(__dirname, "../workflows"),
        activities: mockActivities,
        taskQueue: "test-hitl",
      });

      const handle = await testEnv.client.workflow.start(hitlApprovalGate, {
        taskQueue: "test-hitl",
        workflowId: "exec-hitl-1",
        args: [
          {
            agentId: "agent-1",
            executionId: "exec-hitl-1",
            namespace: "test-ns",
            toolName: "stripe.charges.create",
            toolArgs: { amount: 5000 },
            timeoutMs: 5000,
          } as HITLApprovalInput,
        ],
      });

      // Wait a bit for workflow to start
      await new Promise((resolve) => setTimeout(resolve, 200));

      // Send approve signal
      await handle.signal(approvalSignal, {
        approver: "admin@example.com",
        decision: "approve",
        reason: "Looks good",
      });

      const result = await handle.result();

      expect(result.decision).toBe("approve");
      expect(result.approver).toBe("admin@example.com");
      expect(result.reason).toBe("Looks good");

      await worker.shutdown();
    });

    it("should throw on reject signal", async () => {
      const worker = await Worker.create({
        workflowsPath: path.join(__dirname, "../workflows"),
        activities: mockActivities,
        taskQueue: "test-hitl-reject",
      });

      const handle = await testEnv.client.workflow.start(hitlApprovalGate, {
        taskQueue: "test-hitl-reject",
        workflowId: "exec-hitl-2",
        args: [
          {
            agentId: "agent-1",
            executionId: "exec-hitl-2",
            toolName: "admin.delete",
            toolArgs: {},
            timeoutMs: 5000,
          } as HITLApprovalInput,
        ],
      });

      // Wait a bit for workflow to start
      await new Promise((resolve) => setTimeout(resolve, 200));

      // Send reject signal
      await handle.signal(approvalSignal, {
        approver: "admin@example.com",
        decision: "reject",
        reason: "Too risky",
      });

      await expect(handle.result()).rejects.toThrow("Human rejected execution");

      await worker.shutdown();
    });

    it("should auto-reject after timeout", async () => {
      const worker = await Worker.create({
        workflowsPath: path.join(__dirname, "../workflows"),
        activities: mockActivities,
        taskQueue: "test-hitl-timeout",
      });

      const handle = await testEnv.client.workflow.start(hitlApprovalGate, {
        taskQueue: "test-hitl-timeout",
        workflowId: "exec-hitl-3",
        args: [
          {
            agentId: "agent-1",
            executionId: "exec-hitl-3",
            toolName: "sensitive.action",
            toolArgs: {},
            timeoutMs: 1000, // 1 second timeout
          } as HITLApprovalInput,
        ],
      });

      // Wait for timeout
      await expect(handle.result()).rejects.toThrow("Human rejected execution");

      await worker.shutdown();
    });
  });
});
