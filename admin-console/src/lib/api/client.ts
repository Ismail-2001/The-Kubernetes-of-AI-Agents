import type { ApiResponse, ApiErrorData } from "@/lib/types";

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://api-server:3000";

export class ApiError extends Error {
  public readonly code: string;
  public readonly traceId: string;
  public readonly status: number;

  constructor(message: string, status: number, traceId: string, code: string) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.traceId = traceId;
    this.status = status;
  }
}

interface DedupEntry {
  promise: Promise<unknown>;
  timestamp: number;
}

const dedupCache = new Map<string, DedupEntry>();
const DEDUP_WINDOW_MS = 100;

function getDedupeKey(url: string, init: RequestInit): string | null {
  if (init.method && init.method !== "GET") return null;
  return url;
}

function cleanupDedup(): void {
  const now = Date.now();
  for (const [key, entry] of dedupCache) {
    if (now - entry.timestamp > DEDUP_WINDOW_MS * 2) {
      dedupCache.delete(key);
    }
  }
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function apiRequest<T>(
  endpoint: string,
  options: RequestInit = {}
): Promise<ApiResponse<T>> {
  const url = endpoint.startsWith("http") ? endpoint : `${API_BASE}${endpoint}`;
  const dedupKey = getDedupeKey(url, options);

  if (dedupKey) {
    cleanupDedup();
    const existing = dedupCache.get(dedupKey);
    if (existing && Date.now() - existing.timestamp < DEDUP_WINDOW_MS) {
      return existing.promise as Promise<ApiResponse<T>>;
    }
  }

  const promise = executeRequest<T>(url, options);

  if (dedupKey) {
    dedupCache.set(dedupKey, { promise, timestamp: Date.now() });
  }

  try {
    return await promise;
  } finally {
    if (dedupKey) {
      dedupCache.delete(dedupKey);
    }
  }
}

async function executeRequest<T>(
  url: string,
  init: RequestInit,
  attempt: number = 1,
  maxAttempts: number = 3
): Promise<ApiResponse<T>> {
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "application/json");

  const res = await fetch(url, { ...init, headers, credentials: "include" });

  if (res.status === 401) {
    if (typeof window !== "undefined") {
      window.location.href = "/login";
    }
    throw new ApiError("Unauthorized", 401, "", "UNAUTHORIZED");
  }

  if (!res.ok) {
    let errorData: ApiErrorData;
    try {
      errorData = await res.json() as ApiErrorData;
    } catch {
      errorData = { message: res.statusText, code: "UNKNOWN_ERROR" };
    }
    const traceId = errorData.meta?.traceId ?? "";

    if (res.status >= 500 && attempt < maxAttempts) {
      const backoffMs = Math.min(1000 * Math.pow(2, attempt - 1), 8000);
      await sleep(backoffMs);
      return executeRequest<T>(url, init, attempt + 1, maxAttempts);
    }

    throw new ApiError(
      errorData.message ?? res.statusText,
      res.status,
      traceId,
      errorData.code ?? "UNKNOWN_ERROR"
    );
  }

  const json = (await res.json()) as ApiResponse<T>;
  return json;
}

export function queryKey(...parts: (string | number | undefined)[]): string[] {
  return parts.filter((p): p is string | number => p !== undefined).map(String);
}
