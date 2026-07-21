import { initTracing, shutdownTracing, validateSecrets, loadSecretsIntoEnv, LLM400Error, LLMAuthError, LLMRateLimitError } from "@e-gaop/shared";

initTracing("llm-router");
loadSecretsIntoEnv();
if (process.env.NODE_ENV !== "test") {
  validateSecrets();
}

import path from "path";
import http from "http";
import fs from "fs";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import pino from "pino";
import { get_encoding } from "tiktoken";
import OpenAI from "openai";
import CircuitBreaker from "opossum";
import { RateLimiter, extractNamespace, getServerCredentials, createNamespaceServerInterceptor, createServiceTokenServerInterceptor } from "@e-gaop/shared";

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

const egaopProto = grpc.loadPackageDefinition(packageDefinition) as any;
const llmService = egaopProto.egaop.v1.LLMService;

const PRICING: Record<string, { input: number; output: number }> = {
  "gpt-4o": { input: 0.0025, output: 0.01 },
  "gpt-4o-mini": { input: 0.00015, output: 0.0006 },
  "claude-3-5-sonnet": { input: 0.003, output: 0.015 },
  "gpt-3.5-turbo": { input: 0.0005, output: 0.0015 },
  "llama3-8b-8192": { input: 0, output: 0 },
  "llama3-70b-8192": { input: 0.00059, output: 0.00079 },
  "mixtral-8x7b-32768": { input: 0.00024, output: 0.00024 },
};

const FALLBACK_CHAIN = process.env.LLM_FALLBACK_CHAIN
  ? process.env.LLM_FALLBACK_CHAIN.split(",")
  : ["gpt-4o", "gpt-4o-mini", "gpt-3.5-turbo"];

// ─── Concurrency Semaphore ─────────────────────────────────────────────────

const MAX_CONCURRENT = parseInt(process.env.LLM_MAX_CONCURRENT || "10", 10);
let activeConcurrent = 0;
const concurrentWaiters: Array<() => void> = [];

async function acquireConcurrency(): Promise<void> {
  if (activeConcurrent < MAX_CONCURRENT) {
    activeConcurrent++;
    return;
  }
  return new Promise<void>((resolve) => {
    concurrentWaiters.push(resolve);
  });
}

function releaseConcurrency(): void {
  const next = concurrentWaiters.shift();
  if (next) {
    next();
  } else {
    activeConcurrent--;
  }
}

// ─── Retry with exponential backoff ────────────────────────────────────────

async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  maxRetries: number = 3,
  baseDelayMs: number = 1000
): Promise<T> {
  let lastError: any;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      lastError = err;
      if (attempt < maxRetries && (err instanceof LLMRateLimitError || err.status === 429)) {
        const delay = baseDelayMs * Math.pow(2, attempt) + Math.random() * 500;
        logger.warn({ attempt, delay_ms: Math.round(delay), err: err.message }, "Rate limited, retrying with backoff");
        await new Promise((r) => setTimeout(r, delay));
      } else {
        throw err;
      }
    }
  }
  throw lastError;
}

// ─── Circuit Breaker ───────────────────────────────────────────────────────

const circuitBreakerOptions: CircuitBreaker.Options = {
  timeout: parseInt(process.env.LLM_CIRCUIT_BREAKER_TIMEOUT_MS || "30000", 10),
  errorThresholdPercentage: parseInt(process.env.LLM_CIRCUIT_BREAKER_THRESHOLD || "50", 10),
  resetTimeout: parseInt(process.env.LLM_CIRCUIT_BREAKER_RESET_MS || "30000", 10),
  rollingCountTimeout: 10000,
  rollingCountBuckets: 10,
  volumeThreshold: parseInt(process.env.LLM_CIRCUIT_BREAKER_VOLUME || "5", 10),
};

let circuitState: "closed" | "open" | "half_open" = "closed";

interface CompletionUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_BASE_URL = process.env.OPENAI_BASE_URL || "https://api.openai.com/v1";

let openai: OpenAI | null = null;
if (OPENAI_API_KEY) {
  openai = new OpenAI({
    apiKey: OPENAI_API_KEY,
    baseURL: OPENAI_BASE_URL,
    timeout: parseInt(process.env.LLM_TIMEOUT_MS || "30000", 10),
    maxRetries: parseInt(process.env.LLM_MAX_RETRIES || "5", 10),
  });
}

const MODEL_TO_OPENAI = {
  "gpt-4o": process.env.OPENAI_BASE_URL?.includes("openrouter") ? "openai/gpt-4o" : "gpt-4o",
  "gpt-4o-mini": process.env.OPENAI_BASE_URL?.includes("openrouter") ? "openai/gpt-4o-mini" : "gpt-4o-mini",
  "gpt-3.5-turbo": process.env.OPENAI_BASE_URL?.includes("openrouter") ? "openai/gpt-3.5-turbo" : "gpt-3.5-turbo",
  "llama3-8b-8192": "llama3-8b-8192",
  "llama3-70b-8192": "llama3-70b-8192",
  "mixtral-8x7b-32768": "mixtral-8x7b-32768",
} as Record<string, string>;

function countTokens(text: string): number {
  const enc = get_encoding("cl100k_base");
  try {
    const tokens = enc.encode(text);
    return tokens.length;
  } finally {
    enc.free();
  }
}

function calculateCost(promptTokens: number, completionTokens: number, model: string): string {
  const pricing = PRICING[model] ?? { input: 0.0025, output: 0.01 };
  const cost = ((promptTokens / 1000) * pricing.input + (completionTokens / 1000) * pricing.output).toFixed(6);
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

async function callOpenAIWithFallback(
  openaiMessages: any[],
  preferredModel: string,
  temperature: number,
  maxTokens: number | undefined,
  toolDefinitions: ToolDef[] | undefined,
  signal?: AbortSignal
): Promise<{ content: string | null; toolCalls: ToolCallResult[]; model: string; usage: CompletionUsage }> {
  if (!openai) {
    throw new Error("OpenAI client not initialized (missing OPENAI_API_KEY)");
  }

  const models = [preferredModel, ...FALLBACK_CHAIN.filter((m) => m !== preferredModel)];

  for (const model of models) {
    const openaiModel = MODEL_TO_OPENAI[model];
    if (!openaiModel) continue;

    try {
      const result = await retryWithBackoff(async () => {
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
            max_tokens: Math.min((maxTokens || 512), 512),
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

      return result;
    } catch (err: any) {
      const status = err.status || err.statusCode || 0;

      // Non-retryable errors propagate immediately (no fallback)
      if (status === 400 || status === 422) {
        throw new LLM400Error(`LLM bad request: ${err.message}`, { statusCode: status, model });
      }
      if (status === 401 || status === 403) {
        throw new LLMAuthError(`LLM auth failed: ${err.message}`, { model });
      }
      // 429 with retry exhausted — try next model in fallback chain
      if (status === 429 || err instanceof LLMRateLimitError) {
        logger.warn({ model, err: err.message }, "Rate limit retries exhausted, trying fallback model");
        continue;
      }

      logger.warn({
        model,
        err: err.message,
        status,
        errorBody: err.error ? JSON.stringify(err.error).slice(0, 3000) : undefined,
        stack: err.stack?.slice(0, 300),
      }, "Model call failed, trying fallback");
    }
  }

  throw new Error("All models in fallback chain exhausted");
}

// Wrap with circuit breaker
const circuitBreaker = new CircuitBreaker(
  (messages: any[], model: string, temp: number, maxTokens: number | undefined, tools: ToolDef[] | undefined, signal?: AbortSignal) =>
    callOpenAIWithFallback(messages, model, temp, maxTokens, tools, signal),
  circuitBreakerOptions
);

circuitBreaker.on("open", () => {
  circuitState = "open";
  logger.warn("LLM circuit breaker OPEN — requests will be fast-failed");
});
circuitBreaker.on("halfOpen", () => {
  circuitState = "half_open";
  logger.info("LLM circuit breaker HALF_OPEN — testing with limited traffic");
});
circuitBreaker.on("close", () => {
  circuitState = "closed";
  logger.info("LLM circuit breaker CLOSED — normal operation resumed");
});
circuitBreaker.on("fallback", () => {
  logger.warn("LLM circuit breaker fallback triggered");
});

const server = new grpc.Server({
  interceptors: [createNamespaceServerInterceptor(), createServiceTokenServerInterceptor()],
});

server.addService(llmService.service, {
  Generate: async (call: any, callback: any) => {
    const { agent_id, execution_id, model: preferredModel, messages, temperature, max_tokens, tool_definitions } = call.request;
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
      await acquireConcurrency();
      acquired = true;

      // Map messages to OpenAI format, preserving tool_calls on assistant messages
      const openaiMessages = (messages || []).map((m: any) => {
        const base: any = {
          role: m.role as "system" | "user" | "assistant" | "tool",
          content: m.content,
        };
        if (m.tool_call_id) {
          base.tool_call_id = m.tool_call_id;
        }
        if (m.name) {
          base.name = m.name;
        }
        // Restore structured tool_calls on assistant messages
        if (m.tool_calls && m.tool_calls.length > 0) {
          base.tool_calls = m.tool_calls.map((tc: any) => ({
            id: tc.id,
            type: "function",
            function: {
              name: tc.name,
              arguments: typeof tc.args === "string" ? tc.args : JSON.stringify(tc.args || {}),
            },
          }));
        }
        return base;
      });

      const timeoutMs = parseInt(process.env.LLM_TIMEOUT_MS || "30000", 10);
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(), timeoutMs);

      const result = await circuitBreaker.fire(
        openaiMessages,
        preferredModel || "gpt-4o",
        temperature ?? 0.7,
        max_tokens ?? undefined,
        tool_definitions,
        abort.signal
      ) as { content: string | null; toolCalls: ToolCallResult[]; model: string; usage: CompletionUsage };
      clearTimeout(timer);

      const usage = result.usage;
      const cost = calculateCost(usage.prompt_tokens, usage.completion_tokens, result.model);
      const latency = Date.now() - startTime;

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
    } catch (err: any) {
      logger.error({
        agent_id,
        execution_id,
        err: err.message,
        status: err.status,
        body: err.body ? JSON.stringify(err.body).slice(0, 2000) : undefined,
      }, "LLM generation failed");

      const code = err.name === "AbortError"
        ? grpc.status.DEADLINE_EXCEEDED
        : grpc.status.INTERNAL;

      callback({
        code,
        message: `LLM generation failed: ${err.message}`,
      });
    } finally {
      if (acquired) releaseConcurrency();
    }
  },
});

server.addService(HEALTH_SERVICE, {
  check: (_call: any, callback: any) => {
    const healthy = openai && circuitState !== "open";
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
      const healthy = openai && circuitState !== "open";
      const code = healthy ? 200 : 503;
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        status: healthy ? "SERVING" : "NOT_SERVING",
        service: "llm-router",
        circuit_breaker: circuitState,
        openai_configured: !!openai,
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

export { server, PRICING, countTokens, calculateCost, RateLimiter, rateLimiter };
