const http = require("http");
const { exec } = require("child_process");

const PORT = 8080;
const HOST = "0.0.0.0";

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
        const { command } = JSON.parse(body);
        if (!command) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "command is required" }));
          return;
        }
        exec(command, { timeout: 30000, shell: "/bin/sh" }, (err, stdout, stderr) => {
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
