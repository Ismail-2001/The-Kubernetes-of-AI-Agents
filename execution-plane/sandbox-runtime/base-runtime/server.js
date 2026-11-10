const http = require("http");
const { spawn } = require("child_process");
const crypto = require("crypto");

const EXPECTED_TOKEN = process.env.SANDBOX_EXEC_TOKEN;
if (!EXPECTED_TOKEN || EXPECTED_TOKEN.trim() === "") {
  // eslint-disable-next-line no-console
  console.error("FATAL: SANDBOX_EXEC_TOKEN environment variable must be set");
  process.exit(1);
}

const PORT = parseInt(process.env.PORT, 10) || 8080;
const HOST = "0.0.0.0";

function timingSafeCompare(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

// ─── Tool Executors (structured, no shell) ─────────────────────────────────

function spawnTool(args, opts) {
  return new Promise((resolve) => {
    const proc = spawn(args[0], args.slice(1), { shell: false, timeout: 30000, killSignal: "SIGKILL", ...opts });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => { stdout += d.toString(); });
    proc.stderr.on("data", (d) => { stderr += d.toString(); });
    proc.on("close", (code) => resolve({ stdout, stderr, exitCode: code ?? 1 }));
    proc.on("error", () => resolve({ stdout, stderr, exitCode: 1 }));
  });
}

const TOOLS = {
  code_interpreter: async (args) => {
    if (typeof args.code !== "string" || args.code.length > 10000) return { stdout: "", stderr: "Invalid code", exitCode: 1 };
    if (/[^\x20-\x7E\n\r\t]/.test(args.code)) return { stdout: "", stderr: "Invalid characters in code", exitCode: 1 };
    return spawnTool(["python3", "-c", args.code]);
  },
  file_read: async (args) => {
    if (typeof args.path !== "string" || args.path.includes("..") || !/^[a-zA-Z0-9_/.\-]+$/.test(args.path)) {
      return { stdout: "", stderr: "Invalid path", exitCode: 1 };
    }
    return spawnTool(["cat", args.path]);
  },
  file_write: async (args) => {
    if (typeof args.path !== "string" || args.path.includes("..") || !/^[a-zA-Z0-9_/.\-]+$/.test(args.path)) {
      return { stdout: "", stderr: "Invalid path", exitCode: 1 };
    }
    const content = typeof args.content === "string" ? args.content : "";
    if (content.length > 1000000) return { stdout: "", stderr: "Content too large", exitCode: 1 };
    return new Promise((resolve) => {
      const proc = spawn("tee", [args.path], { shell: false, timeout: 10000, killSignal: "SIGKILL" });
      let so = "", se = "";
      proc.stdout.on("data", (d) => { so += d.toString(); });
      proc.stderr.on("data", (d) => { se += d.toString(); });
      proc.stdin.write(content);
      proc.stdin.end();
      proc.on("close", (c) => resolve({ stdout: so, stderr: se, exitCode: c ?? 1 }));
      proc.on("error", () => resolve({ stdout: so, stderr: se, exitCode: 1 }));
    });
  },
  database_query: async (args) => {
    if (typeof args.query !== "string" || args.query.length > 10000) return { stdout: "", stderr: "Invalid query", exitCode: 1 };
    if (/[;&|`$(){}!<>]/ .test(args.query)) return { stdout: "", stderr: "Blocked characters in query", exitCode: 1 };
    return spawnTool(["sqlite3", "/tmp/data.db", args.query]);
  },
};

const ALLOWED_TOOLS = new Set(Object.keys(TOOLS));

// ─── HTTP Server ────────────────────────────────────────────────────────────

const server = http.createServer((req, res) => {
  res.setHeader("Content-Type", "application/json");

  if (req.url === "/healthz" && req.method === "GET") {
    res.writeHead(200);
    res.end(JSON.stringify({ status: "ok" }));
    return;
  }

  if (req.url === "/exec" && req.method === "POST") {
    const authHeader = req.headers["authorization"] || req.headers["Authorization"];
    if (!authHeader || typeof authHeader !== "string") {
      res.writeHead(401);
      res.end(JSON.stringify({ error: "Missing Authorization header" }));
      return;
    }

    const match = authHeader.match(/^Bearer\s+(.+)$/i);
    if (!match || !timingSafeCompare(match[1], EXPECTED_TOKEN)) {
      res.writeHead(401);
      res.end(JSON.stringify({ error: "Unauthorized" }));
      return;
    }

    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", async () => {
      try {
        const parsed = JSON.parse(body);

        // Structured execution: { tool, args }
        if (parsed && parsed.tool && ALLOWED_TOOLS.has(parsed.tool)) {
          const handler = TOOLS[parsed.tool];
          const result = await handler(parsed.args || {});
          res.writeHead(200);
          res.end(JSON.stringify(result));
          return;
        }

        res.writeHead(400);
        res.end(JSON.stringify({ error: "valid tool required; raw command execution is disabled" }));
      } catch (e) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: "Invalid JSON body" }));
      }
    });
    return;
  }

  res.writeHead(404);
  res.end();
});

server.listen(PORT, HOST, () => {
  // eslint-disable-next-line no-console -- standalone sandbox server, no pino available
  console.log(`Sandbox agent listening on ${HOST}:${PORT}`);
});
