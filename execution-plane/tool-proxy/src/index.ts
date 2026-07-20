import { initTracing, shutdownTracing, createNamespaceServerInterceptor, createServiceTokenServerInterceptor, validateSecrets, loadSecretsIntoEnv } from "@e-gaop/shared";

initTracing("tool-proxy");
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

const PROTO_PATH = path.resolve(__dirname, "../../../api/proto/egaop/v1/tool.proto");

const packageDefinition = protoLoader.loadSync(PROTO_PATH, {
  keepCase: true,
  longs: String,
  enums: String,
  defaults: true,
  oneofs: true,
  includeDirs: [path.resolve(__dirname, "../../../api/proto")]
});

const egaopProto = grpc.loadPackageDefinition(packageDefinition) as any;
const toolService = egaopProto.egaop.v1.ToolService;

function scanForPII(data: any): boolean {
  const piiRegex = /\b(?!000)(?!666)(?!9\d{2})\d{3}[- ]?(?!00)\d{2}[- ]?(?!0000)\d{4}\b/;
  const emailRegex = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/;

  const content = JSON.stringify(data);
  return piiRegex.test(content) || emailRegex.test(content);
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

function buildSandboxCommand(toolName: string, args: any): string {
  switch (toolName) {
    case "code_interpreter": {
      const code = args?.code || args?.script || "";
      return code ? `python3 -c ${JSON.stringify(code)}` : "echo 'no code provided'";
    }
    case "file_read": {
      const p = args?.path || "";
      return p ? `cat ${JSON.stringify(p)}` : "echo 'no path provided'";
    }
    case "file_write": {
      const p = args?.path || "";
      const c = args?.content || "";
      return p ? `printf ${JSON.stringify(c)} > ${JSON.stringify(p)}` : "echo 'no path provided'";
    }
    case "database_query": {
      const q = args?.query || "";
      return q ? `sqlite3 /tmp/data.db ${JSON.stringify(q)}` : "echo 'no query provided'";
    }
    default:
      return `echo 'unsupported sandbox tool: ${toolName}'`;
  }
}

function injectCredentials(toolName: string): Record<string, string> {
  const key = process.env[`TOOL_${toolName.toUpperCase()}_API_KEY`] || process.env.TOOL_DEFAULT_API_KEY || "";
  if (key) return { Authorization: `Bearer ${key}` };
  return {};
}

const server = new grpc.Server({
  interceptors: [createNamespaceServerInterceptor(), createServiceTokenServerInterceptor()],
});

server.addService(toolService.service, {
  CallTool: async (call: any, callback: any) => {
    const { agent_id, execution_id, tool_name, args, sandbox_ip } = call.request;
    const startTime = Date.now();

    logger.info({ agent_id, execution_id, tool_name }, "Incoming tool invocation");

    const { allowed, retryAfterMs } = rateLimiter.check(agent_id);
    if (!allowed) {
      logger.warn({ agent_id, tool_name, retryAfterMs }, "Rate limit hit");
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
      logger.warn({ agent_id, execution_id }, "PII detected in tool arguments");
    }

    try {
      let url = config.endpoint;
      if (url.includes("__URL__") && args?.url) {
        url = url.replace("__URL__", encodeURIComponent(args.url));
      }

      if (SANDBOX_TOOLS.has(tool_name)) {
        if (!sandbox_ip) {
          return callback(null, {
            status: "failed",
            error_message: `Sandbox IP not provided for sandbox-execution tool: ${tool_name}`,
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

      const fetchOpts: any = { method: config.method, headers };
      if (config.method === "POST" && args) {
        fetchOpts.body = JSON.stringify(args);
      }

      // Sandbox tools: override method to POST and body to sandbox command format
      if (SANDBOX_TOOLS.has(tool_name)) {
        fetchOpts.method = "POST";
        fetchOpts.body = JSON.stringify({ command: buildSandboxCommand(tool_name, args) });
      }

      const response = await fetch(url, fetchOpts);
      const body = response.ok ? await response.text() : `HTTP ${response.status}`;

      const latency = Date.now() - startTime;
      logger.info({ tool_name, latency, status: response.status }, "Tool call completed");

      callback(null, {
        result: { value: "SUCCESS", message: body.slice(0, 10000) },
        status: "succeeded",
        latency_ms: latency,
        cost: "$0.002",
      });
    } catch (err: any) {
      const latency = Date.now() - startTime;
      logger.error({ tool_name, err: err.message }, "Tool call failed");
      callback(null, {
        status: "failed",
        error_message: `Tool execution error: ${err.message}`,
        latency_ms: latency,
      });
    }
  }
});

server.addService(HEALTH_SERVICE, {
  check: (_call: any, callback: any) => {
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
    if (req.url === "/healthz" || req.url === "/readyz") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "SERVING", service: "tool-proxy", timestamp: new Date().toISOString() }));
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

export { server, scanForPII, RateLimiter };
