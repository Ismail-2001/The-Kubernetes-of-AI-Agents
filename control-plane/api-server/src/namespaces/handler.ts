import crypto from "crypto";
import { type Namespace, type NamespaceTierValue, DEFAULT_QUOTAS } from "@e-gaop/shared";
import pino from "pino";

const logger = pino({
  level: process.env.NODE_ENV === "test" ? "silent" : (process.env.LOG_LEVEL || "info"),
  ...(process.env.NODE_ENV !== "production" && process.env.NODE_ENV !== "test" ? {
    transport: { target: "pino-pretty", options: { colorize: true } }
  } : {}),
});

const namespaces = new Map<string, Namespace>();

function generateUUID(): string {
  return crypto.randomUUID();
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function toTimestamp(date: Date): { seconds: number; nanos: number } {
  return {
    seconds: Math.floor(date.getTime() / 1000),
    nanos: (date.getTime() % 1000) * 1_000_000,
  };
}

function toProtoNamespace(ns: Namespace): Record<string, unknown> {
  return {
    id: ns.id,
    slug: ns.slug,
    display_name: ns.displayName,
    tier: `NAMESPACE_TIER_${ns.tier.toUpperCase()}`,
    owner_id: ns.ownerId,
    quotas: {
      max_agents: ns.quotas.maxAgents,
      max_concurrent_executions: ns.quotas.maxConcurrentExecutions,
      max_memory_mb: ns.quotas.maxMemoryMB,
      max_tool_calls_per_minute: ns.quotas.maxToolCallsPerMinute,
    },
    created_at: toTimestamp(ns.createdAt),
    updated_at: toTimestamp(ns.updatedAt),
    suspended_at: ns.suspendedAt ? toTimestamp(ns.suspendedAt) : undefined,
  };
}

function tierFromProto(proto: string): NamespaceTierValue {
  const map: Record<string, NamespaceTierValue> = {
    NAMESPACE_TIER_SANDBOX: "sandbox",
    NAMESPACE_TIER_STANDARD: "standard",
    NAMESPACE_TIER_ENTERPRISE: "enterprise",
    sandbox: "sandbox",
    standard: "standard",
    enterprise: "enterprise",
  };
  return map[proto] ?? "sandbox";
}

export const namespaceHandlers = {
  CreateNamespace: (call: { request: Record<string, unknown> }, callback: (err: Error | null, response?: Record<string, unknown>) => void) => {
    const req = call.request;
    const slug = req.slug as string;
    const tier = tierFromProto(req.tier as string);
    const quotas = req.quotas as Record<string, number> | undefined;
    const defaultQuotas = DEFAULT_QUOTAS[tier];

    const ns: Namespace = {
      id: generateUUID(),
      slug,
      displayName: (req.display_name as string) ?? slug,
      tier,
      ownerId: (req.owner_id as string) ?? "",
      quotas: {
        maxAgents: quotas?.max_agents ?? defaultQuotas.maxAgents,
        maxConcurrentExecutions: quotas?.max_concurrent_executions ?? defaultQuotas.maxConcurrentExecutions,
        maxMemoryMB: quotas?.max_memory_mb ?? defaultQuotas.maxMemoryMB,
        maxToolCallsPerMinute: quotas?.max_tool_calls_per_minute ?? defaultQuotas.maxToolCallsPerMinute,
      },
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    namespaces.set(slug, ns);
    logger.info({ slug, tier, ownerId: ns.ownerId }, "Namespace created");
    callback(null, toProtoNamespace(ns));
  },

  GetNamespace: (call: { request: Record<string, unknown> }, callback: (err: Error | null, response?: Record<string, unknown>) => void) => {
    const slug = call.request.slug as string;
    const ns = namespaces.get(slug);
    if (!ns || ns.deletedAt) {
      callback(new Error(`Namespace not found: ${slug}`));
      return;
    }
    callback(null, toProtoNamespace(ns));
  },

  ListNamespaces: (call: { request: Record<string, unknown> }, callback: (err: Error | null, response?: Record<string, unknown>) => void) => {
    const ownerId = call.request.owner_id as string | undefined;
    const pageSize = Math.min((call.request.page_size as number) || 50, 100);
    const pageToken = (call.request.page_token as string) ?? "";

    let results = Array.from(namespaces.values()).filter((ns) => !ns.deletedAt);
    if (ownerId) {
      results = results.filter((ns) => ns.ownerId === ownerId);
    }

    const startIndex = pageToken
      ? results.findIndex((ns) => ns.id === pageToken) + 1
      : 0;

    const page = results.slice(startIndex, startIndex + pageSize);
    const nextCursor = page.length === pageSize ? page[page.length - 1]!.id : "";

    callback(null, {
      namespaces: page.map(toProtoNamespace),
      next_page_token: nextCursor,
      total_count: results.length,
    });
  },

  UpdateNamespace: (call: { request: Record<string, unknown> }, callback: (err: Error | null, response?: Record<string, unknown>) => void) => {
    const slug = call.request.slug as string;
    const ns = namespaces.get(slug);
    if (!ns || ns.deletedAt) {
      callback(new Error(`Namespace not found: ${slug}`));
      return;
    }

    if (typeof call.request.display_name === "string" && call.request.display_name) {
      ns.displayName = call.request.display_name;
    }

    const quotas = call.request.quotas as Record<string, number> | undefined;
    if (quotas) {
      if (quotas.max_agents !== undefined) ns.quotas.maxAgents = quotas.max_agents;
      if (quotas.max_concurrent_executions !== undefined) ns.quotas.maxConcurrentExecutions = quotas.max_concurrent_executions;
      if (quotas.max_memory_mb !== undefined) ns.quotas.maxMemoryMB = quotas.max_memory_mb;
      if (quotas.max_tool_calls_per_minute !== undefined) ns.quotas.maxToolCallsPerMinute = quotas.max_tool_calls_per_minute;
    }

    ns.updatedAt = new Date();
    namespaces.set(slug, ns);
    logger.info({ slug }, "Namespace updated");
    callback(null, toProtoNamespace(ns));
  },

  SuspendNamespace: (call: { request: Record<string, unknown> }, callback: (err: Error | null, response?: Record<string, unknown>) => void) => {
    const slug = call.request.slug as string;
    const ns = namespaces.get(slug);
    if (!ns || ns.deletedAt) {
      callback(new Error(`Namespace not found: ${slug}`));
      return;
    }

    ns.suspendedAt = new Date();
    ns.updatedAt = new Date();
    namespaces.set(slug, ns);
    logger.warn({ slug, reason: call.request.reason }, "Namespace suspended");
    callback(null, toProtoNamespace(ns));
  },

  DeleteNamespace: (call: { request: Record<string, unknown> }, callback: (err: Error | null, response?: Record<string, unknown>) => void) => {
    const slug = call.request.slug as string;
    const ns = namespaces.get(slug);
    if (!ns || ns.deletedAt) {
      callback(new Error(`Namespace not found: ${slug}`));
      return;
    }

    ns.deletedAt = new Date();
    ns.updatedAt = new Date();
    namespaces.set(slug, ns);
    logger.warn({ slug }, "Namespace soft-deleted");
    callback(null, {});
  },
};
