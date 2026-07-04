import { Context } from "@temporalio/activity";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import fs from "fs";
import path from "path";
import { QuotaEnforcer } from "@e-gaop/shared";
import type { LLMResponse, ToolResult } from "../types";

const quotaEnforcer = new QuotaEnforcer();

// ─── gRPC Client Setup ─────────────────────────────────────────────────────

const TLS_ENABLED = process.env.TLS_ENABLED === "true";
const TLS_CERT_DIR = process.env.TLS_CERT_DIR || "/etc/egaop/certs";

function getClientCredentials(): grpc.ChannelCredentials {
  if (!TLS_ENABLED) return grpc.credentials.createInsecure();
  return grpc.credentials.createSsl(
    Buffer.from(fs.readFileSync(path.join(TLS_CERT_DIR, "ca-cert.pem"), "utf8")),
    Buffer.from(fs.readFileSync(path.join(TLS_CERT_DIR, "client-key.pem"), "utf8")),
    Buffer.from(fs.readFileSync(path.join(TLS_CERT_DIR, "client-cert.pem"), "utf8"))
  );
}

const PROTO_ROOT = path.resolve(__dirname, "../../../../../api/proto");

function loadService(protoFile: string, serviceName: string) {
  const def = protoLoader.loadSync(protoFile, {
    keepCase: true,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true,
    includeDirs: [PROTO_ROOT],
  });
  const pkg = grpc.loadPackageDefinition(def) as Record<string, Record<string, grpc.ServiceDefinition<grpc.UntypedHandleCall>>>;
  const parts = serviceName.split(".");
  let svc: Record<string, unknown> = pkg;
  for (const part of parts) {
    svc = (svc as Record<string, unknown>)[part] as Record<string, unknown>;
  }
  return svc;
}

function createClient(
  serviceProto: string,
  serviceName: string,
  address: string
) {
  const svc = loadService(path.resolve(PROTO_ROOT, serviceProto), serviceName);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new (svc as any)(address, getClientCredentials());
}

function promisifyGRPC<TReq, TRes>(
  client: unknown,
  method: string
): (args: TReq) => Promise<TRes> {
  return (args: TReq) =>
    new Promise<TRes>((resolve, reject) => {
      const deadline = new Date();
      deadline.setSeconds(deadline.getSeconds() + 10);
      const clientMethods = client as Record<string, Function | undefined>;
      const grpcMethod = clientMethods[method];
      if (!grpcMethod) {
        reject(new Error(`gRPC method ${method} not found`));
        return;
      }
      grpcMethod.call(
        client,
        args,
        { deadline },
        (err: grpc.ServiceError | null, res: TRes) => {
          if (err) reject(err);
          else resolve(res);
        }
      );
    });
}

// Initialize clients
const llmRouterAddr = process.env.LLM_ROUTER_ADDR || "localhost:50053";
const toolProxyAddr = process.env.TOOL_PROXY_ADDR || "localhost:50052";
const memoryPlaneAddr = process.env.MEMORY_PLANE_ADDR || "localhost:50055";
const observabilityAddr =
  process.env.OBSERVABILITY_PLANE_ADDR || "localhost:50056";

const llmClient = createClient(
  "egaop/v1/llm.proto",
  "egaop.v1.LLMService",
  llmRouterAddr
);
const toolClient = createClient(
  "egaop/v1/tool.proto",
  "egaop.v1.ToolService",
  toolProxyAddr
);
const memoryClient = createClient(
  "egaop/v1/memory.proto",
  "egaop.v1.MemoryService",
  memoryPlaneAddr
);
const obsClient = createClient(
  "egaop/v1/execution.proto",
  "egaop.v1.ObservabilityService",
  observabilityAddr
);

const llmGenerateCall = promisifyGRPC<unknown, unknown>(llmClient, "Generate");
const toolCallExec = promisifyGRPC<unknown, unknown>(toolClient, "CallTool");
const memoryWriteCall = promisifyGRPC<unknown, unknown>(memoryClient, "Write");
const recordTraceCall = promisifyGRPC<unknown, unknown>(
  obsClient,
  "ExportTrace"
);

// ─── Activity: callLLM ─────────────────────────────────────────────────────

interface CallLLMParams {
  agentId: string;
  executionId: string;
  namespace: string;
  messages: Array<{ role: string; content: string }>;
}

export async function callLLM(params: CallLLMParams): Promise<LLMResponse> {
  const ctx = Context.current();

  await quotaEnforcer.check(params.namespace, "concurrent_executions", 1);

  // Heartbeat for long LLM calls
  const heartbeatTimer = setInterval(() => {
    ctx.heartbeat("LLM request in progress");
  }, 10000);

  try {
    const response = (await llmGenerateCall({
      agent_id: params.agentId,
      execution_id: params.executionId,
      namespace: params.namespace,
      messages: params.messages,
      temperature: 0.7,
    })) as {
      content: string;
      model_used: string;
      cost: string;
      usage: {
        prompt_tokens: number;
        completion_tokens: number;
        total_tokens: number;
      };
    };

    const content = response.content ?? "";
    const lower = content.toLowerCase();

    // Determine response type based on content parsing
    let type: "final_answer" | "tool_call" = "final_answer";
    let toolName: string | undefined;
    let toolArgs: Record<string, unknown> | undefined;

    if (
      lower.includes("[tool:") ||
      lower.includes("use tool:") ||
      lower.includes('"tool"')
    ) {
      type = "tool_call";
      const toolMatch = content.match(
        /\[tool:\s*(\w+)\]|"tool"\s*:\s*"(\w+)"/i
      );
      toolName = toolMatch?.[1] ?? toolMatch?.[2];

      // Parse args if present
      const argsMatch = content.match(/"args"\s*:\s*(\{[^}]+\})/);
      if (argsMatch?.[1]) {
        try {
          toolArgs = JSON.parse(argsMatch[1]);
        } catch {
          toolArgs = {};
        }
      }
    }

    return {
      type,
      content,
      toolName,
      toolArgs,
      modelUsed: response.model_used ?? "unknown",
      cost: response.cost ?? "$0.00",
      usage: {
        promptTokens: response.usage?.prompt_tokens ?? 0,
        completionTokens: response.usage?.completion_tokens ?? 0,
        totalTokens: response.usage?.total_tokens ?? 0,
      },
    };
  } finally {
    clearInterval(heartbeatTimer);
    await quotaEnforcer.release(params.namespace, "concurrent_executions", 1);
  }
}

// ─── Activity: executeTool ─────────────────────────────────────────────────

interface ExecuteToolParams {
  agentId: string;
  executionId: string;
  namespace: string;
  toolName: string;
  args: Record<string, unknown>;
}

export async function executeTool(params: ExecuteToolParams): Promise<ToolResult> {
  const startTime = Date.now();

  await quotaEnforcer.check(params.namespace, "tool_calls_per_minute", 1);

  try {
    const response = (await toolCallExec({
      agent_id: params.agentId,
      execution_id: params.executionId,
      tool_name: params.toolName,
      args: params.args,
    })) as {
      result?: unknown;
      status: string;
      error_message?: string;
      latency_ms: number;
    };

    return {
      toolName: params.toolName,
      status: response.status === "succeeded" ? "succeeded" : "failed",
      result: response.result,
      errorMessage: response.error_message,
      latencyMs: response.latency_ms ?? Date.now() - startTime,
    };
  } catch (err: unknown) {
    const grpcErr = err as { code?: number; details?: string; message?: string };

    // Check for non-retryable errors
    if (grpcErr.details?.includes("PII_VIOLATION")) {
      throw new Error("PII_VIOLATION: Tool execution blocked due to PII detection");
    }
    if (grpcErr.details?.includes("POLICY_DENIED")) {
      throw new Error("POLICY_DENIED: Tool execution denied by policy");
    }

    return {
      toolName: params.toolName,
      status: "failed",
      errorMessage: grpcErr.details ?? grpcErr.message ?? "Unknown error",
      latencyMs: Date.now() - startTime,
    };
  }
}

// ─── Activity: persistMemory ───────────────────────────────────────────────

interface PersistMemoryParams {
  agentId: string;
  namespace: string;
  memoryType: string;
  key: string;
  data: Record<string, unknown>;
}

export async function persistMemory(
  params: PersistMemoryParams
): Promise<{ status: string; version: string }> {
  try {
    const response = (await memoryWriteCall({
      agent_id: params.agentId,
      namespace: params.namespace,
      memory_type: params.memoryType,
      key: params.key,
      data: params.data,
    })) as { status: string; version: string };

    return {
      status: response.status ?? "success",
      version: response.version ?? "",
    };
  } catch (err: unknown) {
    const grpcErr = err as { details?: string; message?: string };
    throw new Error(
      `Memory persist failed: ${grpcErr.details ?? grpcErr.message}`
    );
  }
}

// ─── Activity: recordObservability ─────────────────────────────────────────

interface RecordObservabilityParams {
  executionId: string;
  step: string;
  status: string;
  attributes?: Record<string, unknown>;
}

export async function recordObservability(
  params: RecordObservabilityParams
): Promise<{ success: boolean }> {
  try {
    await recordTraceCall({
      execution_id: params.executionId,
      span_id: `span-${params.step}-${Date.now()}`,
      name: params.step,
      start_time: { seconds: Math.floor(Date.now() / 1000) },
      end_time: { seconds: Math.floor(Date.now() / 1000) },
      attributes: {
        fields: {
          "egaop.step.status": { stringValue: params.status },
          ...Object.fromEntries(
            Object.entries(params.attributes ?? {}).map(([k, v]) => [
              k,
              { stringValue: String(v) },
            ])
          ),
        },
      },
    });
    return { success: true };
  } catch {
    return { success: false };
  }
}
