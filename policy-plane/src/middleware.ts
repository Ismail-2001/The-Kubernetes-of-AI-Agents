import crypto from "crypto";
import * as grpc from "@grpc/grpc-js";
import { PolicyPlaneService, type PolicyInput, type PolicyDecision } from "./service";

// ─── Types ────────────────────────────────────────────────────────────────

interface AgentClaims {
  sub?: string;
  namespace?: string;
  clearance?: number;
  agentId?: string;
  [key: string]: unknown;
}

interface PolicyInterceptorOptions {
  policyPath: string;
  jwtSecret?: string;
}

interface PeerInfo {
  CN: string;
  organization?: string;
}

// ─── JWT Verification (HS256) ─────────────────────────────────────────────

function base64UrlDecode(segment: string): Buffer {
  const base64 = segment.replace(/-/g, "+").replace(/_/g, "/");
  const padding = base64.length % 4 === 0 ? "" : "=".repeat(4 - (base64.length % 4));
  return Buffer.from(base64 + padding, "base64");
}

function verifyHS256JWT(
  token: string,
  secret: string
): { valid: boolean; payload: Record<string, unknown> | null; error?: string } {
  const parts = token.split(".");
  if (parts.length !== 3) {
    return { valid: false, payload: null, error: "Invalid JWT structure" };
  }

  const [headerB64, payloadB64, signatureB64] = parts as [string, string, string];

  try {
    const header = JSON.parse(base64UrlDecode(headerB64).toString("utf8"));
    if (header.alg !== "HS256") {
      return { valid: false, payload: null, error: `Unsupported algorithm: ${header.alg}` };
    }
  } catch {
    return { valid: false, payload: null, error: "Invalid JWT header" };
  }

  const data = `${headerB64}.${payloadB64}`;
  const expectedSig = crypto.createHmac("sha256", secret).update(data).digest("base64url");
  const actualSig = signatureB64.replace(/-/g, "+").replace(/_/g, "/");
  const expectedSigBase64 = expectedSig.replace(/-/g, "+").replace(/_/g, "/");

  if (actualSig !== expectedSigBase64) {
    return { valid: false, payload: null, error: "Invalid signature" };
  }

  try {
    const payload = JSON.parse(base64UrlDecode(payloadB64).toString("utf8"));
    return { valid: true, payload };
  } catch {
    return { valid: false, payload: null, error: "Invalid JWT payload" };
  }
}

// ─── Peer Certificate Parsing ─────────────────────────────────────────────

function extractPeerInfo(call: grpc.ServerUnaryCall<unknown, unknown>): PeerInfo {
  const peer = call.getPeer();
  const peerInfo: PeerInfo = { CN: "unknown" };

  if (!peer) return peerInfo;

  const cnMatch = peer.match(/CN=([^,/]+)/);
  if (cnMatch?.[1]) {
    peerInfo.CN = cnMatch[1];
  }

  const orgMatch = peer.match(/O=([^,/]+)/);
  if (orgMatch?.[1]) {
    peerInfo.organization = orgMatch[1];
  }

  return peerInfo;
}

function extractNamespaceFromCN(cn: string): string {
  const parts = cn.split(".");
  return parts.length > 1 ? parts[1] ?? "default" : "default";
}

// ─── Metadata Extraction ──────────────────────────────────────────────────

function extractClaims(
  call: grpc.ServerUnaryCall<unknown, unknown>,
  jwtSecret?: string
): AgentClaims {
  const metadata = call.metadata as grpc.Metadata;
  const claimsRaw = metadata.get("x-agent-claims");

  if (!claimsRaw || claimsRaw.length === 0) {
    return {};
  }

  const claimsStr = typeof claimsRaw[0] === "string"
    ? claimsRaw[0]
    : Buffer.isBuffer(claimsRaw[0])
      ? claimsRaw[0].toString("utf8")
      : String(claimsRaw[0]);

  if (jwtSecret) {
    const result = verifyHS256JWT(claimsStr, jwtSecret);
    if (!result.valid) {
      process.stderr.write(
        JSON.stringify({
          timestamp: new Date().toISOString(),
          level: "warn",
          message: `JWT verification failed: ${result.error}`,
        }) + "\n"
      );
      return {};
    }
    return (result.payload ?? {}) as AgentClaims;
  }

  try {
    return JSON.parse(claimsStr) as AgentClaims;
  } catch {
    return {};
  }
}

// ─── Helper: Create ServiceError ──────────────────────────────────────────

function createServiceError(
  message: string,
  code: number,
  details: string,
  action: string,
  agentId: string
): grpc.ServiceError {
  const metadata = new grpc.Metadata();
  metadata.set("egaop-policy-reason", details);
  metadata.set("egaop-policy-action", action);
  metadata.set("egaop-agent-id", agentId);

  const error = new Error(message) as grpc.ServiceError;
  error.code = code;
  error.details = details;
  error.metadata = metadata;
  return error;
}

// ─── gRPC Interceptor ─────────────────────────────────────────────────────

function createPolicyInterceptor(options: PolicyInterceptorOptions) {
  const service = PolicyPlaneService.getInstance();
  const jwtSecret = options.jwtSecret ?? process.env.JWT_SECRET;

  return function policyInterceptor<TRequest, TResponse>(
    call: grpc.ServerUnaryCall<TRequest, TResponse>,
    metadata: grpc.Metadata,
    next: (
      metadata: grpc.Metadata,
      call: grpc.ServerUnaryCall<TRequest, TResponse>
    ) => void
  ): void {
    const peerInfo = extractPeerInfo(call as grpc.ServerUnaryCall<unknown, unknown>);
    const claims = extractClaims(
      call as grpc.ServerUnaryCall<unknown, unknown>,
      jwtSecret
    );
    const namespace = claims.namespace ?? extractNamespaceFromCN(peerInfo.CN);

    const input: PolicyInput = {
      subject: {
        namespace,
        clearance: typeof claims.clearance === "number" ? claims.clearance : 0,
        cn: peerInfo.CN,
        organization: peerInfo.organization,
      },
      action: "unknown",
      resource: {
        namespace,
      },
      namespace,
      agentId: (claims.agentId as string) ?? "unknown",
      claims: claims as Record<string, unknown>,
    };

    service
      .evaluatePolicy(options.policyPath, input)
      .then((decision: PolicyDecision) => {
        if (!decision.allow) {
          const error = createServiceError(
            `Policy denied: ${decision.reason}`,
            grpc.status.PERMISSION_DENIED,
            decision.reason,
            input.action,
            input.agentId
          );
          (call as unknown as { callback: (err: grpc.ServiceError) => void }).callback(error);
          return;
        }
        next(metadata, call);
      })
      .catch((err: unknown) => {
        if (
          err &&
          typeof err === "object" &&
          "code" in err &&
          (err as { code: unknown }).code === grpc.status.PERMISSION_DENIED
        ) {
          (call as unknown as { callback: (err: grpc.ServiceError) => void }).callback(
            err as grpc.ServiceError
          );
          return;
        }

        const message = err instanceof Error ? err.message : String(err);
        const serviceError = createServiceError(
          `Policy evaluation failed: ${message}`,
          grpc.status.PERMISSION_DENIED,
          message,
          input.action,
          input.agentId
        );
        (call as unknown as { callback: (err: grpc.ServiceError) => void }).callback(serviceError);
      });
  };
}

export {
  createPolicyInterceptor,
  verifyHS256JWT,
  extractPeerInfo,
  extractClaims,
  extractNamespaceFromCN,
  type AgentClaims,
  type PolicyInterceptorOptions,
  type PeerInfo,
};
