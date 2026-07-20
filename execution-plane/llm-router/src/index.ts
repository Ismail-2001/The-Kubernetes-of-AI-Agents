import { initTracing, shutdownTracing, validateSecrets } from "@e-gaop/shared";

initTracing("llm-router");
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
import { RateLimiter, getServerCredentials } from "@e-gaop/shared";

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

const logger = process.env.NODE_ENV === "test"
  ? pino({ level: "silent" })
  : pino({
      level: process.env.LOG_LEVEL || "info",
      transport: {
        target: "pino-pretty",
        options: { colorize: true }
      }
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
};

const FALLBACK_CHAIN = process.env.LLM_FALLBACK_CHAIN
  ? process.env.LLM_FALLBACK_CHAIN.split(",")
  : ["gpt-4o", "gpt-4o-mini", "gpt-3.5-turbo"];

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
    maxRetries: parseInt(process.env.LLM_MAX_RETRIES || "3", 10),
  });
}

const MODEL_TO_OPENAI = {
  "gpt-4o": process.env.OPENAI_BASE_URL?.includes("openrouter") ? "openai/gpt-4o" : "gpt-4o",
  "gpt-4o-mini": process.env.OPENAI_BASE_URL?.includes("openrouter") ? "openai/gpt-4o-mini" : "gpt-4o-mini",
  "gpt-3.5-turbo": process.env.OPENAI_BASE_URL?.includes("openrouter") ? "openai/gpt-3.5-turbo" : "gpt-3.5-turbo",
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
      // Build OpenAI tools parameter from our tool definitions
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
        continue;
      }

      // Extract structured tool_calls from the assistant message
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
    } catch (err: any) {
      logger.warn({
        model,
        err: err.message,
        status: err.status,
        errorBody: err.error ? JSON.stringify(err.error).slice(0, 3000) : undefined,
        stack: err.stack?.slice(0, 300),
      }, "Model call failed, trying fallback");
    }
  }

  throw new Error("All models in fallback chain exhausted");
}

const server = new grpc.Server();

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

    const { allowed, retryAfterMs } = rateLimiter.check(agent_id);
    if (!allowed) {
      logger.warn({ agent_id, execution_id, retryAfterMs }, "LLM rate limit hit");
      return callback({
        code: grpc.status.RESOURCE_EXHAUSTED,
        message: `Rate limit exceeded. Retry after ${Math.ceil(retryAfterMs / 1000)}s.`,
      });
    }

    try {
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

      const result = await callOpenAIWithFallback(
        openaiMessages,
        preferredModel || "gpt-4o",
        temperature ?? 0.7,
        max_tokens ?? undefined,
        tool_definitions,
        abort.signal
      );
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
    }
  },
});

server.addService(HEALTH_SERVICE, {
  check: (_call: any, callback: any) => {
    callback(null, { status: openai ? "SERVING" : "NOT_SERVING" });
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
      const status = openai ? "SERVING" : "NOT_SERVING";
      const code = openai ? 200 : 503;
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status, service: "llm-router" }));
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
