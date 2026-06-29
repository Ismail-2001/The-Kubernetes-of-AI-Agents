import fs from "fs";
import path from "path";

const ROOT = path.resolve(__dirname, "..");
const SERVICES = [
  "control-plane/api-server",
  "control-plane/secret-store",
  "control-plane/workflow-engine",
  "execution-plane/llm-router",
  "execution-plane/tool-proxy",
  "execution-plane/sandbox-runtime",
  "memory-plane",
  "observability-plane",
  "policy-plane",
];

interface MigrationIssue {
  file: string;
  line: number;
  pattern: string;
  description: string;
}

function scanFile(filePath: string): MigrationIssue[] {
  const issues: MigrationIssue[] = [];
  let content: string;
  try {
    content = fs.readFileSync(filePath, "utf8");
  } catch {
    return issues;
  }
  const lines = content.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const lineNum = i + 1;

    if (/function\s+getServerCredentials\s*\(/.test(line)) {
      issues.push({
        file: filePath,
        line: lineNum,
        pattern: "getServerCredentials",
        description: "Replace with: import { getServerCredentials } from '../../shared/tls.js' or shared module",
      });
    }

    if (/HEALTH_SERVICE\s*:\s*grpc\.ServiceDefinition/.test(line)) {
      issues.push({
        file: filePath,
        line: lineNum,
        pattern: "HEALTH_SERVICE",
        description: "Replace with shared HEALTH_SERVICE definition",
      });
    }

    if (/class\s+RateLimiter/.test(line)) {
      issues.push({
        file: filePath,
        line: lineNum,
        pattern: "RateLimiter",
        description: "Replace with: import { RateLimiter } from '@e-gaop/shared'",
      });
    }

    if (/function\s+encrypt\s*\(/.test(line) || /function\s+decrypt\s*\(/.test(line)) {
      issues.push({
        file: filePath,
        line: lineNum,
        pattern: "encrypt/decrypt",
        description: "Replace with: import { encrypt, decrypt } from '@e-gaop/shared'",
      });
    }

    if (/function\s+deriveKey\s*\(/.test(line)) {
      issues.push({
        file: filePath,
        line: lineNum,
        pattern: "deriveKey",
        description: "Consider replacing with shared crypto utilities",
      });
    }

    if (/new\s+pino\s*\(/.test(line) && /NODE_ENV\s*===\s*["']test["']/.test(lines.slice(Math.max(0, i - 2), i + 3).join("\n"))) {
      issues.push({
        file: filePath,
        line: lineNum,
        pattern: "pino logger setup",
        description: "Consider extracting to shared logger factory",
      });
    }

    if (/protoLoader\.loadSync\s*\(/.test(line)) {
      issues.push({
        file: filePath,
        line: lineNum,
        pattern: "protoLoader.loadSync",
        description: "Proto loading pattern - may benefit from shared helper",
      });
    }
  }

  return issues;
}

console.log("=== E-GAOP Migration to Shared Module Report ===\n");

let totalIssues = 0;

for (const service of SERVICES) {
  const serviceDir = path.join(ROOT, service, "src");
  if (!fs.existsSync(serviceDir)) {
    console.log(`[SKIP] ${service}: src/ directory not found\n`);
    continue;
  }

  const files = getAllTsFiles(serviceDir);
  const serviceIssues: MigrationIssue[] = [];

  for (const file of files) {
    serviceIssues.push(...scanFile(file));
  }

  if (serviceIssues.length === 0) {
    console.log(`[OK] ${service}: No duplication patterns found\n`);
    continue;
  }

  totalIssues += serviceIssues.length;
  console.log(`[MIGRATE] ${service}: ${serviceIssues.length} issue(s) found`);
  for (const issue of serviceIssues) {
    const relPath = path.relative(ROOT, issue.file);
    console.log(`  ${relPath}:${issue.line} - ${issue.pattern}`);
    console.log(`    -> ${issue.description}`);
  }
  console.log();
}

console.log(`\n=== Summary ===`);
console.log(`Total issues found: ${totalIssues}`);
console.log(`Services to migrate: ${SERVICES.length}`);
console.log(`\nManual steps required:`);
console.log(`1. Add @e-gaop/shared workspace dependency to each service's package.json`);
console.log(`2. Add tsconfig paths for @e-gaop/shared`);
console.log(`3. Replace duplicated code with shared imports`);
console.log(`4. Run typecheck in each service to verify`);

function getAllTsFiles(dir: string): string[] {
  const results: string[] = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...getAllTsFiles(fullPath));
    } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) {
      results.push(fullPath);
    }
  }
  return results;
}
