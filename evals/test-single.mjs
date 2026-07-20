import http from "node:http";
import { execSync } from "node:child_process";

const API = "http://localhost:3001";
const AUTH = { email: "loadtest5@test.com", password: "LoadTestPass123" };
const AGENT_ID = "eval-agent";
const TEMPORAL_CONTAINER = "enterprise-grade-agent-orchestration-platform-main-temporal-1";
const TEMPORAL_ADDRESS = "172.19.0.7:7233";

const SYSTEM_PROMPT = `You are a helpful AI agent with access to functions. Rules:
1. For simple questions you can answer from memory (trivial math, general knowledge, greetings), answer directly without calling any function.
2. Only call a function when you genuinely need external data or computation that you cannot do yourself.`;

function api(method, urlPath, body, token) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlPath, API);
    const opts = {
      hostname: u.hostname, port: u.port, path: u.pathname,
      method, headers: { "Content-Type": "application/json" },
    };
    if (token) opts.headers["Authorization"] = `Bearer ${token}`;
    const req = http.request(opts, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => { try { resolve(JSON.parse(data)); } catch { resolve(data); } });
    });
    req.on("error", reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function temporalDescribe(wfId) {
  try {
    const cmd = `docker exec ${TEMPORAL_CONTAINER} sh -c "temporal workflow describe --address ${TEMPORAL_ADDRESS} --namespace egaop -w ${wfId} -o json 2>/dev/null"`;
    const out = execSync(cmd, { encoding: "utf-8", timeout: 10000 });
    return JSON.parse(out);
  } catch { return null; }
}

async function run() {
  console.log("Logging in...");
  const lr = await api("POST", "/api/auth/login", AUTH);
  const token = lr.data.token;
  console.log("Login OK");

  console.log("Triggering workflow...");
  const body = { namespace: "default", input: { prompt: "What is 2+2?", systemPrompt: SYSTEM_PROMPT } };
  const rr = await api("POST", `/api/agents/${AGENT_ID}/run`, body, token);
  console.log("Trigger response:", JSON.stringify(rr).slice(0, 500));

  const wfId = rr?.data?.workflowId;
  if (!wfId) { console.log("No workflowId! Full response:", JSON.stringify(rr)); process.exit(1); }
  console.log("Polling workflow:", wfId);

  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 3000));
    const desc = temporalDescribe(wfId);
    if (desc) {
      const status = desc.workflowExecutionInfo?.status;
      console.log(`Poll ${i}: ${status}`);
      if (status === "WORKFLOW_EXECUTION_STATUS_COMPLETED") {
        const r = desc.result || {};
        console.log("COMPLETED. Output:", (r.output || "").slice(0, 500));
        console.log("Tool calls:", JSON.stringify(r.toolCalls || []));
        process.exit(0);
      }
      if (status === "WORKFLOW_EXECUTION_STATUS_FAILED") {
        console.log("FAILED:", JSON.stringify(desc).slice(0, 1000));
        process.exit(1);
      }
    } else {
      console.log(`Poll ${i}: no temporal description`);
    }
  }
  console.log("TIMEOUT after 180s");
}

run().catch(e => { console.error(e); process.exit(1); });
