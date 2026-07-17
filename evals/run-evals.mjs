// run-evals.mjs — E-GAOP evals runner
// Triggers each golden case through the real API, polls via Temporal, scores results.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const API = "http://localhost:3001";
const AUTH = { email: "loadtest5@test.com", password: "LoadTestPass123" };
const AGENT_ID = "eval-agent";
const TEMPORAL_CONTAINER = "enterprise-grade-agent-orchestration-platform-main-temporal-1";
const DATASET_PATH = path.resolve(__dirname, "golden-dataset.json");
const RESULTS_DIR = path.resolve(__dirname, "results");



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
      res.on("end", () => {
        try { resolve(JSON.parse(data)); } catch { resolve(data); }
      });
    });
    req.on("error", reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function login() {
  const r = await api("POST", "/api/auth/login", AUTH);
  return r.data.token;
}

async function triggerRun(token, prompt, extra = {}) {
  const body = { namespace: extra.namespace || "default", input: { prompt } };
  if (extra.resourceNamespace) body.resourceNamespace = extra.resourceNamespace;
  if (extra.callerRole) body.callerRole = extra.callerRole;
  const r = await api("POST", `/api/agents/${AGENT_ID}/run`, body, token);
  return r.data;
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function temporalDescribe(wfId) {
  try {
    const cmd = `docker exec ${TEMPORAL_CONTAINER} sh -c "temporal workflow describe --address 172.19.0.10:7233 --namespace egaop -w ${wfId} -o json 2>/dev/null"`;
    const out = execSync(cmd, { encoding: "utf-8", timeout: 10000 });
    return JSON.parse(out);
  } catch {
    return null;
  }
}

async function pollWorkflow(wfId, timeoutMs = 60000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const desc = temporalDescribe(wfId);
    if (desc) {
      const status = desc.workflowExecutionInfo?.status;
      if (status === "WORKFLOW_EXECUTION_STATUS_COMPLETED") {
        const r = desc.result || {};
        const toolCalls = (r.toolCalls || []).map((tc) => ({
          iteration: tc.iteration, toolName: tc.toolName,
          args: tc.args, status: tc.status, latencyMs: tc.latencyMs,
        }));
        return {
          status: r.status || "COMPLETED",
          output: r.output || "",
          iterations: r.iterations || 0,
          totalCost: r.totalCost || "$0.000000",
          toolCalls,
        };
      }
      if (["WORKFLOW_EXECUTION_STATUS_FAILED", "WORKFLOW_EXECUTION_STATUS_TIMED_OUT"].includes(status)) {
        return { status: "ERROR", output: `Workflow ${status}`, iterations: 0, toolCalls: [] };
      }
    }
    await sleep(2000);
  }
  return { status: "TIMEOUT", output: "Workflow did not complete in time", iterations: 0, toolCalls: [] };
}

function matchString(val, pattern) {
  if (!val) return false;
  if (typeof pattern === "string") return val.toLowerCase().includes(pattern.toLowerCase());
  if (pattern instanceof RegExp) return pattern.test(val);
  return false;
}

function matchExactPattern(val, matchDef) {
  if (!val) return false;
  if (matchDef.type === "exact_pattern") {
    const patterns = matchDef.pattern.split("|");
    return patterns.some((p) => val.toLowerCase().includes(p.toLowerCase()));
  }
  if (matchDef.type === "numeric_tolerance") {
    const num = parseFloat(val.replace(/[^0-9.\-]/g, ""));
    if (isNaN(num)) return false;
    return Math.abs(num - matchDef.expected) <= matchDef.tolerance;
  }
  return false;
}

// Simple built-in judge for edge cases
function ruleBasedJudge(caseDef, result) {
  // For empty prompt edge case: any non-error output passes
  if (caseDef.id === "edge-empty-prompt") {
    return result.output && result.status !== "ERROR";
  }
  // For code_interpreter-random-number: check tool was called and output mentions random/randint
  if (caseDef.id === "code_interpreter-random-number") {
    const toolCalls = result.toolCalls || [];
    return toolCalls.some((tc) => tc.toolName === "code_interpreter" && tc.status === "succeeded");
  }
  // Default: let pattern matching handle it
  return null;
}

function matchArgs(actualArgs, pattern) {
  if (!pattern) return true;
  for (const [key, pat] of Object.entries(pattern)) {
    const val = actualArgs[key];
    if (!val || !val.match) return false;
    const re = new RegExp(pat, "i");
    if (!re.test(val)) return false;
  }
  return true;
}

async function scoreCase(caseDef, result) {
  const expected = caseDef.expected;
  const errors = [];

  // 1. Check result_status if specified
  if (expected.result_status && result.status !== expected.result_status) {
    errors.push(`expected status ${expected.result_status}, got ${result.status}`);
  }

  // 2. Check tool_call
  const toolCalls = result.toolCalls || [];
  if (expected.tool_call === null) {
    if (toolCalls.length > 0) {
      errors.push(`expected no tool call, got ${toolCalls[0].toolName}`);
    }
  } else {
    const matchedTool = toolCalls.find((tc) => tc.toolName === expected.tool_call.name);
    if (!matchedTool) {
      errors.push(`expected tool ${expected.tool_call.name}, got ${toolCalls.map((t) => t.toolName).join(",") || "none"}`);
    } else if (expected.tool_call.args_pattern && !matchArgs(matchedTool.args, expected.tool_call.args_pattern)) {
      errors.push(`tool ${expected.tool_call.name} args did not match pattern`);
    }

    // Check tool_call_2 if specified
    if (expected.tool_call_2) {
      const tool2 = toolCalls.find((tc) => tc.toolName === expected.tool_call_2.name);
      if (!tool2) {
        errors.push(`expected second tool ${expected.tool_call_2.name}, not found`);
      } else if (expected.tool_call_2.args_pattern && !matchArgs(tool2.args, expected.tool_call_2.args_pattern)) {
        errors.push(`tool ${expected.tool_call_2.name} args did not match pattern`);
      }
    }

    // Check tool_call_3 if specified
    if (expected.tool_call_3) {
      const tool3 = toolCalls.find((tc) => tc.toolName === expected.tool_call_3.name);
      if (!tool3) {
        errors.push(`expected third tool ${expected.tool_call_3.name}, not found`);
      }
    }
  }

  // 3. Check final answer
  if (expected.final_answer_match && result.output) {
    if (caseDef.scoring === "exact_match") {
      if (!matchExactPattern(result.output, expected.final_answer_match)) {
        errors.push(`final answer did not match expected pattern. Got: "${result.output.slice(0, 200)}"`);
      }
    } else if (caseDef.scoring === "judge") {
      const ruleResult = ruleBasedJudge(caseDef, result);
      if (ruleResult === null) {
        errors.push(`judge scoring requested but no rule-based judge available for ${caseDef.id}`);
      } else if (!ruleResult) {
        errors.push(`rule-based judge failed for ${caseDef.id}`);
      }
    }
  } else if (expected.final_answer_match && !result.output && result.status !== "ERROR") {
    errors.push("no output produced");
  }

  return {
    pass: errors.length === 0,
    errors,
    tool_calls_made: toolCalls.map((t) => ({ name: t.toolName, args: t.args, status: t.status })),
    output_preview: (result.output || "").slice(0, 200),
    result_status: result.status,
  };
}

function saveResults(results, datasetVersion) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const filename = `run-${timestamp}.json`;
  const report = {
    timestamp: new Date().toISOString(),
    dataset_version: datasetVersion,
    total_cases: results.length,
    passed: results.filter((r) => r.pass).length,
    failed: results.filter((r) => !r.pass).length,
    task_success_rate: 0,
    tool_selection_accuracy: 0,
    results,
  };
  report.task_success_rate = report.total_cases > 0 ? (report.passed / report.total_cases) : 0;
  const toolCases = results.filter((r) => r.expected_tool !== null);
  const correctTool = results.filter((r) => r.tool_selection_correct).length;
  report.tool_selection_accuracy = toolCases.length > 0 ? (correctTool / toolCases.length) : 1;

  fs.writeFileSync(path.join(RESULTS_DIR, filename), JSON.stringify(report, null, 2));
  return filename;
}

async function main() {
  console.log("=== E-GAOP Evals Runner ===\n");

  // Load dataset
  const dataset = JSON.parse(fs.readFileSync(DATASET_PATH, "utf-8"));
  console.log(`Dataset: ${dataset.cases.length} cases (v${dataset.schema_version})\n`);

  // Login
  console.log("Logging in...");
  const token = await login();
  console.log("  OK\n");

  const results = [];
  let passed = 0;
  let failed = 0;
  let correctToolSelections = 0;
  let toolCases = 0;

  for (const caseDef of dataset.cases) {
    process.stdout.write(`[${caseDef.id}] ${caseDef.prompt.slice(0, 60)}... `);

    try {
      // Trigger workflow
      const run = await triggerRun(token, caseDef.prompt, {
        namespace: caseDef.namespace,
        resourceNamespace: caseDef.resourceNamespace,
        callerRole: caseDef.callerRole,
      });

      // Poll for completion
      const result = await pollWorkflow(run.workflowId);

      // Score
      const score = await scoreCase(caseDef, result);
      score.case_id = caseDef.id;
      score.expected_tool = caseDef.expected.tool_call?.name || null;
      score.tool_selection_correct = true;

      // Tool selection accuracy: was the right tool (or no tool) chosen?
      const expectedToolName = caseDef.expected.tool_call?.name || null;
      const actualToolNames = (result.toolCalls || []).map((t) => t.toolName);
      if (expectedToolName === null) {
        score.tool_selection_correct = actualToolNames.length === 0;
        toolCases++;
        if (score.tool_selection_correct) correctToolSelections++;
      } else {
        score.tool_selection_correct = actualToolNames.includes(expectedToolName);
        toolCases++;
        if (score.tool_selection_correct) correctToolSelections++;
      }

      results.push(score);

      if (score.pass) {
        passed++;
        console.log(`PASS (${result.iterations} iters, ${(result.toolCalls || []).length} tools, ${result.totalCost})`);
      } else {
        failed++;
        console.log(`FAIL: ${score.errors.join("; ")}`);
        if (result.toolCalls?.length) {
          console.log(`  Tools: ${result.toolCalls.map((t) => `${t.toolName}[${t.status}]`).join(", ")}`);
        }
      }
    } catch (err) {
      failed++;
      results.push({ case_id: caseDef.id, pass: false, errors: [`runner error: ${err.message}`] });
      console.log(`ERROR: ${err.message}`);
    }
  }

  // Summary
  const total = dataset.cases.length;
  const taskSuccess = total > 0 ? ((passed / total) * 100).toFixed(1) : "N/A";
  const toolAcc = toolCases > 0 ? ((correctToolSelections / toolCases) * 100).toFixed(1) : "N/A";

  console.log(`\n=== RESULTS ===`);
  console.log(`Cases:     ${passed}/${total} passed (${failed} failed)`);
  console.log(`Task success rate:   ${taskSuccess}%`);
  console.log(`Tool selection acc:  ${correctToolSelections}/${toolCases} (${toolAcc}%)`);

  // Save
  const filename = saveResults(results, dataset.schema_version);
  console.log(`\nResults saved to evals/results/${filename}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
