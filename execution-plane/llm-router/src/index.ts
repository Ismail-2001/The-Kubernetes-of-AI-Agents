import { initTracing, shutdownTracing, validateSecrets, loadSecretsIntoEnv, LLM400Error, LLMAuthError, LLMRateLimitError } from "@e-gaop/shared";
import { recordLLMCost } from "@e-gaop/shared/src/metrics/cost-metrics.js";

initTracing("llm-router");
loadSecretsIntoEnv();
if (process.env.NODE_ENV !== "test") {
  validateSecrets();
}

import path from "path";
import http from "http";
import https from "https";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import pino from "pino";
import OpenAI from "openai";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions/completions";
import CircuitBreaker from "opossum";
import { countTokensForModel } from "./tokens.js";
import { detectPromptInjection, scanMessagesForInjection } from "./prompt-injection.js";
import { RateLimiter, extractNamespace, getServerCredentials, createNamespaceServerInterceptor, createServiceTokenServerInterceptor, createTraceServerInterceptor, AsyncSemaphore } from "@e-gaop/shared";

const HEALTH_SERVICE: grpc.ServiceDefinition = {
  check: {
    path: "/grpc.health.v1.Health/Check",
    requestStream: false,
    responseStream: false,
    requestSerialize: (v: unknown) => Buffer.from(JSON.stringify(v)),
    responseSerialize: (v: unknown) => Buffer.from(JSON.stringify(v)),
    requestDeserialize: (b: Buffer) => JSON.parse(b.toString()),
    responseDeserialize: (b: Buffer) => JSON.parse(b.toString()),
  },
};

const rateLimiter = new RateLimiter();

const logger = pino({
  level: process.env.NODE_ENV === "test" ? "silent" : (process.env.LOG_LEVEL || "info"),
  ...(process.env.NODE_ENV !== "production" && process.env.NODE_ENV !== "test" ? {
    transport: { target: "pino-pretty", options: { colorize: true } }
  } : {}),
});

const PROTO_PATH = path.resolve(__dirname, "../../../api/proto/egaop/v1/llm.proto");

const packageDefinition = protoLoader.loadSync(PROTO_PATH, {
  keepCase: true,
  longs: String,
  enums: String,
  defaults: true,
  oneofs: true,
  includeDirs: [path.resolve(__dirname, "../../../api/proto")]
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- proto-loader returns dynamic types with no static definitions
const egaopProto = grpc.loadPackageDefinition(packageDefinition) as any;
const llmService = egaopProto.egaop.v1.LLMService;

interface LLMMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_call_id?: string;
  name?: string;
  tool_calls?: Array<{ id: string; name: string; args: string | Record<string, unknown> }>;
}

interface AnthropicContentBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
}

interface AnthropicResponse {
  content?: AnthropicContentBlock[];
  usage?: { input_tokens: number; output_tokens: number };
}

interface OllamaToolCall {
  function?: { name?: string; arguments?: Record<string, unknown> };
  name?: string;
  arguments?: Record<string, unknown>;
}

interface OllamaResponse {
  message?: { content?: string; tool_calls?: OllamaToolCall[] };
  prompt_eval_count?: number;
  eval_count?: number;
}

interface AnthropicStreamEvent {
  type: string;
  message?: { usage?: { input_tokens: number } };
  delta?: { type?: string; text?: string; stop_reason?: string };
  usage?: { output_tokens: number };
}

interface OllamaStreamEvent {
  message?: { content?: string };
  done?: boolean;
  prompt_eval_count?: number;
  eval_count?: number;
}

// ─── Multi-Model Pricing (OpenAI, Anthropic, Ollama/local) ──────────────

const PRICING: Record<string, { input: number; output: number }> = {
  // OpenAI
  "gpt-4o": { input: 0.0025, output: 0.01 },
  "gpt-4o-mini": { input: 0.00015, output: 0.0006 },
  "gpt-3.5-turbo": { input: 0.0005, output: 0.0015 },
  // Anthropic
  "claude-3-5-sonnet-20241022": { input: 0.003, output: 0.015 },
  "claude-3-5-haiku-20241022": { input: 0.001, output: 0.005 },
  "claude-3-opus-20240229": { input: 0.015, output: 0.075 },
  // Ollama / local (free)
  "llama3-8b-8192": { input: 0, output: 0 },
  "llama3-70b-8192": { input: 0.00059, output: 0.00079 },
  "mixtral-8x7b-32768": { input: 0.00024, output: 0.00024 },
};

// ─── Provider Detection ────────────────────────────────────────────────

type ModelProvider = "openai" | "anthropic" | "ollama";

function detectProvider(model: string): ModelProvider {
  if (model.startsWith("claude-")) return "anthropic";
  // Ollama models are typically lowercase with no dots, like llama3, mistral, etc.
  if (model.startsWith("llama") || model.startsWith("mixtral") || model.startsWith("mistral") || model.startsWith("codellama") || model.startsWith("phi-") || model.startsWith("deepseek")) return "ollama";
  return "openai";
}

const FALLBACK_CHAIN = process.env.LLM_FALLBACK_CHAIN
  ? process.env.LLM_FALLBACK_CHAIN.split(",")
  : ["gpt-4o", "gpt-4o-mini", "gpt-3.5-turbo"];

// ─── HTTP keep-alive agent for connection reuse ───────────────────────────

const llmHttpAgent = new http.Agent({ keepAlive: true, maxSockets: 50 });
const llmHttpsAgent = new https.Agent({ keepAlive: true, maxSockets: 50 });

// ─── Concurrency Semaphore ─────────────────────────────────────────────────

const MAX_CONCURRENT = parseInt(process.env.LLM_MAX_CONCURRENT || "25", 10);
const concurrency = new AsyncSemaphore(MAX_CONCURRENT);

// ─── Retry with exponential backoff ────────────────────────────────────────

async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  maxRetries: number = 3,
  baseDelayMs: number = 1000
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err: unknown) {
      lastError = err;
      const errObj = err instanceof Error ? err : new Error(String(err));
      const status = (err as Record<string, unknown>)?.status;
      if (attempt < maxRetries && (err instanceof LLMRateLimitError || status === 429)) {
        const delay = baseDelayMs * Math.pow(2, attempt) + Math.random() * 500;
        logger.warn({ attempt, delay_ms: Math.round(delay), err: errObj.message }, "Rate limited, retrying with backoff");
        await new Promise((r) => setTimeout(r, delay));
      } else {
        throw err;
      }
    }
  }
  throw lastError;
}

// ─── Circuit Breakers (per-provider) ────────────────────────────────────────

const circuitBreakerOptions: CircuitBreaker.Options = {
  timeout: parseInt(process.env.LLM_CIRCUIT_BREAKER_TIMEOUT_MS || "30000", 10),
  errorThresholdPercentage: parseInt(process.env.LLM_CIRCUIT_BREAKER_THRESHOLD || "50", 10),
  resetTimeout: parseInt(process.env.LLM_CIRCUIT_BREAKER_RESET_MS || "30000", 10),
  rollingCountTimeout: 10000,
  rollingCountBuckets: 10,
  volumeThreshold: parseInt(process.env.LLM_CIRCUIT_BREAKER_VOLUME || "20", 10),
};

const DEFAULT_LLM_TIMEOUT_MS = parseInt(process.env.LLM_TIMEOUT_MS || "30000", 10);

type ProviderState = "closed" | "open" | "half_open";
const providerStates: Record<ModelProvider, ProviderState> = {
  openai: "closed",
  anthropic: "closed",
  ollama: "closed",
};

function overallCircuitState(): ProviderState {
  const states = Object.values(providerStates);
  if (states.every((s) => s === "open")) return "open";
  if (states.some((s) => s !== "closed")) return "half_open";
  return "closed";
}

function createProviderBreaker(provider: ModelProvider, fn: (...args: unknown[]) => Promise<unknown>): CircuitBreaker {
  const breaker = new CircuitBreaker(fn, circuitBreakerOptions);
  breaker.on("open", () => {
    providerStates[provider] = "open";
    logger.warn({ provider }, `LLM circuit breaker OPEN for ${provider} — requests fast-failed`);
  });
  breaker.on("halfOpen", () => {
    providerStates[provider] = "half_open";
    logger.info({ provider }, `LLM circuit breaker HALF_OPEN for ${provider}`);
  });
  breaker.on("close", () => {
    providerStates[provider] = "closed";
    logger.info({ provider }, `LLM circuit breaker CLOSED for ${provider}`);
  });
  return breaker;
}

interface CompletionUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

// A single token delta emitted by a streaming provider. `content` is empty on the
// final chunk, which carries the aggregate `usage` and `finishReason`.
interface StreamChunk {
  content: string;
  model: string;
  usage?: CompletionUsage;
  finishReason?: string;
}

// ─── OpenAI Client ────────────────────────────────────────────────────────

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_BASE_URL = process.env.OPENAI_BASE_URL || "https://api.openai.com/v1";

let openai: OpenAI | null = null;
if (OPENAI_API_KEY) {
  openai = new OpenAI({
    apiKey: OPENAI_API_KEY,
    baseURL: OPENAI_BASE_URL,
    timeout: parseInt(process.env.LLM_TIMEOUT_MS || "30000", 10),
    maxRetries: parseInt(process.env.LLM_MAX_RETRIES || "5", 10),
    httpAgent: OPENAI_BASE_URL.startsWith("https") ? llmHttpsAgent : llmHttpAgent,
  });
}

const MODEL_TO_OPENAI = {
  "gpt-4o": process.env.OPENAI_BASE_URL?.includes("openrouter") ? "openai/gpt-4o" : "gpt-4o",
  "gpt-4o-mini": process.env.OPENAI_BASE_URL?.includes("openrouter") ? "openai/gpt-4o-mini" : "gpt-4o-mini",
  "gpt-3.5-turbo": process.env.OPENAI_BASE_URL?.includes("openrouter") ? "openai/gpt-3.5-turbo" : "gpt-3.5-turbo",
  "claude-3-5-sonnet-20241022": "claude-3-5-sonnet-20241022",
  "claude-3-5-haiku-20241022": "claude-3-5-haiku-20241022",
  "claude-3-opus-20240229": "claude-3-opus-20240229",
  "llama3-8b-8192": "llama3-8b-8192",
  "llama3-70b-8192": "llama3-70b-8192",
  "mixtral-8x7b-32768": "mixtral-8x7b-32768",
} as Record<string, string>;

// ─── Anthropic Client ─────────────────────────────────────────────────────

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const ANTHROPIC_BASE_URL = process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com";

// ─── Ollama Client ─────────────────────────────────────────────────────────

const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || "http://localhost:11434";

function countTokens(text: string): number {
  return countTokensForModel(text);
}

function calculateCost(promptTokens: number, completionTokens: number, model: string): string {
  const pricing = PRICING[model] ?? { input: 0.0025, output: 0.01 };
  const safePrompt = Number.isFinite(promptTokens) && promptTokens > 0 ? promptTokens : 0;
  const safeCompletion = Number.isFinite(completionTokens) && completionTokens > 0 ? completionTokens : 0;
  const cost = ((safePrompt / 1000) * pricing.input + (safeCompletion / 1000) * pricing.output).toFixed(6);
  return `$${cost}`;
}

interface ToolDef {
  name: string;
  description: string;
  input_schema?: Record<string, unknown>;
}

interface ToolCallResult {
  id: string;
  name: string;
  arguments: string;
}

// ─── Anthropic API Call ────────────────────────────────────────────────────

async function callAnthropic(
  messages: LLMMessage[],
  model: string,
  temperature: number,
  maxTokens: number | undefined,
  toolDefinitions: ToolDef[] | undefined,
  signal?: AbortSignal,
): Promise<{ content: string | null; toolCalls: ToolCallResult[]; model: string; usage: CompletionUsage }> {
  if (!ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY not configured");
  }

  // Anthropic uses a separate system message
  const systemMsg = messages.find((m) => m.role === "system");
  const nonSystemMsgs = messages.filter((m) => m.role !== "system");

  const body: Record<string, unknown> = {
    model,
    max_tokens: Math.min(maxTokens || 4096, 16384),
    messages: nonSystemMsgs.map((m) => ({ role: m.role, content: m.content })),
  };
  if (systemMsg) body.system = systemMsg.content;
  if (temperature !== undefined) body.temperature = temperature;

  if (toolDefinitions?.length) {
    body.tools = toolDefinitions.map((td) => ({
      name: td.name,
      description: td.description,
      input_schema: td.input_schema || { type: "object", properties: {} },
    }));
  }

  const response = await fetch(`${ANTHROPIC_BASE_URL}/v1/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(body),
    signal: signal ?? AbortSignal.timeout(DEFAULT_LLM_TIMEOUT_MS),
  });

  if (!response.ok) {
    const errBody = await response.text();
    const err = Object.assign(new Error(`Anthropic API error ${response.status}: ${errBody}`), { status: response.status });
    throw err;
  }

  const data = await response.json() as AnthropicResponse;
  const content = data.content?.find((c) => c.type === "text")?.text ?? null;
  const toolUseBlocks = data.content?.filter((c) => c.type === "tool_use") ?? [];

  const toolCalls: ToolCallResult[] = toolUseBlocks.map((tc) => ({
    id: tc.id ?? "",
    name: tc.name ?? "",
    arguments: JSON.stringify(tc.input),
  }));

  return {
    content,
    toolCalls,
    model,
    usage: {
      prompt_tokens: data.usage?.input_tokens ?? 0,
      completion_tokens: data.usage?.output_tokens ?? 0,
      total_tokens: (data.usage?.input_tokens ?? 0) + (data.usage?.output_tokens ?? 0),
    },
  };
}

// ─── Ollama API Call ───────────────────────────────────────────────────────

async function callOllama(
  messages: LLMMessage[],
  model: string,
  temperature: number,
  maxTokens: number | undefined,
  toolDefinitions: ToolDef[] | undefined,
  signal?: AbortSignal,
): Promise<{ content: string | null; toolCalls: ToolCallResult[]; model: string; usage: CompletionUsage }> {
  const body: Record<string, unknown> = {
    model,
    messages: messages.map((m) => ({ role: m.role, content: m.content })),
    stream: false,
    options: {
      temperature,
      num_predict: Math.min(maxTokens || 4096, 16384),
    },
  };

  if (toolDefinitions?.length) {
    body.tools = toolDefinitions.map((td) => ({
      type: "function",
      function: {
        name: td.name,
        description: td.description,
        parameters: td.input_schema || { type: "object", properties: {} },
      },
    }));
  }

  const response = await fetch(`${OLLAMA_BASE_URL}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: signal ?? AbortSignal.timeout(DEFAULT_LLM_TIMEOUT_MS),
  });

  if (!response.ok) {
    const errBody = await response.text();
    const err = Object.assign(new Error(`Ollama API error ${response.status}: ${errBody}`), { status: response.status });
    throw err;
  }

  const data = await response.json() as OllamaResponse;
  const msg = data.message;
  const toolCalls: ToolCallResult[] = (msg?.tool_calls ?? []).map((tc) => ({
    id: `ollama-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name: tc.function?.name ?? tc.name ?? "unknown",
    arguments: JSON.stringify(tc.function?.arguments ?? tc.arguments ?? {}),
  }));

  return {
    content: msg?.content ?? null,
    toolCalls,
    model,
    usage: {
      prompt_tokens: data.prompt_eval_count ?? 0,
      completion_tokens: data.eval_count ?? 0,
      total_tokens: (data.prompt_eval_count ?? 0) + (data.eval_count ?? 0),
    },
  };
}

// ─── Streaming Providers ───────────────────────────────────────────────────

// Lazily parse a response body's line-delimited SSE/NDJSON payloads.
async function* streamLines(body: ReadableStream | null): AsyncGenerator<string> {
  if (!body) return;
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx = buffer.indexOf("\n");
      while (idx >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (line) yield line;
        idx = buffer.indexOf("\n");
      }
    }
    const remainder = buffer.trim();
    if (remainder) yield remainder;
  } finally {
    reader.releaseLock();
  }
}

async function* streamOpenAIProvider(
  openaiMessages: ChatCompletionMessageParam[],
  model: string,
  temperature: number,
  maxTokens: number | undefined,
  signal?: AbortSignal,
): AsyncGenerator<StreamChunk> {
  if (!openai) {
    throw new Error("OpenAI client not configured");
  }
  const openaiModel = MODEL_TO_OPENAI[model] ?? model;
  const stream = await openai.chat.completions.create(
    {
      model: openaiModel,
      messages: openaiMessages,
      temperature,
      max_tokens: Math.min((maxTokens || 4096), 16384),
      stream: true,
      stream_options: { include_usage: true },
    },
    { signal }
  );

  for await (const chunk of stream) {
    const delta = chunk.choices?.[0]?.delta?.content;
    if (delta) {
      yield { content: delta, model };
    }
    if (chunk.usage) {
      yield {
        content: "",
        model,
        usage: {
          prompt_tokens: chunk.usage.prompt_tokens ?? 0,
          completion_tokens: chunk.usage.completion_tokens ?? 0,
          total_tokens: chunk.usage.total_tokens ?? 0,
        },
        finishReason: chunk.choices?.[0]?.finish_reason ?? "stop",
      };
    }
  }
}

async function* streamAnthropic(
  messages: LLMMessage[],
  model: string,
  temperature: number,
  maxTokens: number | undefined,
  signal?: AbortSignal,
): AsyncGenerator<StreamChunk> {
  const apiKey = ANTHROPIC_API_KEY ?? process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error("ANTHROPIC_API_KEY not configured");
  }

  const systemMsg = messages.find((m) => m.role === "system");
  const nonSystemMsgs = messages.filter((m) => m.role !== "system");

  const body: Record<string, unknown> = {
    model,
    max_tokens: Math.min(maxTokens || 4096, 16384),
    messages: nonSystemMsgs.map((m) => ({ role: m.role, content: m.content })),
    stream: true,
  };
  if (systemMsg) body.system = systemMsg.content;
  if (temperature !== undefined) body.temperature = temperature;

  const response = await fetch(`${ANTHROPIC_BASE_URL}/v1/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(body),
    signal: signal ?? AbortSignal.timeout(DEFAULT_LLM_TIMEOUT_MS),
  });

  if (!response.ok) {
    const errBody = await response.text();
    const err = Object.assign(new Error(`Anthropic API error ${response.status}: ${errBody}`), { status: response.status });
    throw err;
  }

  let promptTokens = 0;
  let completionTokens = 0;
  for await (const line of streamLines(response.body)) {
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    try {
      const evt = JSON.parse(payload) as AnthropicStreamEvent;
      if (evt.type === "message_start") {
        promptTokens = evt.message?.usage?.input_tokens ?? 0;
      } else if (evt.type === "content_block_delta" && evt.delta?.type === "text_delta") {
        yield { content: evt.delta.text ?? "", model };
      } else if (evt.type === "message_delta") {
        completionTokens = evt.usage?.output_tokens ?? 0;
        yield {
          content: "",
          model,
          usage: {
            prompt_tokens: promptTokens,
            completion_tokens: completionTokens,
            total_tokens: promptTokens + completionTokens,
          },
          finishReason: evt.delta?.stop_reason ?? "stop",
        };
      }
    } catch {
      // Ignore malformed SSE frames
    }
  }
}

async function* streamOllama(
  messages: LLMMessage[],
  model: string,
  temperature: number,
  maxTokens: number | undefined,
  signal?: AbortSignal,
): AsyncGenerator<StreamChunk> {
  const body: Record<string, unknown> = {
    model,
    messages: messages.map((m) => ({ role: m.role, content: m.content })),
    stream: true,
    options: {
      temperature,
      num_predict: Math.min(maxTokens || 4096, 16384),
    },
  };

  const response = await fetch(`${OLLAMA_BASE_URL}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: signal ?? AbortSignal.timeout(DEFAULT_LLM_TIMEOUT_MS),
  });

  if (!response.ok) {
    const errBody = await response.text();
    const err = Object.assign(new Error(`Ollama API error ${response.status}: ${errBody}`), { status: response.status });
    throw err;
  }

  for await (const line of streamLines(response.body)) {
    if (!line) continue;
    try {
      const evt = JSON.parse(line) as OllamaStreamEvent;
      if (evt.message?.content) {
        yield { content: evt.message.content, model };
      }
      if (evt.done) {
        yield {
          content: "",
          model,
          usage: {
            prompt_tokens: evt.prompt_eval_count ?? 0,
            completion_tokens: evt.eval_count ?? 0,
            total_tokens: (evt.prompt_eval_count ?? 0) + (evt.eval_count ?? 0),
          },
          finishReason: "stop",
        };
      }
    } catch {
      // Ignore malformed NDJSON frames
    }
  }
}

// ─── Unified Multi-Model Fallback ─────────────────────────────────────────

async function callOpenAIProvider(
  openaiMessages: ChatCompletionMessageParam[],
  model: string,
  temperature: number,
  maxTokens: number | undefined,
  toolDefinitions: ToolDef[] | undefined,
  signal?: AbortSignal
): Promise<{ content: string | null; toolCalls: ToolCallResult[]; model: string; usage: CompletionUsage }> {
  if (!openai) {
    throw new Error("OpenAI client not configured");
  }
  const openaiModel = MODEL_TO_OPENAI[model] ?? model;
  return retryWithBackoff(async () => {
    const openaiTools = toolDefinitions?.map((td) => ({
      type: "function" as const,
      function: {
        name: td.name,
        description: td.description,
        parameters: (() => {
          if (typeof td.input_schema === "string") {
            try { return JSON.parse(td.input_schema); } catch { return { type: "object", properties: {} }; }
          }
          return td.input_schema || { type: "object", properties: {} };
        })(),
      },
    }));

    const response = await openai.chat.completions.create(
      {
        model: openaiModel,
        messages: openaiMessages,
        tools: openaiTools?.length ? openaiTools : undefined,
        temperature,
        max_tokens: Math.min((maxTokens || 4096), 16384),
      },
      { signal }
    );

    const choice = response.choices[0];
    if (!choice) {
      throw new LLM400Error("Empty response from model", { statusCode: 0, model });
    }

    const msg = choice.message;
    const toolCalls: ToolCallResult[] = (msg.tool_calls || []).map((tc) => ({
      id: tc.id,
      name: tc.function.name,
      arguments: tc.function.arguments,
    }));

    return {
      content: msg.content,
      toolCalls,
      model,
      usage: response.usage ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    };
  }, 3, 1000);
}

const openaiBreaker = createProviderBreaker("openai", callOpenAIProvider as (...args: unknown[]) => Promise<unknown>);
const anthropicBreaker = createProviderBreaker("anthropic", async (...args: unknown[]) =>
  retryWithBackoff(() => callAnthropic(args[0] as LLMMessage[], args[1] as string, args[2] as number, args[3] as number | undefined, args[4] as ToolDef[] | undefined, args[5] as AbortSignal | undefined), 3, 1000)
);
const ollamaBreaker = createProviderBreaker("ollama", async (...args: unknown[]) =>
  retryWithBackoff(() => callOllama(args[0] as LLMMessage[], args[1] as string, args[2] as number, args[3] as number | undefined, args[4] as ToolDef[] | undefined, args[5] as AbortSignal | undefined), 2, 1000)
);

async function callLLMWithFallback(
  openaiMessages: ChatCompletionMessageParam[],
  preferredModel: string,
  temperature: number,
  maxTokens: number | undefined,
  toolDefinitions: ToolDef[] | undefined,
  signal?: AbortSignal
): Promise<{ content: string | null; toolCalls: ToolCallResult[]; model: string; usage: CompletionUsage }> {
  const models = [preferredModel, ...FALLBACK_CHAIN.filter((m) => m !== preferredModel)];
  const llmMessages = openaiMessages as unknown as LLMMessage[];

  for (const model of models) {
    const provider = detectProvider(model);

    try {
      if (provider === "anthropic") {
        return await anthropicBreaker.fire(llmMessages, model, temperature, maxTokens, toolDefinitions, signal) as { content: string | null; toolCalls: ToolCallResult[]; model: string; usage: CompletionUsage };
      }

      if (provider === "ollama") {
        return await ollamaBreaker.fire(llmMessages, model, temperature, maxTokens, toolDefinitions, signal) as { content: string | null; toolCalls: ToolCallResult[]; model: string; usage: CompletionUsage };
      }

      // Default: OpenAI-compatible API
      if (!openai) {
        logger.warn({ model }, "OpenAI client not configured, skipping");
        continue;
      }

      return await openaiBreaker.fire(openaiMessages, model, temperature, maxTokens, toolDefinitions, signal) as { content: string | null; toolCalls: ToolCallResult[]; model: string; usage: CompletionUsage };
    } catch (err: unknown) {
      const errObj = err instanceof Error ? err : new Error(String(err));
      const errRecord = err as Record<string, unknown>;
      const status = (errRecord?.status ?? errRecord?.statusCode ?? 0) as number;

      if (errRecord?.name === "CircuitBreakerOpenError" || errRecord?.name === "BulkheadOverloadError") {
        logger.warn({ model, provider, err: errObj.message }, "Circuit breaker open, trying fallback model");
        continue;
      }

      if (status === 400 || status === 422) {
        throw new LLM400Error(`LLM bad request: ${errObj.message}`, { statusCode: status, model });
      }
      if (status === 401 || status === 403) {
        throw new LLMAuthError(`LLM auth failed: ${errObj.message}`, { model });
      }
      if (status === 429 || err instanceof LLMRateLimitError) {
        logger.warn({ model, err: errObj.message }, "Rate limit retries exhausted, trying fallback model");
        continue;
      }

      logger.warn({
        model,
        provider,
        err: errObj.message,
        status,
        errorBody: errRecord?.error ? JSON.stringify(errRecord.error).slice(0, 3000) : undefined,
        stack: errObj.stack?.slice(0, 300),
      }, "Model call failed, trying fallback");
    }
  }

  throw new Error("All models in fallback chain exhausted");
}

async function* streamLLMWithFallback(
  openaiMessages: ChatCompletionMessageParam[],
  preferredModel: string,
  temperature: number,
  maxTokens: number | undefined,
  signal?: AbortSignal,
): AsyncGenerator<StreamChunk> {
  const models = [preferredModel, ...FALLBACK_CHAIN.filter((m) => m !== preferredModel)];
  const llmMessages = openaiMessages as unknown as LLMMessage[];
  let lastErr: Error | undefined;

  for (const model of models) {
    const provider = detectProvider(model);

    try {
      if (provider === "anthropic") {
        for await (const chunk of streamAnthropic(llmMessages, model, temperature, maxTokens, signal)) {
          yield chunk;
        }
        return;
      }

      if (provider === "ollama") {
        for await (const chunk of streamOllama(llmMessages, model, temperature, maxTokens, signal)) {
          yield chunk;
        }
        return;
      }

      // Default: OpenAI-compatible API
      if (!openai) {
        logger.warn({ model }, "OpenAI client not configured, skipping");
        continue;
      }

      for await (const chunk of streamOpenAIProvider(openaiMessages, model, temperature, maxTokens, signal)) {
        yield chunk;
      }
      return;
    } catch (err: unknown) {
      lastErr = err instanceof Error ? err : new Error(String(err));
      const errRecord = err as Record<string, unknown>;
      const status = (errRecord?.status ?? errRecord?.statusCode ?? 0) as number;
      if (status === 400 || status === 422) {
        throw new LLM400Error(`LLM bad request: ${lastErr.message}`, { statusCode: status, model });
      }
      if (status === 401 || status === 403) {
        throw new LLMAuthError(`LLM auth failed: ${lastErr.message}`, { model });
      }
      logger.warn({ model, provider, err: lastErr.message }, "Streaming provider failed, trying fallback model");
    }
  }

  throw lastErr ?? new Error("All models in fallback chain exhausted");
}

const server = new grpc.Server({
  interceptors: [createNamespaceServerInterceptor(), createServiceTokenServerInterceptor(), createTraceServerInterceptor()],
});

server.addService(llmService.service, {
  Generate: async (call: grpc.ServerUnaryCall<Record<string, unknown>, Record<string, unknown>>, callback: grpc.sendUnaryData<Record<string, unknown>>) => {
    const req = call.request;
    const agent_id = req.agent_id as string;
    const execution_id = req.execution_id as string;
    const preferredModel = req.model as string;
    const messages = (req.messages ?? []) as Array<Record<string, unknown>>;
    const temperature = req.temperature as number | undefined;
    const max_tokens = req.max_tokens as number | undefined;
    const tool_definitions = req.tool_definitions as ToolDef[] | undefined;
    const startTime = Date.now();

    logger.info({ agent_id, execution_id, preferredModel }, "Processing LLM generation request...");

    if (!OPENAI_API_KEY) {
      return callback({
        code: grpc.status.FAILED_PRECONDITION,
        message: "OPENAI_API_KEY not configured. Set environment variable before routing LLM calls.",
      });
    }

    const rateKey = `${extractNamespace(agent_id)}:${agent_id}`;
    const { allowed, retryAfterMs } = rateLimiter.check(rateKey);
    if (!allowed) {
      logger.warn({ agent_id, execution_id, retryAfterMs, rateKey }, "LLM rate limit hit");
      return callback({
        code: grpc.status.RESOURCE_EXHAUSTED,
        message: `Rate limit exceeded. Retry after ${Math.ceil(retryAfterMs / 1000)}s.`,
      });
    }

    // Acquire concurrency slot — limits simultaneous calls to upstream API
    let acquired = false;
    try {
      const slotAcquired = await concurrency.acquire(25000);
      if (!slotAcquired) {
        logger.warn({ agent_id, execution_id }, "Concurrency slot timeout — all slots busy");
        return callback({
          code: grpc.status.DEADLINE_EXCEEDED,
          message: "Too many concurrent LLM requests, please retry later",
        });
      }
      acquired = true;

      // Prompt injection scan — reject critical/high payloads before hitting upstream providers
      const injectionScan = scanMessagesForInjection(messages);
      if (injectionScan.detected) {
        const worst = injectionScan.worst;
        const reject = worst.severity === "critical" || worst.severity === "high";
        const scanResult = {
          detected: true,
          severity: worst.severity,
          confidence: worst.confidence,
          indicators: worst.indicators,
          violations: injectionScan.violations.length,
        };
        if (reject) {
          logger.warn({ agent_id, execution_id, scanResult }, "Prompt injection detected — request blocked");
          throw Object.assign(new Error("PROMPT_INJECTION_DETECTED"), {
            grpcStatus: grpc.status.INVALID_ARGUMENT,
            scanResult,
          });
        }
        logger.warn({ agent_id, execution_id, scanResult }, "Prompt injection indicators found — proceeding with low risk");
      }

      // Map messages to OpenAI format, preserving tool_calls on assistant messages
      const openaiMessages: ChatCompletionMessageParam[] = messages.map((m) => {
        const role = (m.role as string) ?? "user";
        const content = (m.content as string) ?? "";
        const result: Record<string, unknown> = { role, content };
        if (m.tool_call_id) {
          result.tool_call_id = m.tool_call_id as string;
        }
        if (m.name) {
          result.name = m.name as string;
        }
        // Restore structured tool_calls on assistant messages
        if (m.tool_calls && (m.tool_calls as unknown[]).length > 0) {
          result.tool_calls = (m.tool_calls as Array<Record<string, unknown>>).map((tc) => ({
            id: tc.id as string,
            type: "function",
            function: {
              name: tc.name as string,
              arguments: typeof tc.args === "string" ? tc.args : JSON.stringify(tc.args || {}),
            },
          }));
        }
        return result as unknown as ChatCompletionMessageParam;
      });

      const timeoutMs = parseInt(process.env.LLM_TIMEOUT_MS || "30000", 10);
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(), timeoutMs);

      const result = await callLLMWithFallback(
        openaiMessages,
        preferredModel || "gpt-4o",
        temperature ?? 0.7,
        max_tokens ?? undefined,
        tool_definitions ?? undefined,
        abort.signal
      ) as { content: string | null; toolCalls: ToolCallResult[]; model: string; usage: CompletionUsage };
      clearTimeout(timer);

      const usage = result.usage;
      const cost = calculateCost(usage.prompt_tokens, usage.completion_tokens, result.model);
      const latency = Date.now() - startTime;

      recordLLMCost({
        model: result.model,
        namespace: extractNamespace(agent_id),
        agentId: agent_id,
        promptTokens: usage.prompt_tokens,
        completionTokens: usage.completion_tokens,
        costUsd: parseFloat(cost.replace("$", "")),
      });

      logger.info({
        agent_id,
        model: result.model,
        promptTokens: usage.prompt_tokens,
        completionTokens: usage.completion_tokens,
        cost,
        latency_ms: latency,
      }, "Generation completed successfully.");

      // Build structured tool_calls for the gRPC response
      const responseToolCalls = result.toolCalls.map((tc) => ({
        id: tc.id,
        name: tc.name,
        args: tc.arguments, // JSON string, parsed on client side
      }));

      callback(null, {
        content: result.content ?? "",
        model_used: result.model,
        tool_calls: responseToolCalls,
        usage: {
          prompt_tokens: usage.prompt_tokens,
          completion_tokens: usage.completion_tokens,
          total_tokens: usage.total_tokens,
        },
        cost,
        finish_reason: responseToolCalls.length > 0 ? "tool_calls" : "stop",
        timestamp: { seconds: Math.floor(Date.now() / 1000) },
      });
    } catch (err: unknown) {
      const errObj = err instanceof Error ? err : new Error(String(err));
      const errRecord = err as Record<string, unknown>;
      logger.error({
        agent_id,
        execution_id,
        err: errObj.message,
        status: errRecord?.status,
        body: errRecord?.body ? JSON.stringify(errRecord.body).slice(0, 2000) : undefined,
      }, "LLM generation failed");

      const code = errRecord?.grpcStatus
        ? errRecord.grpcStatus
        : errObj.name === "AbortError"
          ? grpc.status.DEADLINE_EXCEEDED
          : grpc.status.INTERNAL;

      callback({
        code: code as grpc.ServiceError["code"],
        message: errRecord?.grpcStatus ? errObj.message : "LLM generation failed",
        details: errRecord?.scanResult ? JSON.stringify(errRecord.scanResult) : undefined,
      });
    } finally {
      if (acquired) concurrency.release();
    }
  },

  GenerateStream: async (call: grpc.ServerWritableStream<Record<string, unknown>, Record<string, unknown>>) => {
    const req = call.request;
    const agent_id = req.agent_id as string;
    const execution_id = req.execution_id as string;
    const preferredModel = req.model as string;
    const messages = (req.messages ?? []) as Array<Record<string, unknown>>;
    const temperature = req.temperature as number | undefined;
    const max_tokens = req.max_tokens as number | undefined;
    const startTime = Date.now();

    logger.info({ agent_id, execution_id, preferredModel }, "Processing streaming LLM request...");

    if (!OPENAI_API_KEY) {
      call.emit("error", {
        code: grpc.status.FAILED_PRECONDITION,
        message: "OPENAI_API_KEY not configured. Set environment variable before routing LLM calls.",
      });
      return;
    }

    const rateKey = `${extractNamespace(agent_id)}:${agent_id}`;
    const { allowed, retryAfterMs } = rateLimiter.check(rateKey);
    if (!allowed) {
      logger.warn({ agent_id, execution_id, retryAfterMs, rateKey }, "LLM rate limit hit");
      call.emit("error", {
        code: grpc.status.RESOURCE_EXHAUSTED,
        message: `Rate limit exceeded. Retry after ${Math.ceil(retryAfterMs / 1000)}s.`,
      });
      return;
    }

    let acquired = false;
    try {
      const slotAcquired = await concurrency.acquire(25000);
      if (!slotAcquired) {
        logger.warn({ agent_id, execution_id }, "Concurrency slot timeout — all slots busy");
        call.emit("error", {
          code: grpc.status.DEADLINE_EXCEEDED,
          message: "Too many concurrent LLM requests, please retry later",
        });
        return;
      }
      acquired = true;

      // Prompt injection scan — reject critical/high payloads before streaming to upstream
      const injectionScan = scanMessagesForInjection(messages);
      if (injectionScan.detected) {
        const worst = injectionScan.worst;
        const reject = worst.severity === "critical" || worst.severity === "high";
        const scanResult = {
          detected: true,
          severity: worst.severity,
          confidence: worst.confidence,
          indicators: worst.indicators,
          violations: injectionScan.violations.length,
        };
        if (reject) {
          logger.warn({ agent_id, execution_id, scanResult }, "Prompt injection detected — stream blocked");
          call.emit("error", {
            code: grpc.status.INVALID_ARGUMENT,
            message: "PROMPT_INJECTION_DETECTED",
            details: JSON.stringify(scanResult),
          });
          return;
        }
        logger.warn({ agent_id, execution_id, scanResult }, "Prompt injection indicators found — proceeding with low risk");
      }

      // Map messages to OpenAI format, preserving tool_calls on assistant messages
      const openaiMessages: ChatCompletionMessageParam[] = messages.map((m) => {
        const role = (m.role as string) ?? "user";
        const content = (m.content as string) ?? "";
        const result: Record<string, unknown> = { role, content };
        if (m.tool_call_id) {
          result.tool_call_id = m.tool_call_id as string;
        }
        if (m.name) {
          result.name = m.name as string;
        }
        if (m.tool_calls && (m.tool_calls as unknown[]).length > 0) {
          result.tool_calls = (m.tool_calls as Array<Record<string, unknown>>).map((tc) => ({
            id: tc.id as string,
            type: "function",
            function: {
              name: tc.name as string,
              arguments: typeof tc.args === "string" ? tc.args : JSON.stringify(tc.args || {}),
            },
          }));
        }
        return result as unknown as ChatCompletionMessageParam;
      });

      const timeoutMs = parseInt(process.env.LLM_TIMEOUT_MS || "30000", 10);
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(), timeoutMs);

      try {
        let finalUsage: CompletionUsage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
        let finalModel = preferredModel || "gpt-4o";
        let finishReason = "stop";

        const stream = streamLLMWithFallback(
          openaiMessages,
          finalModel,
          temperature ?? 0.7,
          max_tokens ?? undefined,
          abort.signal
        );

        for await (const chunk of stream) {
          if (chunk.content) {
            call.write({ content: chunk.content, done: false, model_used: chunk.model });
          }
          if (chunk.usage) {
            finalUsage = chunk.usage;
            finishReason = chunk.finishReason ?? "stop";
          }
          finalModel = chunk.model;
        }
        clearTimeout(timer);

        const cost = calculateCost(finalUsage.prompt_tokens, finalUsage.completion_tokens, finalModel);

        recordLLMCost({
          model: finalModel,
          namespace: extractNamespace(agent_id),
          agentId: agent_id,
          promptTokens: finalUsage.prompt_tokens,
          completionTokens: finalUsage.completion_tokens,
          costUsd: parseFloat(cost.replace("$", "")),
        });

        logger.info({
          agent_id,
          model: finalModel,
          promptTokens: finalUsage.prompt_tokens,
          completionTokens: finalUsage.completion_tokens,
          cost,
          latency_ms: Date.now() - startTime,
        }, "Streaming generation completed successfully.");

        call.write({
          content: "",
          done: true,
          model_used: finalModel,
          usage: finalUsage,
          cost,
          finish_reason: finishReason,
        });
        call.end();
      } catch (err: unknown) {
        clearTimeout(timer);
        const errObj = err instanceof Error ? err : new Error(String(err));
        logger.error({
          agent_id,
          execution_id,
          err: errObj.message,
          status: (err as Record<string, unknown>)?.status,
        }, "LLM streaming failed");

        call.emit("error", {
          code: errObj.name === "AbortError" ? grpc.status.DEADLINE_EXCEEDED : grpc.status.INTERNAL,
          message: "LLM streaming failed",
        });
      }
    } catch (err: unknown) {
      const errObj = err instanceof Error ? err : new Error(String(err));
      logger.error({ agent_id, execution_id, err: errObj.message }, "LLM streaming setup failed");
      call.emit("error", {
        code: grpc.status.INTERNAL,
        message: "LLM streaming failed",
      });
    } finally {
      if (acquired) concurrency.release();
    }
  },
});

server.addService(HEALTH_SERVICE, {
  check: (_call: grpc.ServerUnaryCall<Record<string, unknown>, Record<string, unknown>>, callback: grpc.sendUnaryData<Record<string, unknown>>) => {
    const healthy = overallCircuitState() !== "open" && (!!openai || !!ANTHROPIC_API_KEY || true); // Ollama is always available
    callback(null, { status: healthy ? "SERVING" : "NOT_SERVING" });
  }
});

if (process.env.NODE_ENV !== "test") {
  const ROUTER_PORT = process.env.LLM_ROUTER_PORT || "50053";
  const HEALTH_PORT = parseInt(process.env.LLM_ROUTER_HEALTH_PORT || "15053", 10);

  server.bindAsync(`0.0.0.0:${ROUTER_PORT}`, getServerCredentials(), (err, port) => {
    if (err) {
      logger.error(err, "Failed to bind LLM Router");
      return;
    }
    server.start();
    logger.info(`E-GAOP LLM Router listening on port ${port}`);
  });

  const healthServer = http.createServer((req, res) => {
    if (req.url === "/healthz" || req.url === "/readyz") {
      const healthy = overallCircuitState() !== "open";
      const code = healthy ? 200 : 503;
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        status: healthy ? "SERVING" : "NOT_SERVING",
        service: "llm-router",
        circuit_breaker: overallCircuitState(),
        providers: {
          openai: !!openai,
          anthropic: !!ANTHROPIC_API_KEY,
          ollama: true, // Always available locally
        },
      }));
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  healthServer.listen(HEALTH_PORT, "0.0.0.0", () => {
    logger.info(`Health endpoint listening on port ${HEALTH_PORT}`);
  });

  const shutdown = async () => {
    logger.info("Shutting down LLM Router...");
    rateLimiter.dispose();
    server.tryShutdown(async () => {
      healthServer.close();
      await shutdownTracing();
      logger.info("LLM Router shut down");
      process.exit(0);
    });
    setTimeout(() => { logger.error("Forced shutdown"); process.exit(1); }, 5000).unref();
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

export { server, PRICING, countTokens, countTokensForModel, calculateCost, RateLimiter, rateLimiter, detectProvider, detectPromptInjection, scanMessagesForInjection, streamOpenAIProvider, streamAnthropic, streamOllama, streamLLMWithFallback, ANTHROPIC_API_KEY, OLLAMA_BASE_URL };
