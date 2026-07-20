import { Context } from "@temporalio/activity";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import fs from "fs";
import http from "http";
import path from "path";
import { QuotaEnforcer, getClientCredentials, getStandardInterceptors, QuotaExceededError } from "@e-gaop/shared";
import type { LLMResponse, ToolResult } from "../types";
import { classifyLLMResponse } from "../classification";

const quotaEnforcer = new QuotaEnforcer();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForQuota(namespace: string, resource: string, amount: number = 1): Promise<void> {
  const maxWaitMs = 240_000; // 4 minutes (activity timeout is 5 min)
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    try {
      await quotaEnforcer.check(namespace, resource, amount);
      return;
    } catch (err) {
      if (err instanceof QuotaExceededError) {
        const retryAfter = Math.min(err.retryAfterMs ?? 1000, 10_000);
        await sleep(retryAfter);
        continue;
      }
      throw err;
    }
  }
  // Exhausted max wait — let the original error propagate
  await quotaEnforcer.check(namespace, resource, amount);
}

// ─── gRPC Client Setup ─────────────────────────────────────────────────────

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
  return new (svc as any)(address, getClientCredentials(), {
    interceptors: getStandardInterceptors({ serviceName }),
  });
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
  messages: Array<{ role: string; content: string; toolCallId?: string; toolCalls?: Array<{ id: string; name: string; args: string }> }>;
  model?: string;
  toolDefinitions?: Array<{ name: string; description: string; inputSchema?: Record<string, unknown> }>;
}

export async function callLLM(params: CallLLMParams): Promise<LLMResponse> {
  const ctx = Context.current();

  await waitForQuota(params.namespace, "concurrent_executions", 1);

  // Heartbeat for long LLM calls
  const heartbeatTimer = setInterval(() => {
    ctx.heartbeat("LLM request in progress");
  }, 10000);

  try {
    // Map tool definitions to proto format (snake_case). Serialize inputSchema as JSON string since proto field is string type.
    const toolDefinitionsProto = params.toolDefinitions?.map((td) => ({
      name: td.name,
      description: td.description,
      input_schema: JSON.stringify(td.inputSchema ?? {}),
    }));

    // Map messages to proto format, preserving tool_calls on assistant messages
    const messagesProto = params.messages.map((m) => ({
      role: m.role,
      content: m.content,
      tool_call_id: m.toolCallId ?? "",
      tool_calls: m.toolCalls ?? [],
    }));

    const response = (await llmGenerateCall({
      agent_id: params.agentId,
      execution_id: params.executionId,
      namespace: params.namespace,
      messages: messagesProto,
      tool_definitions: toolDefinitionsProto ?? [],
      temperature: 0.7,
      model: params.model ?? "",
    })) as {
      content: string;
      model_used: string;
      cost: string;
      tool_calls?: Array<{ id: string; name: string; args: string }>;
      usage: {
        prompt_tokens: number;
        completion_tokens: number;
        total_tokens: number;
      };
    };

    const content = response.content ?? "";
    const toolCalls = response.tool_calls;

    // Structured tool_calls from the LLM take priority over [tool:] text parsing
    const firstToolCall = toolCalls?.[0];
    if (firstToolCall) {
      let toolArgs: Record<string, unknown> = {};
      try { toolArgs = JSON.parse(firstToolCall.args); } catch { /* use empty */ }

      return {
        type: "tool_call",
        content,
        toolName: firstToolCall.name,
        toolArgs,
        toolCallId: firstToolCall.id,
        toolCalls,
        modelUsed: response.model_used ?? "unknown",
        cost: response.cost ?? "$0.00",
        usage: {
          promptTokens: response.usage?.prompt_tokens ?? 0,
          completionTokens: response.usage?.completion_tokens ?? 0,
          totalTokens: response.usage?.total_tokens ?? 0,
        },
      };
    }

    // Fall back to [tool:] text parsing for non-native tool-calling models
    const classification = classifyLLMResponse(content);

    return {
      type: classification.type,
      content,
      toolName: classification.toolName,
      toolArgs: classification.toolArgs,
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
  sandboxIp?: string;
}

export async function executeTool(params: ExecuteToolParams): Promise<ToolResult> {
  const startTime = Date.now();

  // Validate tool-call arguments before any network dispatch — fail fast
  const REQUIRED_ARGS: Record<string, string[]> = {
    code_interpreter: ["code", "script"],
    read_file: ["path"],
    write_file: ["path", "content"],
  };
  const required = REQUIRED_ARGS[params.toolName];
  if (required) {
    const missing = required.filter((k) => {
      const v = params.args?.[k];
      return v === undefined || v === null || v === "";
    });
    if (missing.length === required.length) {
      return {
        toolName: params.toolName,
        status: "failed",
        errorMessage: `Missing required arguments for ${params.toolName}: expected one of [${required.join(", ")}] but got none`,
        latencyMs: Date.now() - startTime,
      };
    }
  }

  await waitForQuota(params.namespace, "tool_calls_per_minute", 1);

  try {
    const response = (await toolCallExec({
      agent_id: params.agentId,
      execution_id: params.executionId,
      tool_name: params.toolName,
      args: params.args,
      sandbox_ip: params.sandboxIp ?? "",
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

// ─── Activity: evaluatePolicy ──────────────────────────────────────────────

interface EvaluatePolicyParams {
  agentId: string;
  executionId: string;
  namespace: string;
  action: string;
  resourceNamespace?: string;
  callerRole?: string;
}

interface PolicyDecision {
  allow: boolean;
  reason: string;
}

function postJSON(
  url: string,
  body: unknown,
  timeoutMs: number
): Promise<{ status: number; data: unknown }> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const httpModule = require("http");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const httpsModule = require("https");
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const payload = JSON.stringify(body);
    const client = urlObj.protocol === "https:" ? httpsModule : httpModule;
    const req = client.request(
      {
        hostname: urlObj.hostname,
        port: urlObj.port,
        path: urlObj.pathname + urlObj.search,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
        },
        timeout: timeoutMs,
      },
      (res: http.IncomingMessage) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString();
          const status = res.statusCode ?? 0;
          try {
            const data = JSON.parse(raw);
            resolve({ status, data });
          } catch {
            // Non-JSON response (e.g. 503 Service Unavailable)
            resolve({ status, data: { error: raw } });
          }
        });
      }
    );
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("Policy evaluation timeout"));
    });
    req.write(payload);
    req.end();
  });
}

export async function evaluatePolicy(
  params: EvaluatePolicyParams
): Promise<PolicyDecision> {
  const policyPlaneAddr =
    process.env.POLICY_PLANE_ADDR || "http://policy-plane:50059";
  const policyPath = "egaop/execution";
  const timeoutMs = parseInt(process.env.OPA_TIMEOUT_MS || "5000", 10);

  const roleToClearance: Record<string, number> = {
    platform_admin: 3,
    namespace_admin: 3,
    developer: 2,
    viewer: 1,
  };

  const subjectNamespace = params.namespace;
  const resourceNamespace = params.resourceNamespace || params.namespace;
  const clearance = roleToClearance[params.callerRole || ""] ?? 2;

  const input = {
    subject: {
      namespace: subjectNamespace,
      clearance,
    },
    action: params.action,
    resource: {
      namespace: resourceNamespace,
    },
  };

  try {
    const response = await postJSON(
      `${policyPlaneAddr}/v1/data/${policyPath}`,
      { input },
      timeoutMs
    );

    if (response.status < 200 || response.status >= 300) {
      throw new Error(`Policy-plane returned HTTP ${response.status}`);
    }

    const result = response.data as Record<string, unknown>;
    const resultObj = result["result"] as Record<string, unknown> | undefined;
    const allow = resultObj?.["allow"] === true;
    const reason = allow
      ? ""
      : (resultObj?.["reason"] as string) ?? "Policy denied";

    return { allow, reason };
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    // Fail closed: if policy-plane is unreachable, DENY
    return { allow: false, reason: `Policy evaluation failed: ${errMsg}` };
  }
}

// ─── Activity: admitAgent ─────────────────────────────────────────────────

interface AdmitAgentParams {
  agentId: string;
  namespace: string;
  spec: Record<string, unknown>;
}

export async function admitAgent(params: AdmitAgentParams): Promise<boolean> {
  const apiServerAddr =
    process.env.API_SERVER_ADDR || "localhost:50051";

  const svc = loadService("egaop/v1/agent.proto", "egaop.v1.AgentService");
  const client = new (
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    svc as any
  )(apiServerAddr, getClientCredentials());

  try {
    const response = await promisifyGRPC<unknown, unknown>(
      client,
      "CreateAgent"
    )({
      api_version: "egaop/v1",
      kind: "Agent",
      metadata: { name: params.agentId, namespace: params.namespace },
      spec: params.spec,
    });

    const agent = response as Record<string, unknown>;
    const status = agent["status"] as Record<string, unknown> | undefined;
    const phase = status?.["phase"] as string | undefined;
    return phase === "Pending" || phase === "Running";
  } catch (err: unknown) {
    const grpcErr = err as { details?: string; message?: string };
    const msg = grpcErr.details ?? grpcErr.message ?? "";
    if (msg.includes("already exists")) {
      return true;
    }
    throw new Error(`Admission failed: ${msg}`);
  }
}

// ─── Activity: createSandbox ──────────────────────────────────────────────

interface CreateSandboxParams {
  agentId: string;
  executionId: string;
  namespace: string;
  isolationLevel: string;
  initCommands?: string[];
}

interface SandboxResult {
  id: string;
  status: string;
  initOutputs?: string[];
  ipAddress?: string;
}

export async function createSandbox(
  params: CreateSandboxParams
): Promise<SandboxResult> {
  const sandboxAddr =
    process.env.SANDBOX_RUNTIME_ADDR || "localhost:50054";

  const svc = loadService("egaop/v1/runtime.proto", "egaop.v1.RuntimeService");
  const client = new (
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    svc as any
  )(sandboxAddr, getClientCredentials());

  try {
    const response = await promisifyGRPC<unknown, unknown>(
      client,
      "CreateSandbox"
    )({
      agent_id: params.agentId,
      execution_id: params.executionId,
      isolation_level: params.isolationLevel,
      resources: {},
      env_vars: {
        fields: {
          EGAOP_AGENT_ID: { stringValue: params.agentId },
          EGAOP_EXECUTION_ID: { stringValue: params.executionId },
          EGAOP_NAMESPACE: { stringValue: params.namespace },
        },
      },
      init_commands: params.initCommands ?? [],
    });

    const res = response as Record<string, unknown>;
    return {
      id: (res["sandbox_id"] as string) ?? "",
      status: (res["status"] as string) ?? "unknown",
      initOutputs: (res["init_outputs"] as string[]) ?? [],
      ipAddress: (res["ip_address"] as string) ?? undefined,
    };
  } catch (err: unknown) {
    const grpcErr = err as { details?: string; message?: string };
    throw new Error(
      `Sandbox creation failed: ${grpcErr.details ?? grpcErr.message}`
    );
  }
}

// ─── Activity: terminateSandbox ────────────────────────────────────────────

interface TerminateSandboxParams {
  sandboxId: string;
  reason: string;
}

export async function terminateSandbox(
  params: TerminateSandboxParams
): Promise<{ success: boolean }> {
  const sandboxAddr =
    process.env.SANDBOX_RUNTIME_ADDR || "localhost:50054";

  const svc = loadService("egaop/v1/runtime.proto", "egaop.v1.RuntimeService");
  const client = new (
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    svc as any
  )(sandboxAddr, getClientCredentials());

  try {
    const response = await promisifyGRPC<unknown, unknown>(
      client,
      "TerminateSandbox"
    )({
      sandbox_id: params.sandboxId,
      reason: params.reason,
    });

    const res = response as Record<string, unknown>;
    return { success: (res["success"] as boolean) ?? false };
  } catch (err: unknown) {
    const grpcErr = err as { details?: string; message?: string };
    throw new Error(
      `Sandbox termination failed: ${grpcErr.details ?? grpcErr.message}`
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
