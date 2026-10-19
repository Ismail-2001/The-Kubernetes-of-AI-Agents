// P1-4: memory-plane HTTP service-token verification.
// Extracted from index.ts so the fail-closed contract is unit-testable
// without starting HTTP/gRPC/Redis.
import crypto from "crypto";

export function verifyServiceToken(req: { headers: Record<string, string | string[] | undefined> }): boolean {
  const expectedToken = process.env.INTERNAL_SERVICE_TOKEN ?? "";
  // Fail closed: an unset expected token must NOT grant access.
  if (!expectedToken) return false;
  const provided = (req.headers["x-service-token"] as string) ?? "";
  const a = Buffer.from(expectedToken);
  const b = Buffer.from(provided);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
