export const NAMESPACE_METADATA_KEY = "x-egaop-namespace";

// DNS-1123 label subset; same shape the namespace-enforcement interceptor validates.
const NAMESPACE_RE = /^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/;

export function isValidNamespace(ns: string): boolean {
  return NAMESPACE_RE.test(ns);
}

function metadataValue(call: unknown, key: string): string | null {
  const md = (call as { metadata?: { get(k: string): Array<string | Buffer> } }).metadata;
  const raw = md?.get(key)?.[0];
  if (raw === undefined || raw === null) return null;
  return String(raw).trim();
}

export function namespaceError(message: string): Error & { code: number } {
  const err = new Error(message) as Error & { code: number };
  err.code = 3; // grpc INVALID_ARGUMENT
  return err;
}

/** Fail-closed: the x-egaop-namespace call metadata must be present and well-formed. */
export function requireNamespace(call: unknown): string {
  const ns = metadataValue(call, NAMESPACE_METADATA_KEY);
  if (!ns || !isValidNamespace(ns)) {
    throw namespaceError(
      `Missing or invalid ${NAMESPACE_METADATA_KEY} metadata on namespace-scoped RPC`,
    );
  }
  return ns;
}

/**
 * Metadata namespace is authoritative. A body `namespace` that disagrees with it
 * is treated as a cross-namespace probe: callers must scope to `namespace` and
 * apply their method's empty/not-found response for `crossNamespace`.
 */
export function resolveScope(
  call: unknown,
  bodyNamespace?: unknown,
): { namespace: string; crossNamespace: boolean } {
  const metaNs = requireNamespace(call);
  const bodyNs =
    typeof bodyNamespace === "string" && bodyNamespace.length > 0 ? bodyNamespace : undefined;
  if (bodyNs !== undefined && bodyNs !== metaNs) {
    return { namespace: metaNs, crossNamespace: true };
  }
  return { namespace: metaNs, crossNamespace: false };
}
