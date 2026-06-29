import {
  proxyActivities,
  sleep,
  setHandler,
  defineSignal,
  defineQuery,
} from "@temporalio/workflow";
import type * as activities from "../activities";
import type {
  AgentExecutionInput,
  AgentResult,
  Message,
  ToolCallRecord,
  WorkflowStatus,
  LLMResponse,
  ToolResult,
} from "../types";

// ─── Activity Proxies ──────────────────────────────────────────────────────

const { callLLM, executeTool, persistMemory, recordObservability } =
  proxyActivities<typeof activities>({
    startToCloseTimeout: "5 minutes",
    retry: {
      maximumAttempts: 3,
      initialInterval: "1s",
      backoffCoefficient: 2,
    },
  });

// ─── Signal & Query Handlers ───────────────────────────────────────────────

export const cancelSignal = defineSignal("cancel");
export const statusQuery = defineQuery<WorkflowStatus>("status");

// ─── Workflow State (deterministic) ────────────────────────────────────────

let cancellationRequested = false;
let currentIteration = 0;
let lastAction = "initialized";
let startTime = "";

// ─── ReAct Workflow ────────────────────────────────────────────────────────

export async function reactWorkflow(
  input: AgentExecutionInput
): Promise<AgentResult> {
  const maxIterations = Math.min(input.maxIterations ?? 10, 100);

  // Initialize state (deterministic)
  startTime = new Date(0).toISOString(); // Will be set by Temporal
  lastAction = "starting";

  // Register signal and query handlers
  setHandler(cancelSignal, () => {
    cancellationRequested = true;
    lastAction = "cancellation_requested";
  });

  setHandler(statusQuery, () => ({
    iteration: currentIteration,
    lastAction,
    startTime,
  }));

  // Initialize messages
  const messages: Message[] = [
    {
      role: "system",
      content:
        input.systemPrompt ??
        "You are a helpful AI agent. Use the available tools to complete the user request.",
    },
    ...(input.initialMessages ?? []),
  ];

  const toolCalls: ToolCallRecord[] = [];
  let totalCost = 0;
  let output = "";

  await recordObservability({
    executionId: input.executionId,
    step: "react_workflow_started",
    status: "running",
  });

  // Main ReAct loop
  while (currentIteration < maxIterations) {
    // Check cancellation
    if (cancellationRequested) {
      lastAction = "cancelled";
      await recordObservability({
        executionId: input.executionId,
        step: `react_cancelled_${currentIteration}`,
        status: "cancelled",
      });

      return {
        status: "CANCELLED",
        output: output || "Execution cancelled by user",
        totalCost: `$${totalCost.toFixed(6)}`,
        iterations: currentIteration,
        toolCalls,
      };
    }

    currentIteration++;
    lastAction = `llm_call_${currentIteration}`;

    await recordObservability({
      executionId: input.executionId,
      step: `react_llm_${currentIteration}`,
      status: "running",
    });

    // Call LLM
    let llmResponse: LLMResponse;
    try {
      llmResponse = (await callLLM({
        agentId: input.agentId,
        executionId: input.executionId,
        namespace: input.namespace,
        messages: messages.map((m) => ({ role: m.role, content: m.content })),
      })) as LLMResponse;
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      lastAction = `llm_error_${currentIteration}`;
      await recordObservability({
        executionId: input.executionId,
        step: `react_llm_error_${currentIteration}`,
        status: "failed",
        attributes: { error: errMsg },
      });

      return {
        status: "ERROR",
        output: output || `LLM call failed: ${errMsg}`,
        totalCost: `$${totalCost.toFixed(6)}`,
        iterations: currentIteration,
        toolCalls,
        error: errMsg,
      };
    }

    // Track cost
    const costValue = parseFloat(
      llmResponse.cost?.replace("$", "") || "0"
    );
    totalCost += costValue;

    // Add assistant response to messages
    messages.push({
      role: "assistant",
      content: llmResponse.content,
    });

    // Check for final answer
    if (llmResponse.type === "final_answer") {
      output = llmResponse.content;
      lastAction = "final_answer";

      // Persist final state to memory
      try {
        await persistMemory({
          agentId: input.agentId,
          namespace: input.namespace,
          memoryType: "session",
          key: `execution_${input.executionId}_result`,
          data: {
            output,
            totalCost: `$${totalCost.toFixed(6)}`,
            iterations: currentIteration,
          },
        });
      } catch {
        // Memory persistence failure is non-fatal
      }

      await recordObservability({
        executionId: input.executionId,
        step: `react_completed_${currentIteration}`,
        status: "completed",
        attributes: { totalCost: `$${totalCost.toFixed(6)}` },
      });

      return {
        status: "SUCCEEDED",
        output,
        totalCost: `$${totalCost.toFixed(6)}`,
        iterations: currentIteration,
        toolCalls,
      };
    }

    // Handle tool call
    if (
      llmResponse.type === "tool_call" &&
      llmResponse.toolName
    ) {
      lastAction = `tool_call_${llmResponse.toolName}`;

      await recordObservability({
        executionId: input.executionId,
        step: `react_tool_call_${llmResponse.toolName}_${currentIteration}`,
        status: "running",
        attributes: {
          toolName: llmResponse.toolName,
          args: JSON.stringify(llmResponse.toolArgs ?? {}),
        },
      });

      // Execute tool
      let toolResult: ToolResult;
      try {
        toolResult = (await executeTool({
          agentId: input.agentId,
          executionId: input.executionId,
          namespace: input.namespace,
          toolName: llmResponse.toolName,
          args: llmResponse.toolArgs ?? {},
        })) as ToolResult;
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);

        // Non-retryable errors abort execution
        if (
          errMsg.includes("PII_VIOLATION") ||
          errMsg.includes("POLICY_DENIED")
        ) {
          lastAction = `tool_error_${llmResponse.toolName}`;

          await recordObservability({
            executionId: input.executionId,
            step: `react_tool_error_${llmResponse.toolName}_${currentIteration}`,
            status: "failed",
            attributes: { error: errMsg },
          });

          return {
            status: "ERROR",
            output: output || `Tool execution failed: ${errMsg}`,
            totalCost: `$${totalCost.toFixed(6)}`,
            iterations: currentIteration,
            toolCalls,
            error: errMsg,
          };
        }

        toolResult = {
          toolName: llmResponse.toolName,
          status: "failed",
          errorMessage: errMsg,
          latencyMs: 0,
        };
      }

      // Record tool call
      toolCalls.push({
        iteration: currentIteration,
        toolName: llmResponse.toolName,
        args: llmResponse.toolArgs ?? {},
        status: toolResult.status,
        latencyMs: toolResult.latencyMs,
      });

      // Add tool result to messages
      const toolResultContent =
        toolResult.status === "succeeded"
          ? `Tool ${toolResult.toolName} executed successfully. Result: ${JSON.stringify(toolResult.result)}`
          : `Tool ${toolResult.toolName} failed: ${toolResult.errorMessage}`;

      messages.push({
        role: "tool",
        content: toolResultContent,
        name: toolResult.toolName,
      });

      // Persist iteration memory
      try {
        await persistMemory({
          agentId: input.agentId,
          namespace: input.namespace,
          memoryType: "working",
          key: `iteration_${currentIteration}`,
          data: {
            toolName: toolResult.toolName,
            status: toolResult.status,
            iteration: currentIteration,
          },
        });
      } catch {
        // Memory persistence failure is non-fatal
      }

      await recordObservability({
        executionId: input.executionId,
        step: `react_tool_result_${llmResponse.toolName}_${currentIteration}`,
        status: toolResult.status,
        attributes: { latencyMs: String(toolResult.latencyMs) },
      });
    } else {
      // No tool call and not final answer - prompt for continuation
      messages.push({
        role: "user",
        content:
          "Continue. If you have a final answer, prefix it with [FINAL ANSWER].",
      });
    }

    // Yield to Temporal (deterministic sleep)
    await sleep(100);
  }

  // Max iterations reached
  lastAction = "max_iterations";

  await recordObservability({
    executionId: input.executionId,
    step: "react_max_iterations",
    status: "completed",
  });

  return {
    status: "MAX_ITERATIONS_REACHED",
    output: output || `Execution stopped after ${maxIterations} iterations`,
    totalCost: `$${totalCost.toFixed(6)}`,
    iterations: currentIteration,
    toolCalls,
    error: `ReAct loop exceeded ${maxIterations} iterations`,
  };
}
