import { type Namespace, type NamespaceTierValue, DEFAULT_QUOTAS, validateSlug } from "@e-gaop/shared";
import pino from "pino";
import { NamespaceRepository } from "./repository.js";

const logger = pino({
  level: process.env.NODE_ENV === "test" ? "silent" : (process.env.LOG_LEVEL || "info"),
  ...(process.env.NODE_ENV !== "production" && process.env.NODE_ENV !== "test" ? {
    transport: { target: "pino-pretty", options: { colorize: true } }
  } : {}),
});

const repo = new NamespaceRepository();

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
  CreateNamespace: async (call: { request: Record<string, unknown> }, callback: (err: Error | null, response?: Record<string, unknown>) => void) => {
    const req = call.request;
    const slug = req.slug as string;
    const tier = tierFromProto(req.tier as string);
    const quotas = req.quotas as Record<string, number> | undefined;
    const defaultQuotas = DEFAULT_QUOTAS[tier];

    if (!validateSlug(slug)) {
      callback(new Error(`Invalid namespace slug: ${slug}. Must be 3-63 lowercase alphanumeric characters or hyphens.`));
      return;
    }

    try {
      const ns = await repo.create({
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
      });
      logger.info({ slug, tier, ownerId: ns.ownerId }, "Namespace created");
      callback(null, toProtoNamespace(ns));
    } catch (err: any) {
      if (err.code === "23505") {
        callback(new Error(`Namespace already exists: ${slug}`));
      } else {
        callback(new Error(`Failed to create namespace: ${err.message}`));
      }
    }
  },

  GetNamespace: async (call: { request: Record<string, unknown> }, callback: (err: Error | null, response?: Record<string, unknown>) => void) => {
    const slug = call.request.slug as string;
    try {
      const ns = await repo.findBySlug(slug);
      if (!ns) {
        callback(new Error(`Namespace not found: ${slug}`));
        return;
      }
      callback(null, toProtoNamespace(ns));
    } catch (err: any) {
      callback(new Error(`Failed to get namespace: ${err.message}`));
    }
  },

  ListNamespaces: async (call: { request: Record<string, unknown> }, callback: (err: Error | null, response?: Record<string, unknown>) => void) => {
    try {
      const result = await repo.list({
        ownerId: call.request.owner_id as string | undefined,
        pageSize: (call.request.page_size as number) || 50,
        pageToken: (call.request.page_token as string) ?? undefined,
      });
      callback(null, {
        namespaces: result.namespaces.map(toProtoNamespace),
        next_page_token: result.nextPageToken,
        total_count: result.totalCount,
      });
    } catch (err: any) {
      callback(new Error(`Failed to list namespaces: ${err.message}`));
    }
  },

  UpdateNamespace: async (call: { request: Record<string, unknown> }, callback: (err: Error | null, response?: Record<string, unknown>) => void) => {
    const slug = call.request.slug as string;
    try {
      const ns = await repo.update(slug, {
        displayName: typeof call.request.display_name === "string" ? call.request.display_name : undefined,
        quotas: call.request.quotas ? {
          maxAgents: (call.request.quotas as Record<string, number>).max_agents,
          maxConcurrentExecutions: (call.request.quotas as Record<string, number>).max_concurrent_executions,
          maxMemoryMB: (call.request.quotas as Record<string, number>).max_memory_mb,
          maxToolCallsPerMinute: (call.request.quotas as Record<string, number>).max_tool_calls_per_minute,
        } : undefined,
      });
      if (!ns) {
        callback(new Error(`Namespace not found: ${slug}`));
        return;
      }
      logger.info({ slug }, "Namespace updated");
      callback(null, toProtoNamespace(ns));
    } catch (err: any) {
      callback(new Error(`Failed to update namespace: ${err.message}`));
    }
  },

  SuspendNamespace: async (call: { request: Record<string, unknown> }, callback: (err: Error | null, response?: Record<string, unknown>) => void) => {
    const slug = call.request.slug as string;
    try {
      const ns = await repo.suspend(slug);
      if (!ns) {
        callback(new Error(`Namespace not found: ${slug}`));
        return;
      }
      logger.warn({ slug, reason: call.request.reason }, "Namespace suspended");
      callback(null, toProtoNamespace(ns));
    } catch (err: any) {
      callback(new Error(`Failed to suspend namespace: ${err.message}`));
    }
  },

  DeleteNamespace: async (call: { request: Record<string, unknown> }, callback: (err: Error | null, response?: Record<string, unknown>) => void) => {
    const slug = call.request.slug as string;
    try {
      const ns = await repo.softDelete(slug);
      if (!ns) {
        callback(new Error(`Namespace not found: ${slug}`));
        return;
      }
      logger.warn({ slug }, "Namespace soft-deleted");
      callback(null, {});
    } catch (err: any) {
      callback(new Error(`Failed to delete namespace: ${err.message}`));
    }
  },
};
