import { initTracing, shutdownTracing, createNamespaceServerInterceptor, createServiceTokenServerInterceptor, createTraceServerInterceptor, validateSecrets, loadSecretsIntoEnv, PIIViolationError, createAuditEntry, buildHealthResponse, healthToHttpStatus } from "@e-gaop/shared";

initTracing("tool-proxy");
loadSecretsIntoEnv();
if (process.env.NODE_ENV !== "test") {
  validateSecrets();
}

import path from "path";
import http from "http";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import pino from "pino";
import { RateLimiter, extractNamespace, getServerCredentials } from "@e-gaop/shared";

const SERVICE_VERSION = process.env.SERVICE_VERSION || "1.0.0";
const healthStartTime = new Date();

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

const PROTO_PATH = path.resolve(__dirname, "../../../api/proto/egaop/v1/tool.proto");

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
const toolService = egaopProto.egaop.v1.ToolService;

const PII_PATTERNS: Array<{ type: string; re: RegExp }> = [
  { type: "SSN", re: /\b(?!000)(?!666)(?!9\d{2})\d{3}[- ]?(?!00)\d{2}[- ]?(?!0000)\d{4}\b/ },
  { type: "email", re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/ },
  // Credit cards (Luhn-capable formats for Visa/MC/Amex/Discover, no spaces)
  { type: "credit_card", re: /\b(?:\d{4}[- ]?){3}\d{4}\b|\b3[47]\d{2}[- ]?\d{6}[- ]?\d{5}\b|\b6(?:011|5\d{2})\d{3}[- ]?\d{4}[- ]?\d{4}[- ]?\d{4}\b/ },
  // US phone numbers (10 digits with optional +1, separators)
  { type: "phone_us", re: /\b(\+?1[-. ]?)?\(?[2-9]\d{2}\)?[-. ]?\d{3}[-. ]?\d{4}\b/ },
  // General international phone (E.164)
  { type: "phone_e164", re: /\b\+[1-9]\d{1,3}[-. ]?\d{4,14}\b/ },
  // Date of birth (YYYY-MM-DD / MM/DD/YYYY where year is plausible)
  { type: "date_of_birth", re: /\b(?:19|20)\d{2}[-/](?:0[1-9]|1[0-2])[-/](?:0[1-9]|[12]\d|3[01])\b|\b(?:0[1-9]|1[0-2])[-/](?:0[1-9]|[12]\d|3[01])[-/](?:19|20)\d{2}\b/ },
  // IP address
  { type: "ip_address", re: /\b(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\b/ },
];

function scanForPII(data: unknown): boolean {
  const content = JSON.stringify(data);
  return PII_PATTERNS.some((p) => p.re.test(content));
}

function detectedPIIPatterns(data: unknown): string[] {
  const content = JSON.stringify(data);
  const found: string[] = [];
  for (const p of PII_PATTERNS) {
    if (p.re.test(content)) found.push(p.type);
  }
  return found;
}

interface ToolConfig {
  endpoint: string;
  method: string;
  headers?: Record<string, string>;
}

const TOOL_REGISTRY: Record<string, ToolConfig> = {
  google_search: { endpoint: "https://api.serpapi.com/search", method: "GET" },
  web_fetch: { endpoint: "https://r.jina.ai/http://__URL__", method: "GET" },
  code_interpreter: { endpoint: "http://localhost:8080/execute", method: "POST" },
  file_read: { endpoint: "http://localhost:8080/read", method: "GET" },
  file_write: { endpoint: "http://localhost:8080/write", method: "POST" },
  database_query: { endpoint: "http://localhost:8080/query", method: "POST" },
};

const SANDBOX_TOOLS = new Set(["code_interpreter", "file_read", "file_write", "database_query"]);

const SAFE_PATH_RE = /^[a-zA-Z0-9_/.-]+$/;

const ALLOWED_WEB_FETCH_HOSTS = new Set([
  "api.serpapi.com",
  "r.jina.ai",
  "api.openai.com",
  "api.anthropic.com",
  "en.wikipedia.org",
  "wiki.wikipedia.org",
]);

function isPrivateIP(ip: string): boolean {
  if (/^(127\.|10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|0\.|localhost|::1|169\.254\.|100\.64\.)/.test(ip)) return true;
  if (/^\[/.test(ip)) return true;
  return false;
}

function isBlockedURL(urlStr: string): boolean {
  try {
    const parsed = new URL(urlStr);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return true;
    if (isPrivateIP(parsed.hostname)) return true;
    if (/\.internal$/i.test(parsed.hostname)) return true;
    if (/\.local$/i.test(parsed.hostname)) return true;
    if (/metadata\.google\.internal/i.test(parsed.hostname)) return true;
    return false;
  } catch {
    return true;
  }
}

function isAllowedWebFetchHost(urlStr: string): boolean {
  try {
    const parsed = new URL(urlStr);
    return ALLOWED_WEB_FETCH_HOSTS.has(parsed.hostname);
  } catch {
    return false;
  }
}

function validateSandboxArgs(toolName: string, args: Record<string, unknown> | undefined): string | null {
  switch (toolName) {
    case "code_interpreter": {
      const code = args?.code || args?.script || "";
      if (typeof code !== "string" || code.length === 0) return "No code provided";
      if (code.length > 10000) return "Code exceeds 10,000 character limit";
      return null;
    }
    case "file_read": {
      const p = args?.path || "";
      if (typeof p !== "string" || !p) return "No path provided";
      if (!SAFE_PATH_RE.test(p) || p.includes("..")) return "Invalid path";
      return null;
    }
    case "file_write": {
      const p = args?.path || "";
      if (typeof p !== "string" || !p) return "No path provided";
      if (!SAFE_PATH_RE.test(p) || p.includes("..")) return "Invalid path";
      const c = args?.content || "";
      if (typeof c !== "string" || c.length > 1000000) return "Content too large";
      return null;
    }
    case "database_query": {
      const q = args?.query || "";
      if (typeof q !== "string" || !q) return "No query provided";
      if (q.length > 10000) return "Query too long";
      if (/[;&|`$(){}!<>]/.test(q)) return "Query contains blocked characters";
      return null;
    }
    default:
      return `Unknown tool: ${toolName}`;
  }
}

function injectCredentials(toolName: string): Record<string, string> {
  const key = process.env[`TOOL_${toolName.toUpperCase()}_API_KEY`] || process.env.TOOL_DEFAULT_API_KEY || "";
  if (key) return { Authorization: `Bearer ${key}` };
  return {};
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithRetry(url: string, opts: RequestInit, maxRetries = 3): Promise<Response> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetch(url, opts);
      if (res.status >= 500 && res.status <= 599 && attempt < maxRetries) {
        await sleep(200 * 2 ** attempt);
        continue;
      }
      return res;
    } catch (err: unknown) {
      lastErr = err;
      // Network-level errors (ECONNRESET, ENOTFOUND, etc.) are retryable; abort is not.
      const name = err instanceof Error ? err.name : ((err as Record<string, unknown>)?.name as string) || "";
      if (name === "AbortError" || attempt >= maxRetries) throw err;
      await sleep(200 * 2 ** attempt);
    }
  }
  throw lastErr;
}

const server = new grpc.Server({
  interceptors: [createNamespaceServerInterceptor(), createServiceTokenServerInterceptor(), createTraceServerInterceptor()],
});

server.addService(toolService.service, {
  CallTool: async (call: grpc.ServerUnaryCall<Record<string, unknown>, Record<string, unknown>>, callback: grpc.sendUnaryData<Record<string, unknown>>) => {
    const req = call.request;
    const agent_id = req.agent_id as string;
    const execution_id = req.execution_id as string;
    const tool_name = req.tool_name as string;
    const args = (req.args ?? {}) as Record<string, unknown>;
    const sandbox_ip = req.sandbox_ip as string | undefined;
    const startTime = Date.now();

    logger.info({ agent_id, execution_id, tool_name }, "Incoming tool invocation");

    const userId = call.metadata?.get("x-user-id")?.[0] as string | undefined;
    const rateKey = userId
      ? `user:${userId}:${tool_name}`
      : `${extractNamespace(agent_id)}:${agent_id}:${tool_name}`;
    const { allowed, retryAfterMs } = rateLimiter.check(rateKey);
    if (!allowed) {
      logger.warn({ agent_id, tool_name, userId, retryAfterMs, rateKey }, "Rate limit hit");
      return callback({
        code: grpc.status.RESOURCE_EXHAUSTED,
        message: `Rate limit exceeded. Retry after ${Math.ceil(retryAfterMs / 1000)}s.`,
      });
    }

    const config = TOOL_REGISTRY[tool_name];
    if (!config) {
      return callback(null, {
        status: "failed",
        error_message: `Unknown tool: ${tool_name}`,
        latency_ms: Date.now() - startTime,
      });
    }

    if (scanForPII(args)) {
      const patterns = detectedPIIPatterns(args);
      logger.warn({ agent_id, execution_id, tool_name, patterns }, "PII detected in tool arguments — blocking");
      return callback(new PIIViolationError("PII detected in tool arguments", { toolName: tool_name, detectedPatterns: patterns }), null);
    }

    try {
      let url = config.endpoint;
      if (url.includes("__URL__") && args.url) {
        const argsUrl = args.url as string;
        if (isBlockedURL(argsUrl)) {
          logger.warn({ tool_name, url: argsUrl }, "SSRF blocked: URL targets private/internal network");
          return callback(null, {
            status: "failed",
            error_message: "URL targets a private or internal network address",
            latency_ms: Date.now() - startTime,
          });
        }
        if (tool_name === "web_fetch" && !isAllowedWebFetchHost(argsUrl)) {
          logger.warn({ tool_name, url: argsUrl }, "SSRF blocked: URL not in allowlist");
          return callback(null, {
            status: "failed",
            error_message: "URL is not in the allowed hosts list for web_fetch",
            latency_ms: Date.now() - startTime,
          });
        }
        url = url.replace("__URL__", encodeURIComponent(argsUrl));
      }

      if (SANDBOX_TOOLS.has(tool_name)) {
        if (!sandbox_ip) {
          return callback(null, {
            status: "failed",
            error_message: `Sandbox IP not provided for sandbox-execution tool: ${tool_name}`,
            latency_ms: Date.now() - startTime,
          });
        }
        if (isPrivateIP(sandbox_ip)) {
          logger.warn({ sandbox_ip }, "SSRF blocked: private/internal IP");
          return callback(null, {
            status: "failed",
            error_message: "Sandbox IP resolves to a private network address",
            latency_ms: Date.now() - startTime,
          });
        }
        url = `http://${sandbox_ip}:8080/exec`;
        logger.info({ tool_name, sandbox_ip, url }, "Sandbox-routed tool: constructed URL");
      }

      const creds = injectCredentials(tool_name);
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        "User-Agent": "EGAOP-Tool-Proxy/1.0",
        ...config.headers,
        ...creds,
      };

      const fetchOpts: RequestInit & { body?: string } = { method: config.method, headers, signal: AbortSignal.timeout(30000) };
      if (config.method === "POST" && args) {
        fetchOpts.body = JSON.stringify(args);
      }

      // Sandbox tools: send structured { tool, args } instead of shell command
      if (SANDBOX_TOOLS.has(tool_name)) {
        const validationError = validateSandboxArgs(tool_name, args);
        if (validationError) {
          return callback(null, {
            status: "failed",
            error_message: `Input validation failed: ${validationError}`,
            latency_ms: Date.now() - startTime,
          });
        }
        fetchOpts.method = "POST";
        fetchOpts.body = JSON.stringify({ tool: tool_name, args });
      }

      const response = await fetchWithRetry(url, fetchOpts);
      const body = response.ok ? await response.text() : `HTTP ${response.status}`;

      const latency = Date.now() - startTime;
      logger.info({ tool_name, latency, status: response.status }, "Tool call completed");

      try {
        createAuditEntry(
          "agent.tool_call",
          "info",
          { type: "agent", id: agent_id },
          { name: tool_name, result: response.ok ? "allowed" : "error" },
          { type: "tool", id: tool_name },
        );
      } catch { /* audit failure is non-fatal */ }

      callback(null, {
        result: { value: "SUCCESS", message: body.slice(0, 10000) },
        status: "succeeded",
        latency_ms: latency,
        cost: "$0.002",
      });
    } catch (err: unknown) {
      const errObj = err instanceof Error ? err : new Error(String(err));
      const latency = Date.now() - startTime;
      logger.error({ tool_name, err: errObj.message }, "Tool call failed");

      try {
        createAuditEntry(
          "agent.tool_call",
          "error",
          { type: "agent", id: agent_id },
          { name: tool_name, result: "error", reason: errObj.message },
          { type: "tool", id: tool_name },
        );
      } catch { /* audit failure is non-fatal */ }

      callback(null, {
        status: "failed",
        error_message: `Tool execution failed: ${tool_name}`,
        latency_ms: latency,
      });
    }
  }
});

server.addService(HEALTH_SERVICE, {
  check: (_call: grpc.ServerUnaryCall<Record<string, unknown>, Record<string, unknown>>, callback: grpc.sendUnaryData<Record<string, unknown>>) => {
    callback(null, { status: "SERVING" });
  }
});

if (process.env.NODE_ENV !== "test") {
  const PROXY_PORT = process.env.TOOL_PROXY_PORT || "50052";
  const HEALTH_PORT = parseInt(process.env.TOOL_PROXY_HEALTH_PORT || "15052", 10);

  server.bindAsync(`0.0.0.0:${PROXY_PORT}`, getServerCredentials(), (err, port) => {
    if (err) {
      logger.error(err, "Failed to bind Tool Proxy");
      return;
    }
    server.start();
    logger.info(`E-GAOP Tool Proxy listening on port ${port}`);
  });

  const healthServer = http.createServer((req, res) => {
    if (req.url === "/healthz") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "SERVING", service: "tool-proxy" }));
    } else if (req.url === "/readyz") {
      const response = buildHealthResponse("tool-proxy", SERVICE_VERSION, healthStartTime, []);
      const code = healthToHttpStatus(response.status);
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(JSON.stringify(response));
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  healthServer.listen(HEALTH_PORT, "0.0.0.0", () => {
    logger.info(`Health endpoint listening on port ${HEALTH_PORT}`);
  });

  const shutdown = async () => {
    logger.info("Shutting down Tool Proxy...");
    rateLimiter.dispose();
    server.tryShutdown(async () => {
      healthServer.close();
      await shutdownTracing();
      logger.info("Tool Proxy shut down");
      process.exit(0);
    });
    setTimeout(() => { logger.error("Forced shutdown"); process.exit(1); }, 5000).unref();
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

export {
  server,
  scanForPII,
  detectedPIIPatterns,
  isPrivateIP as isPrivateOrInternalIP,
  isBlockedURL,
  isAllowedWebFetchHost,
  validateSandboxArgs,
  injectCredentials,
  fetchWithRetry,
  RateLimiter,
};
