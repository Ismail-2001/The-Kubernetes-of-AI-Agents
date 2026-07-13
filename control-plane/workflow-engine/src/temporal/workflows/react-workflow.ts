import {
  proxyActivities,
  sleep,
  setHandler,
  defineSignal,
  defineQuery,
  workflowInfo,
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

const {
  callLLM,
  executeTool,
  persistMemory,
  recordObservability,
  evaluatePolicy,
  admitAgent,
  createSandbox,
  terminateSandbox,
} = proxyActivities<typeof activities>({
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

// ─── ReAct Workflow ────────────────────────────────────────────────────────

export async function reactWorkflow(
  input: AgentExecutionInput
): Promise<AgentResult> {
  const maxIterations = Math.min(input.maxIterations ?? 10, 100);

  // NOTE: All mutable state is function-local, NOT module-level, because
  // Temporal reuses V8 isolates across workflow executions. Module-level let
  // variables would leak between concurrent executions sharing the same
  // isolate, causing iteration counts and cancellation flags to corrupt each
  // other. Function-local vars are captured per execution in Temporal's SDK
  // and are safe.
  const info = workflowInfo();
  const startTime = info.startTime.toISOString();
  let cancellationRequested = false;
  let currentIteration = 0;
  let lastAction = "starting";

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
        `You are a helpful AI agent with access to tools.

When you need to execute code, read/write files, or query data, call a tool using EXACTLY this format:

[tool:code_interpreter] {"code": "print('hello')"}
[tool:file_read] {"path": "/tmp/data.txt"}
[tool:file_write] {"path": "/tmp/output.txt", "content": "hello"}
[tool:database_query] {"query": "SELECT * FROM users"}

RULES:
- If the user asks to run code, execute a command, or perform a computation — ALWAYS use [tool:code_interpreter].
- If the user asks a simple factual question — answer directly without a tool.
- NEVER describe how you would do something — just do it using the tool.
- Use ONLY one tool call per response.
- Wait for the tool result before continuing.`
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

  // ── Step 1: Admission check ───────────────────────────────────────────
  lastAction = "admission_check";
  await recordObservability({
    executionId: input.executionId,
    step: "admission_check",
    status: "running",
  });

  let isAdmitted = false;
  try {
    isAdmitted = await admitAgent({
      agentId: input.agentId,
      namespace: input.namespace,
      spec: {},
    });
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    await recordObservability({
      executionId: input.executionId,
      step: "admission_check",
      status: "failed",
      attributes: { error: errMsg },
    });
    return {
      status: "ERROR",
      output: `Agent admission failed: ${errMsg}`,
      totalCost: "$0.000000",
      iterations: 0,
      toolCalls: [],
      error: errMsg,
    };
  }

  if (!isAdmitted) {
    await recordObservability({
      executionId: input.executionId,
      step: "admission_check",
      status: "denied",
    });
    return {
      status: "ERROR",
      output: "Agent failed admission policy",
      totalCost: "$0.000000",
      iterations: 0,
      toolCalls: [],
      error: "Agent failed admission policy",
    };
  }

  // ── Step 2: Policy evaluation ─────────────────────────────────────────
  lastAction = "policy_evaluation";
  await recordObservability({
    executionId: input.executionId,
    step: "policy_evaluation",
    status: "running",
  });

  const policyDecision = await evaluatePolicy({
    agentId: input.agentId,
    executionId: input.executionId,
    namespace: input.namespace,
    action: "execute",
    resourceNamespace: input.resourceNamespace,
    callerRole: input.callerRole,
  });

  if (!policyDecision.allow) {
    await recordObservability({
      executionId: input.executionId,
      step: "policy_evaluation",
      status: "denied",
      attributes: { reason: policyDecision.reason },
    });
    return {
      status: "ERROR",
      output: `Policy denied: ${policyDecision.reason}`,
      totalCost: "$0.000000",
      iterations: 0,
      toolCalls: [],
      error: `Policy denied: ${policyDecision.reason}`,
    };
  }

  // ── Step 3: Create sandbox ────────────────────────────────────────────
  lastAction = "create_sandbox";
  await recordObservability({
    executionId: input.executionId,
    step: "create_sandbox",
    status: "running",
  });

  let sandboxId = "";
  let sandboxIp = "";
  let result: AgentResult | null = null;
  try {
    const sandbox = await createSandbox({
      agentId: input.agentId,
      executionId: input.executionId,
      namespace: input.namespace,
      isolationLevel: "Standard",
      initCommands: [`echo "Sandbox ${input.executionId} ready"`],
    });
    sandboxId = sandbox.id;
    sandboxIp = sandbox.ipAddress ?? "";
    console.log(
      "Sandbox created with init output",
      sandboxId,
      JSON.stringify(sandbox.initOutputs)
    );

    await recordObservability({
      executionId: input.executionId,
      step: "create_sandbox",
      status: "completed",
      attributes: { sandboxId },
    });

    // Main ReAct loop
    // eslint-disable-next-line no-constant-condition
    while (currentIteration < maxIterations) {
      // Check cancellation
      if (cancellationRequested) {
        lastAction = "cancelled";
        await recordObservability({
          executionId: input.executionId,
          step: `react_cancelled_${currentIteration}`,
          status: "cancelled",
        });

        result = {
          status: "CANCELLED",
          output: output || "Execution cancelled by user",
          totalCost: `$${totalCost.toFixed(6)}`,
          iterations: currentIteration,
          toolCalls,
        };
        break;
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
          model: input.model,
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

        result = {
          status: "ERROR",
          output: output || `LLM call failed: ${errMsg}`,
          totalCost: `$${totalCost.toFixed(6)}`,
          iterations: currentIteration,
          toolCalls,
          error: errMsg,
        };
        break;
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

        result = {
          status: "SUCCEEDED",
          output,
          totalCost: `$${totalCost.toFixed(6)}`,
          iterations: currentIteration,
          toolCalls,
        };
        break;
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
            sandboxIp,
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

            result = {
              status: "ERROR",
              output: output || `Tool execution failed: ${errMsg}`,
              totalCost: `$${totalCost.toFixed(6)}`,
              iterations: currentIteration,
              toolCalls,
              error: errMsg,
            };
            break;
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
        // NOTE: Using role "user" (not "tool") because the platform's plain-text
        // [tool:...] convention does not populate structured tool_calls/tool_call_id
        // fields in the message. The OpenAI API schema requires those fields when
        // role is "tool", and omitting them causes a 400 across all providers.
        // Moving to a fully structured tool-calling format (with proper tool_call_id
        // and role:"tool") is a known, separate follow-up.
        const toolResultContent =
          toolResult.status === "succeeded"
            ? `Tool ${toolResult.toolName} executed successfully. Result: ${JSON.stringify(toolResult.result)}`
            : `Tool ${toolResult.toolName} failed: ${toolResult.errorMessage}`;

        messages.push({
          role: "user",
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

    // Max iterations reached (loop exited without break)
    if (!result) {
      lastAction = "max_iterations";

      await recordObservability({
        executionId: input.executionId,
        step: "react_max_iterations",
        status: "completed",
      });

      result = {
        status: "MAX_ITERATIONS_REACHED",
        output: output || `Execution stopped after ${maxIterations} iterations`,
        totalCost: `$${totalCost.toFixed(6)}`,
        iterations: currentIteration,
        toolCalls,
        error: `ReAct loop exceeded ${maxIterations} iterations`,
      };
    }
  } catch (err: unknown) {
    // Catch unexpected errors from sandbox creation or ReAct loop
    const errMsg = err instanceof Error ? err.message : String(err);
    await recordObservability({
      executionId: input.executionId,
      step: "create_sandbox",
      status: "failed",
      attributes: { error: errMsg },
    });
    result = {
      status: "ERROR",
      output: `Sandbox creation failed: ${errMsg}`,
      totalCost: "$0.000000",
      iterations: 0,
      toolCalls: [],
      error: errMsg,
    };
  } finally {
    // Always terminate the sandbox if one was created
    if (sandboxId) {
      try {
        await terminateSandbox({
          sandboxId,
          reason: result?.status ?? "unknown",
        });
      } catch (termErr: unknown) {
        const termMsg = termErr instanceof Error ? termErr.message : String(termErr);
        console.log("Sandbox termination failed", sandboxId, termMsg);
      }
    }
  }

  if (!result) {
    result = {
      status: "ERROR",
      output: "Workflow exited unexpectedly",
      totalCost: "$0.000000",
      iterations: currentIteration,
      toolCalls: [],
      error: "Unexpected exit",
    };
  }

  return result;
}
