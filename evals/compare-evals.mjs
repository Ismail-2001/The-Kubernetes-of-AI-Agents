// compare-evals.mjs — Compare two eval runs and report regression/improvement
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const [aLabel, bLabel] = process.argv.slice(2);
if (!aLabel || !bLabel) {
  console.error("Usage: node compare-evals.mjs <baseline-name> <comparison-name>");
  console.error("Files: evals/baselines/<name>.json or evals/baselines/results/*.json");
  process.exit(1);
}

function load(label) {
  const p = path.resolve(__dirname, "baselines", `${label}.json`);
  if (!fs.existsSync(p)) {
    // Try results directory
    const rp = path.resolve(__dirname, "results", `${label}.json`);
    if (!fs.existsSync(rp)) {
      console.error(`File not found: ${p} or ${rp}`);
      process.exit(1);
    }
    return JSON.parse(fs.readFileSync(rp, "utf-8"));
  }
  return JSON.parse(fs.readFileSync(p, "utf-8"));
}

const A = load(aLabel);
const B = load(bLabel);

console.log(`=== Eval Comparison: ${aLabel} vs ${bLabel} ===\n`);

const aPassed = A.results.filter((r) => r.pass).length;
const bPassed = B.results.filter((r) => r.pass).length;
const total = A.results.length;

console.log(`               ${aLabel}    ${bLabel}    Δ`);
console.log(`Passed        ${aPassed}/${total}    ${bPassed}/${total}    ${bPassed - aPassed >= 0 ? '+' : ''}${bPassed - aPassed}`);
console.log(`Task rate     ${(aPassed/total*100).toFixed(1)}%    ${(bPassed/total*100).toFixed(1)}%    ${(bPassed - aPassed > 0 ? '+' : '')}${(bPassed/total*100 - aPassed/total*100).toFixed(1)}%`);

const aToolSel = A.results.filter((r) => r.tool_selection_correct).length;
const bToolSel = B.results.filter((r) => r.tool_selection_correct).length;
const totalCases = A.results.length;
const aToolPct = totalCases > 0 ? Math.min((aToolSel / totalCases) * 100, 100).toFixed(1) : "N/A";
const bToolPct = totalCases > 0 ? Math.min((bToolSel / totalCases) * 100, 100).toFixed(1) : "N/A";
console.log(`Tool sel acc  ${aToolSel}/${totalCases} (${aToolPct}%)    ${bToolSel}/${totalCases} (${bToolPct}%)`);

// Per-case breakdown
console.log(`\n--- Per-case breakdown ---`);
const aMap = {};
A.results.forEach((r) => { aMap[r.case_id] = r; });
const bMap = {};
B.results.forEach((r) => { bMap[r.case_id] = r; });

const allCaseIds = [...new Set([...Object.keys(aMap), ...Object.keys(bMap)])];
allCaseIds.sort();

let regressions = 0;
let improvements = 0;

for (const id of allCaseIds) {
  const aR = aMap[id];
  const bR = bMap[id];
  if (!aR) { console.log(`  ${id}: NEW in ${bLabel} — ${bR.pass ? "PASS" : "FAIL"}`); continue; }
  if (!bR) { console.log(`  ${id}: removed in ${bLabel}`); continue; }

  const aPass = aR.pass;
  const bPass = bR.pass;
  const symbol = aPass === bPass ? " " : (bPass ? "↑" : "↓");
  if (!aPass && bPass) improvements++;
  if (aPass && !bPass) regressions++;

  const errorsA = aR.errors?.length ? aR.errors.join("; ").slice(0, 60) : "";
  const errorsB = bR.errors?.length ? bR.errors.join("; ").slice(0, 60) : "";
  console.log(`  ${symbol} ${id}: ${aPass ? "PASS" : "FAIL"} → ${bPass ? "PASS" : "FAIL"}${errorsB ? ` (${errorsB})` : ""}`);
}

console.log(`\nRegressions:  ${regressions}`);
console.log(`Improvements: ${improvements}`);
console.log(`Net change:   ${improvements - regressions >= 0 ? '+' : ''}${improvements - regressions}`);
