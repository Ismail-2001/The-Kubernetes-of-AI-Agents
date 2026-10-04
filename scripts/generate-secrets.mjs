#!/usr/bin/env node
/**
 * generate-secrets.mjs — Build the GitHub Actions secrets paste-block for E-GAOP.
 *
 * Writes   : secrets/github-secrets.env   (gitignored — NEVER commit)
 * Prints   : paste-ready block + setup instructions
 *
 * Usage:
 *   node scripts/generate-secrets.mjs           # first run (aborts if file exists)
 *   node scripts/generate-secrets.mjs --force   # rotate: overwrite existing file
 *
 * Formats follow docs/SECRETS.md (openssl-equivalent, cross-platform):
 *   hex32     -> openssl rand -hex 32      (64 chars,  for JWT / master key / token)
 *   base64    -> openssl rand -base64 N    (passwords)
 * Manual values (you fill these in GitHub UI):
 *   OPENAI_API_KEY, SLACK_WEBHOOK, AZURE_* (from docs/AZURE-SETUP.md Step 4)
 */
import { randomBytes } from "node:crypto";
import { writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = resolve(ROOT, "secrets", "github-secrets.env");
const FORCE = process.argv.includes("--force");

if (existsSync(OUT) && !FORCE) {
  console.error(`ERROR: ${OUT} already exists.`);
  console.error("Refusing to overwrite an un-pasted secret set. Use --force to rotate.");
  process.exit(1);
}

const hex32 = () => randomBytes(32).toString("hex"); // 64-char hex
const b64 = (bytes) => randomBytes(bytes).toString("base64");

const PLACEHOLDER = "REPLACE_"; // marker for values that must be filled manually

const secrets = [
  // ── App secrets (deploy.yml + helm values-single-node.yaml) ────────────────
  ["POSTGRES_PASSWORD", b64(24)],
  ["REDIS_PASSWORD", b64(24)],
  ["JWT_SECRET", hex32()],
  ["EGAOP_MASTER_ENCRYPTION_KEY", hex32()],
  ["INTERNAL_SERVICE_TOKEN", hex32()],
  ["GRAFANA_PASSWORD", b64(16)],
  ["OPENAI_API_KEY", `${PLACEHOLDER}WITH_YOUR_OPENAI_KEY`],
  ["SLACK_WEBHOOK", `${PLACEHOLDER}WITH_SLACK_WEBHOOK`],
  // ── Azure OIDC federation (docs/AZURE-SETUP.md Step 4) ─────────────────────
  ["AZURE_CLIENT_ID", `${PLACEHOLDER}AZURE_CLIENT_ID`],
  ["AZURE_TENANT_ID", `${PLACEHOLDER}AZURE_TENANT_ID`],
  ["AZURE_SUBSCRIPTION_ID", `${PLACEHOLDER}AZURE_SUBSCRIPTION_ID`],
];

mkdirSync(dirname(OUT), { recursive: true });
const body = secrets.map(([k, v]) => `${k}=${v}`).join("\n") + "\n";
writeFileSync(OUT, body, { mode: 0o600 });

const manual = secrets.filter(([, v]) => v.startsWith(PLACEHOLDER)).map(([k]) => k);
const generated = secrets.filter(([, v]) => !v.startsWith(PLACEHOLDER)).map(([k]) => k);

console.log(`Wrote ${secrets.length} secrets -> ${OUT}  (gitignored, mode 600)`);
console.log("");
console.log("─── PASTE BLOCK (open the file, or copy below) ─────────────────────");
console.log(body);
console.log("────────────────────────────────────────────────────────────────────");
console.log("");
console.log("Next steps:");
console.log("  1. GitHub repo -> Settings -> Secrets and variables -> Actions");
console.log("     https://github.com/Ismail-2001/The-Kubernetes-of-AI-Agents/settings/secrets/actions");
console.log("  2. Add each NAME/value as a repository secret (11 total).");
console.log(`  3. MANUAL values to fill in yourself: ${manual.join(", ")}`);
console.log("       - OPENAI_API_KEY      : https://platform.openai.com/api-keys");
console.log("       - SLACK_WEBHOOK       : https://api.slack.com/messaging/webhooks (free workspace)");
console.log("       - AZURE_*             : printed by docs/AZURE-SETUP.md Step 4 (Cloud Shell)");
console.log(`  4. Auto-generated (keep private): ${generated.length} values — do not re-share.`);
console.log("  5. Environments: create 'staging' (no rules) + 'production' (required reviewer).");
console.log("");
console.log("SECURITY: secrets/github-secrets.env is inside gitignored secrets/ —");
console.log("never commit it, never paste it into issues/PRs/chat logs.");
