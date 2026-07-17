// ─── Agent Execution Types ─────────────────────────────────────────────────

export interface AgentExecutionInput {
  agentId: string;
  executionId: string;
  namespace: string;
  /** Namespace of the resource being acted upon. Differs from namespace for cross-namespace deny tests. */
  resourceNamespace?: string;
  /** Role of the caller (platform_admin, namespace_admin, developer, viewer). Maps to OPA clearance. */
  callerRole?: string;
  systemPrompt?: string;
  model?: string;
  initialMessages?: Message[];
  tools?: ToolDefinition[];
  maxIterations?: number;
  requiresApproval?: boolean;
}

export interface Message {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  name?: string;
  toolCallId?: string;
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema?: Record<string, unknown>;
}

export interface LLMResponse {
  type: "final_answer" | "tool_call";
  content: string;
  toolName?: string;
  toolArgs?: Record<string, unknown>;
  toolCallId?: string;         // For structured tool-calling (role:tool matching)
  toolCalls?: Array<{          // Raw structured tool_calls from the LLM
    id: string;
    name: string;
    args: string;              // JSON-serialized arguments
  }>;
  modelUsed: string;
  cost: string;
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}

export interface ToolResult {
  toolName: string;
  status: "succeeded" | "failed";
  result?: unknown;
  errorMessage?: string;
  latencyMs: number;
}

export interface AgentResult {
  status: "SUCCEEDED" | "MAX_ITERATIONS_REACHED" | "CANCELLED" | "ERROR";
  output: string;
  totalCost: string;
  iterations: number;
  toolCalls: ToolCallRecord[];
  error?: string;
}

export interface ToolCallRecord {
  iteration: number;
  toolName: string;
  args: Record<string, unknown>;
  toolCallId?: string;         // Structured tool-calling ID for role:tool round-trip
  status: "succeeded" | "failed";
  latencyMs: number;
}

export interface WorkflowStatus {
  iteration: number;
  lastAction: string;
  startTime: string;
}

// ─── HITL Types ────────────────────────────────────────────────────────────

export interface HITLApprovalInput {
  agentId: string;
  executionId: string;
  namespace: string;
  toolName: string;
  toolArgs: Record<string, unknown>;
  requesterNotes?: string;
  timeoutMs?: number;
}

export interface ApprovalDecision {
  approver: string;
  decision: "approve" | "reject";
  reason?: string;
}

export interface HITLResult {
  decision: "approve" | "reject" | "timeout";
  approver?: string;
  reason?: string;
}
