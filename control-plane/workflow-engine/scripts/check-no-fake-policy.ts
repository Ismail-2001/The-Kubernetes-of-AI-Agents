/**
 * CI Guard: Ensures no hardcoded evaluatePolicy stub exists.
 *
 * This script verifies that the legacy `activities/agent.ts` file
 * (which returned `{ status: 'allow' }` unconditionally) does NOT exist.
 * If it does, the CI build fails with a clear message.
 *
 * Run: npx ts-node scripts/check-no-fake-policy.ts
 */

import fs from "fs";
import path from "path";

const LEGACY_PATH = path.resolve(
  __dirname,
  "..",
  "src",
  "activities",
  "agent.ts"
);

if (fs.existsSync(LEGACY_PATH)) {
  console.error(
    "\n❌ FAIL: Legacy activities/agent.ts still exists!\n" +
      "   This file contains a hardcoded evaluatePolicy stub that always returns allow.\n" +
      "   Delete it and use the real evaluatePolicy in src/temporal/activities/index.ts\n" +
      "   which calls the policy-plane HTTP API.\n"
  );
  process.exit(1);
}

// Also check that no file in src/ contains the hardcoded stub pattern
const srcDir = path.resolve(__dirname, "..", "src");
const files = fs.readdirSync(srcDir, { recursive: true }) as string[];
const tsFiles = files.filter(
  (f): f is string =>
    typeof f === "string" &&
    f.endsWith(".ts") &&
    !f.includes("__tests__") &&
    !f.includes("check-no-fake-policy")
);

for (const file of tsFiles) {
  const fullPath = path.join(srcDir, file);
  const content = fs.readFileSync(fullPath, "utf8");
  if (
    content.includes("return { status: 'allow'") ||
    content.includes('return { status: "allow"')
  ) {
    console.error(
      `\n❌ FAIL: Found hardcoded evaluatePolicy stub in ${file}!\n` +
        "   The evaluatePolicy activity must call the policy-plane HTTP API, not return allow.\n"
    );
    process.exit(1);
  }
}

console.log("✅ PASS: No fake evaluatePolicy stubs found.");
