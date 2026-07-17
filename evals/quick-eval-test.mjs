// quick-eval-test.mjs — quick smoke test of the eval pipeline
import http from "node:http";
import { execSync } from "node:child_process";

const API = "http://localhost:3001";
const AUTH = { email: "loadtest5@test.com", password: "LoadTestPass123" };
const AGENT_ID = "eval-agent";
const TMPL = "enterprise-grade-agent-orchestration-platform-main-temporal-1";

function api(method, urlPath, body, token) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlPath, API);
    const opts = {
      hostname: u.hostname, port: u.port, path: u.pathname, method,
      headers: { "Content-Type": "application/json" },
    };
    if (token) opts.headers["Authorization"] = "Bearer " + token;
    const req = http.request(opts, (res) => {
      let d = "";
      res.on("data", (c) => (d += c));
      res.on("end", () => resolve(JSON.parse(d)));
    });
    req.on("error", reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function temporalDescribe(wfId) {
  try {
    const cmd = `docker exec ${TMPL} sh -c "temporal workflow describe --address 172.19.0.10:7233 --namespace egaop -w ${wfId} -o json 2>/dev/null"`;
    return JSON.parse(execSync(cmd, { encoding: "utf-8", timeout: 5000 }));
  } catch { return null; }
}

async function runCase(prompt) {
  const r = await api("POST", "/api/agents/" + AGENT_ID + "/run",
    { namespace: "default", input: { prompt } },
    token
  );
  const wfId = r.data.workflowId;

  for (let i = 0; i < 30; i++) {
    await sleep(2000);
    const desc = temporalDescribe(wfId);
    if (!desc) continue;
    const status = desc.workflowExecutionInfo?.status;
    if (status === "WORKFLOW_EXECUTION_STATUS_COMPLETED") {
      return desc.result;
    }
    if (["WORKFLOW_EXECUTION_STATUS_FAILED", "WORKFLOW_EXECUTION_STATUS_TIMED_OUT"].includes(status)) {
      return { status: "ERROR", output: "Workflow " + status, iterations: 0, toolCalls: [] };
    }
  }
  return { status: "TIMEOUT", output: "", iterations: 0, toolCalls: [] };
}

// Login
const r = await api("POST", "/api/auth/login", AUTH);
const token = r.data.token;
console.log("Token OK");

// Test cases
const cases = [
  { prompt: "What is 2+2?", desc: "simple Q&A" },
  { prompt: "Just say hello.", desc: "greeting" },
  { prompt: "Calculate 15 * 37 using Python.", desc: "code_interpreter" },
  { prompt: "What tools are available to you? List them.", desc: "tool listing" },
];

for (const c of cases) {
  console.log("\n=== [" + c.desc + "] " + c.prompt.slice(0, 50) + " ===");
  const result = await runCase(c.prompt);
  console.log("  Status: " + (result.status || "UNKNOWN") + " (" + (result.iterations || 0) + " iters)");
  console.log("  Tools:  " + ((result.toolCalls || []).map((t) => t.toolName).join(", ") || "(none)"));
  console.log("  Output: " + (result.output || "").slice(0, 300));
  console.log("  Cost:   " + (result.totalCost || "?"));
}
