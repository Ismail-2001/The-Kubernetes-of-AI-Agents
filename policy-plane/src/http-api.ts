import http from "http";
import { z } from "zod";
import { PolicyPlaneService, type PolicyInput } from "./service";

// ─── Request Schema ───────────────────────────────────────────────────────
//
// Mirrors what control-plane/workflow-engine actually POSTs today:
//   { input: { subject: { namespace, clearance }, action, resource: { namespace } } }
// Optional top-level fields (namespace/agentId/claims) are accepted but not
// required; missing values are normalized before cache hashing so partial
// callers cannot collide with each other.

const PolicyRequestSchema = z.object({
  input: z
    .object({
      subject: z
        .object({
          namespace: z.string().min(1),
          clearance: z.number().int().min(0).max(5),
        })
        .passthrough(),
      action: z.string().min(1),
      resource: z
        .object({
          namespace: z.string().min(1),
          pii_detected: z.boolean().optional(),
        })
        .passthrough(),
      namespace: z.string().min(1).optional(),
      agentId: z.string().min(1).optional(),
      claims: z.record(z.unknown()).optional(),
    })
    .passthrough(),
});

// Only serve the three policy packages that exist on disk
// (policy-plane/policies/{agent_execution,admission/agent_creation,runtime/tool_call}.rego).
// Anything else is 404 — never an open proxy to arbitrary OPA data.
const ALLOWED_POLICY_PATHS = new Set([
  "egaop/execution",
  "egaop/admission",
  "egaop/runtime",
]);

const MAX_BODY_BYTES = 256 * 1024;

function normalizeInput(
  raw: z.infer<typeof PolicyRequestSchema>["input"]
): PolicyInput {
  return {
    subject: raw.subject,
    action: raw.action,
    resource: raw.resource,
    namespace: raw.namespace ?? raw.subject.namespace,
    agentId: raw.agentId ?? "unknown",
    claims: raw.claims ?? {},
  };
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("payload too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function sendJSON(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(payload);
}

// ─── Handler Factory ──────────────────────────────────────────────────────

export function createPolicyHttpHandler(
  getService: () => PolicyPlaneService = () => PolicyPlaneService.getInstance()
): (req: http.IncomingMessage, res: http.ServerResponse) => void {
  return (req, res) => {
    void handle(req, res, getService).catch(() => {
      if (!res.headersSent) {
        sendJSON(res, 500, { error: "internal error" });
      } else {
        res.end();
      }
    });
  };
}

async function handle(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  getService: () => PolicyPlaneService
): Promise<void> {
  const url = req.url ?? "/";

  if (url === "/healthz" || url === "/readyz") {
    const stats = getService().getStats();
    const status = stats.circuitState === "OPEN" ? "NOT_SERVING" : "SERVING";
    const code = stats.circuitState === "OPEN" ? 503 : 200;
    sendJSON(res, code, {
      status,
      service: "policy-plane",
      circuit_breaker: stats.circuitState,
      cache_size: stats.cacheSize,
      timestamp: new Date().toISOString(),
    });
    return;
  }

  if (url.startsWith("/v1/data/")) {
    if (req.method !== "POST") {
      res.writeHead(405, { Allow: "POST" });
      res.end();
      return;
    }

    const policyPath = url.slice("/v1/data/".length).replace(/\/+$/, "");
    if (!ALLOWED_POLICY_PATHS.has(policyPath)) {
      sendJSON(res, 404, { error: `unknown policy path: ${policyPath}` });
      return;
    }

    let raw: string;
    try {
      raw = await readBody(req);
    } catch {
      sendJSON(res, 413, { error: "payload too large" });
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      sendJSON(res, 400, { error: "invalid JSON" });
      return;
    }

    const validated = PolicyRequestSchema.safeParse(parsed);
    if (!validated.success) {
      // Fail-closed: 400 → workflow-engine treats non-2xx as deny.
      sendJSON(res, 400, {
        error: "invalid policy input",
        details: validated.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
      });
      return;
    }

    const input = normalizeInput(validated.data.input);
    const decision = await getService().evaluatePolicy(policyPath, input);
    // OPA data-API shape so workflow-engine's existing client code works unchanged.
    sendJSON(res, 200, { result: { allow: decision.allow, reason: decision.reason } });
    return;
  }

  res.writeHead(404);
  res.end();
}
