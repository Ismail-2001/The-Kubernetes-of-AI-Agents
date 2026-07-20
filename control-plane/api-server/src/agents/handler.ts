import crypto from "crypto";
import pino from "pino";
import { getAgentRepository, type AgentRow } from "./repository";

const logger = pino({
  level: process.env.NODE_ENV === "test" ? "silent" : (process.env.LOG_LEVEL || "info"),
  ...(process.env.NODE_ENV !== "production" && process.env.NODE_ENV !== "test" ? {
    transport: { target: "pino-pretty", options: { colorize: true } }
  } : {}),
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

function rowToAgent(row: AgentRow): StoredAgent {
  return {
    id: row.id,
    namespace: row.namespace,
    name: row.name,
    apiVersion: row.api_version,
    kind: row.kind,
    spec: row.spec,
    status: row.status,
    labels: row.labels,
    annotations: row.annotations,
    version: row.version,
    createdBy: row.created_by,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
    deletedAt: row.deleted_at ? new Date(row.deleted_at) : undefined,
  };
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
  CreateAgent: async (call: { request: Record<string, unknown> }, callback: (err: Error | null, response?: Record<string, unknown>) => void) => {
    try {
      const repo = getAgentRepository();
      const req = call.request;
      const metadata = req.metadata as Record<string, unknown> | undefined;
      const name = (metadata?.name as string) ?? `agent-${crypto.randomUUID().slice(0, 8)}`;
      const namespace = (metadata?.namespace as string) ?? "default";

      const existing = await repo.findByNamespaceAndName(namespace, name);
      if (existing) {
        callback(new Error(`Agent already exists: ${namespace}/${name}`));
        return;
      }

      const agent = await repo.create({
        namespace,
        name,
        apiVersion: (req.api_version as string) || "egaop.io/v1",
        kind: (req.kind as string) || "Agent",
        spec: (req.spec as Record<string, unknown>) || {},
        status: { phase: "Pending", health_status: "Healthy" },
        labels: (metadata?.labels as Record<string, string>) ?? {},
        annotations: (metadata?.annotations as Record<string, string>) ?? {},
        createdBy: (metadata?.created_by as string) ?? "",
      });

      logger.info({ namespace, name, uid: agent.id }, "Agent created");
      callback(null, toProtoAgent(rowToAgent(agent)));
    } catch (err) {
      logger.error({ err }, "CreateAgent failed");
      callback(new Error("Internal error creating agent"));
    }
  },

  GetAgent: async (call: { request: Record<string, unknown> }, callback: (err: Error | null, response?: Record<string, unknown>) => void) => {
    try {
      const repo = getAgentRepository();
      const name = call.request.name as string;
      const namespace = (call.request.namespace as string) ?? "default";

      const agent = await repo.findByNamespaceAndName(namespace, name);
      if (!agent) {
        callback(new Error(`Agent not found: ${namespace}/${name}`));
        return;
      }
      callback(null, toProtoAgent(rowToAgent(agent)));
    } catch (err) {
      logger.error({ err }, "GetAgent failed");
      callback(new Error("Internal error getting agent"));
    }
  },

  ListAgents: async (call: { request: Record<string, unknown> }, callback: (err: Error | null, response?: Record<string, unknown>) => void) => {
    try {
      const repo = getAgentRepository();
      const req = call.request;
      const namespace = req.namespace as string;
      const filters = (req.filters as Record<string, unknown>) ?? {};
      const pagination = (req.pagination as Record<string, unknown>) ?? {};

      const pageSize = Math.min((pagination.page_size as number) || 50, 100);
      const cursor = (pagination.cursor as string) ?? "";

      const result = await repo.listByNamespace(namespace, {
        phase: filters.phase as string | undefined,
        labels: filters.labels as Record<string, string> | undefined,
        search: filters.search as string | undefined,
        cursor: cursor || undefined,
        pageSize,
      });

      callback(null, {
        agents: result.agents.map((a) => toProtoAgent(rowToAgent(a))),
        next_cursor: result.nextCursor,
        total_count: result.totalCount,
      });
    } catch (err) {
      logger.error({ err }, "ListAgents failed");
      callback(new Error("Internal error listing agents"));
    }
  },

  UpdateAgent: async (call: { request: Record<string, unknown> }, callback: (err: Error | null, response?: Record<string, unknown>) => void) => {
    try {
      const repo = getAgentRepository();
      const req = call.request;
      const namespace = req.namespace as string;
      const name = req.name as string;

      const updated = await repo.update(namespace, name, {
        spec: req.spec as Record<string, unknown> | undefined,
        labels: req.labels as Record<string, string> | undefined,
        annotations: req.annotations as Record<string, string> | undefined,
      });

      if (!updated) {
        callback(new Error(`Agent not found: ${namespace}/${name}`));
        return;
      }

      logger.info({ namespace, name, version: updated.version }, "Agent updated");
      callback(null, toProtoAgent(rowToAgent(updated)));
    } catch (err) {
      logger.error({ err }, "UpdateAgent failed");
      callback(new Error("Internal error updating agent"));
    }
  },

  DeleteAgent: async (call: { request: Record<string, unknown> }, callback: (err: Error | null, response?: Record<string, unknown>) => void) => {
    try {
      const repo = getAgentRepository();
      const namespace = call.request.namespace as string;
      const name = call.request.name as string;

      const deleted = await repo.softDelete(namespace, name);
      if (!deleted) {
        callback(new Error(`Agent not found: ${namespace}/${name}`));
        return;
      }

      logger.warn({ namespace, name, uid: deleted.id }, "Agent soft-deleted");
      callback(null, {});
    } catch (err) {
      logger.error({ err }, "DeleteAgent failed");
      callback(new Error("Internal error deleting agent"));
    }
  },
};
