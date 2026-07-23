const http = require("http");
const { execFile } = require("child_process");

const PORT = 8080;
const HOST = "0.0.0.0";

const BLOCKED_PATTERNS = [
  /[;&|`$(){}!<>]/,
  /\b(rm\s+-rf|mkfs|dd\s+if=|:()\s*\{\s*:\|:&\s*\};)\b/,
  /\b(curl|wget)\s+.*\|\s*(bash|sh|python|node)\b/,
  /\bbase64\s+--decode\b/,
];

function isCommandSafe(command) {
  if (typeof command !== "string" || command.length === 0) return false;
  if (command.length > 4096) return false;
  for (const pattern of BLOCKED_PATTERNS) {
    if (pattern.test(command)) return false;
  }
  return true;
}

const server = http.createServer((req, res) => {
  if (req.url === "/healthz" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", pid: process.pid }));
    return;
  }

  if (req.url === "/exec" && req.method === "POST") {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      try {
        const parsed = JSON.parse(body);
        const command = parsed && parsed.command;
        if (!command) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "command is required" }));
          return;
        }
        if (!isCommandSafe(command)) {
          res.writeHead(403, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "command rejected by security policy" }));
          return;
        }
        execFile("/bin/sh", ["-c", command], { timeout: 30000 }, (err, stdout, stderr) => {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              stdout: stdout || "",
              stderr: stderr || "",
              exitCode: err ? err.code || 1 : 0,
            })
          );
        });
      } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid JSON body" }));
      }
    });
    return;
  }

  res.writeHead(404);
  res.end();
});

server.listen(PORT, HOST, () => {
  console.log(`Sandbox agent listening on ${HOST}:${PORT}`);
});
