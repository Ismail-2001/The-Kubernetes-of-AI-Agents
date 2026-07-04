import crypto from "crypto";
import pino from "pino";

const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  transport: process.env.NODE_ENV !== "test" ? {
    target: "pino-pretty",
    options: { colorize: true },
  } : undefined,
});

interface StoredAgent {
  id: string;
  namespace: string;
  name: string;
  apiVersion: string;
  kind: string;
  spec: Record<string, unknown>;
  status: Record<string, unknown>;
  labels: Record<string, string>;
  annotations: Record<string, string>;
  version: number;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
  deletedAt?: Date;
}

const agents = new Map<string, StoredAgent>();

function agentKey(namespace: string, name: string): string {
  return `${namespace}/${name}`;
}

function toTimestamp(date: Date): { seconds: number; nanos: number } {
  return {
    seconds: Math.floor(date.getTime() / 1000),
    nanos: (date.getTime() % 1000) * 1_000_000,
  };
}

function toProtoAgent(agent: StoredAgent): Record<string, unknown> {
  return {
    api_version: agent.apiVersion,
    kind: agent.kind,
    metadata: {
      uid: agent.id,
      name: agent.name,
      namespace: agent.namespace,
      labels: agent.labels ?? {},
      annotations: agent.annotations ?? {},
      version: agent.version,
      created_at: toTimestamp(agent.createdAt),
      updated_at: toTimestamp(agent.updatedAt),
      created_by: agent.createdBy,
    },
    spec: agent.spec,
    status: agent.status,
  };
}

export const agentHandlers = {
  CreateAgent: (call: { request: Record<string, unknown> }, callback: (err: Error | null, response?: Record<string, unknown>) => void) => {
    const req = call.request;
    const metadata = req.metadata as Record<string, unknown> | undefined;
    const name = (metadata?.name as string) ?? `agent-${crypto.randomUUID().slice(0, 8)}`;
    const namespace = (metadata?.namespace as string) ?? "default";
    const key = agentKey(namespace, name);

    if (agents.has(key)) {
      callback(new Error(`Agent already exists: ${namespace}/${name}`));
      return;
    }

    const agent: StoredAgent = {
      id: crypto.randomUUID(),
      namespace,
      name,
      apiVersion: (req.api_version as string) ?? "egaop.io/v1",
      kind: (req.kind as string) ?? "Agent",
      spec: (req.spec as Record<string, unknown>) ?? {},
      status: { phase: "Pending", health_status: "Healthy" },
      labels: (metadata?.labels as Record<string, string>) ?? {},
      annotations: (metadata?.annotations as Record<string, string>) ?? {},
      version: 1,
      createdBy: (metadata?.created_by as string) ?? "",
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    agents.set(key, agent);
    logger.info({ namespace, name, uid: agent.id }, "Agent created");
    callback(null, toProtoAgent(agent));
  },

  GetAgent: (call: { request: Record<string, unknown> }, callback: (err: Error | null, response?: Record<string, unknown>) => void) => {
    const name = call.request.name as string;
    const namespace = (call.request.namespace as string) ?? "default";
    const key = agentKey(namespace, name);
    const agent = agents.get(key);

    if (!agent || agent.deletedAt) {
      callback(new Error(`Agent not found: ${namespace}/${name}`));
      return;
    }
    callback(null, toProtoAgent(agent));
  },

  ListAgents: (call: { request: Record<string, unknown> }, callback: (err: Error | null, response?: Record<string, unknown>) => void) => {
    const req = call.request;
    const namespace = req.namespace as string;
    const filters = (req.filters as Record<string, unknown>) ?? {};
    const pagination = (req.pagination as Record<string, unknown>) ?? {};

    const pageSize = Math.min((pagination.page_size as number) || 50, 100);
    const cursor = (pagination.cursor as string) ?? "";

    let results = Array.from(agents.values()).filter(
      (a) => !a.deletedAt && a.namespace === namespace
    );

    if (filters.phase) {
      results = results.filter((a) => a.status.phase === filters.phase);
    }

    if (filters.labels && typeof filters.labels === "object") {
      const filterLabels = filters.labels as Record<string, string>;
      results = results.filter((a) =>
        Object.entries(filterLabels).every(([k, v]) => a.labels[k] === v)
      );
    }

    if (filters.search) {
      const search = (filters.search as string).toLowerCase();
      results = results.filter((a) => a.name.toLowerCase().includes(search));
    }

    const startIndex = cursor
      ? results.findIndex((a) => a.id === cursor) + 1
      : 0;

    const page = results.slice(startIndex, startIndex + pageSize);
    const nextCursor = page.length === pageSize ? page[page.length - 1]!.id : "";

    callback(null, {
      agents: page.map(toProtoAgent),
      next_cursor: nextCursor,
      total_count: results.length,
    });
  },

  UpdateAgent: (call: { request: Record<string, unknown> }, callback: (err: Error | null, response?: Record<string, unknown>) => void) => {
    const req = call.request;
    const namespace = req.namespace as string;
    const name = req.name as string;
    const key = agentKey(namespace, name);
    const agent = agents.get(key);

    if (!agent || agent.deletedAt) {
      callback(new Error(`Agent not found: ${namespace}/${name}`));
      return;
    }

    if (req.spec && typeof req.spec === "object") {
      agent.spec = { ...agent.spec, ...(req.spec as Record<string, unknown>) };
    }

    if (req.labels && typeof req.labels === "object") {
      agent.labels = { ...agent.labels, ...(req.labels as Record<string, string>) };
    }

    agent.version++;
    agent.updatedAt = new Date();
    agents.set(key, agent);
    logger.info({ namespace, name, version: agent.version }, "Agent updated");
    callback(null, toProtoAgent(agent));
  },

  DeleteAgent: (call: { request: Record<string, unknown> }, callback: (err: Error | null, response?: Record<string, unknown>) => void) => {
    const namespace = call.request.namespace as string;
    const name = call.request.name as string;
    const key = agentKey(namespace, name);
    const agent = agents.get(key);

    if (!agent || agent.deletedAt) {
      callback(new Error(`Agent not found: ${namespace}/${name}`));
      return;
    }

    agent.deletedAt = new Date();
    agent.updatedAt = new Date();
    agents.set(key, agent);
    logger.warn({ namespace, name, uid: agent.id }, "Agent soft-deleted");
    callback(null, {});
  },
};
