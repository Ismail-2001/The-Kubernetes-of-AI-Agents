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

// ─── Tool Definitions (structured tool-calling) ────────────────────────────

const TOOL_DEFINITIONS: import("../types").ToolDefinition[] = [
  {
    name: "code_interpreter",
    description: "Execute Python code in a sandboxed runtime. Returns stdout/stderr output.",
    inputSchema: {
      type: "object",
      properties: {
        code: { type: "string", description: "Python code to execute" },
      },
      required: ["code"],
    },
  },
  {
    name: "file_read",
    description: "Read the contents of a file from the sandbox filesystem.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute path to the file" },
      },
      required: ["path"],
    },
  },
  {
    name: "file_write",
    description: "Write content to a file in the sandbox filesystem.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute path to the file" },
        content: { type: "string", description: "Content to write" },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "database_query",
    description: "Execute a SQL query against the sandbox SQLite database at /tmp/data.db.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "SQL query to execute" },
      },
      required: ["query"],
    },
  },
];

// ─── ReAct Workflow ────────────────────────────────────────────────────────

export async function reactWorkflow(
  input: AgentExecutionInput
): Promise<AgentResult> {
  const maxIterations = Math.min(input.maxIterations ?? 20, 100);

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

  // Use tools from input if provided, otherwise use default set
  const toolDefinitions = input.tools?.length ? input.tools : TOOL_DEFINITIONS;

  // Initialize messages
  const messages: Message[] = [
    {
      role: "system",
      content:
        input.systemPrompt ??
        `You are a helpful AI agent with access to functions. Rules:
1. For simple questions you can answer from memory (trivial math, general knowledge, greetings), answer directly without calling any function.
2. Only call a function when you genuinely need external data or computation that you cannot do yourself.
3. After calling a function and receiving its output, use the result to answer the user. Do NOT re-call the same function with the same arguments — if the output is available, it is final.
4. Provide your final answer as soon as you have enough information. Do not make unnecessary additional function calls.`
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
          messages: messages.map((m) => ({
            role: m.role,
            content: m.content,
            toolCallId: m.toolCallId,
            toolCalls: (m as any).toolCalls,
          })),
          model: input.model,
          toolDefinitions: toolDefinitions.map((td) => ({
            name: td.name,
            description: td.description,
            inputSchema: td.inputSchema,
          })),
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
      // If the LLM returned structured tool_calls, attach them for conversation continuity
      const assistantMsg: Message & { toolCalls?: Array<{ id: string; name: string; args: string }> } = {
        role: "assistant",
        content: llmResponse.content,
      };
      if (llmResponse.toolCalls?.length) {
        assistantMsg.toolCalls = llmResponse.toolCalls;
      }
      messages.push(assistantMsg);

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
          toolCallId: llmResponse.toolCallId,
          status: toolResult.status,
          latencyMs: toolResult.latencyMs,
        });

        // Add tool result to messages
        // When the LLM used structured tool-calling (toolCallId present), use role:tool
        // with matching tool_call_id per the OpenAI/Anthropic spec. Otherwise fall back
        // to role:user with tool name in content (for [tool:] plain-text convention).
        if (llmResponse.toolCallId) {
          messages.push({
            role: "tool",
            content: toolResult.status === "succeeded"
              ? JSON.stringify(toolResult.result ?? "")
              : `Error: ${toolResult.errorMessage}`,
            toolCallId: llmResponse.toolCallId,
          });
        } else {
          const toolResultContent =
            toolResult.status === "succeeded"
              ? `Tool ${toolResult.toolName} executed successfully. Result: ${JSON.stringify(toolResult.result)}`
              : `Tool ${toolResult.toolName} failed: ${toolResult.errorMessage}`;

          messages.push({
            role: "user",
            content: toolResultContent,
            name: toolResult.toolName,
          });
        }

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
