import { Pool } from "pg";
import crypto from "crypto";

export interface AgentRow {
  id: string;
  namespace: string;
  name: string;
  api_version: string;
  kind: string;
  spec: Record<string, unknown>;
  status: Record<string, unknown>;
  labels: Record<string, string>;
  annotations: Record<string, string>;
  version: number;
  created_by: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

interface AgentRepositoryConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
}

export class AgentRepository {
  private pool: Pool;

  constructor(config?: AgentRepositoryConfig) {
    this.pool = new Pool({
      host: config?.host ?? process.env.POSTGRES_HOST ?? "postgres",
      port: config?.port ?? parseInt(process.env.POSTGRES_PORT ?? "5432", 10),
      database: config?.database ?? process.env.POSTGRES_DB ?? "egaop",
      user: config?.user ?? process.env.POSTGRES_USER ?? "egaop",
      password: config?.password ?? process.env.POSTGRES_PASSWORD ?? "",
      max: 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
    });
  }

  async findById(id: string): Promise<AgentRow | null> {
    const result = await this.pool.query(
      `SELECT id, namespace, name, api_version, kind, spec, status, labels, annotations,
              version, created_by, created_at, updated_at, deleted_at
       FROM agents
       WHERE id = $1 AND deleted_at IS NULL`,
      [id]
    );
    if (result.rows.length === 0) return null;
    return this.mapRow(result.rows[0]!);
  }

  async findByNamespaceAndName(namespace: string, name: string): Promise<AgentRow | null> {
    const result = await this.pool.query(
      `SELECT id, namespace, name, api_version, kind, spec, status, labels, annotations,
              version, created_by, created_at, updated_at, deleted_at
       FROM agents
       WHERE namespace = $1 AND name = $2 AND deleted_at IS NULL`,
      [namespace, name]
    );
    if (result.rows.length === 0) return null;
    return this.mapRow(result.rows[0]!);
  }

  async listByNamespace(
    namespace: string,
    options?: {
      phase?: string;
      labels?: Record<string, string>;
      search?: string;
      cursor?: string;
      pageSize?: number;
    }
  ): Promise<{ agents: AgentRow[]; nextCursor: string; totalCount: number }> {
    const pageSize = Math.min(options?.pageSize ?? 50, 100);

    let whereClause = "WHERE namespace = $1 AND deleted_at IS NULL";
    const params: unknown[] = [namespace];
    let paramIndex = 2;

    if (options?.phase) {
      whereClause += ` AND status->>'phase' = $${paramIndex++}`;
      params.push(options.phase);
    }

    if (options?.labels && typeof options.labels === "object") {
      for (const [k, v] of Object.entries(options.labels)) {
        whereClause += ` AND labels->>'${k.replace(/'/g, "''")}' = $${paramIndex++}`;
        params.push(v);
      }
    }

    if (options?.search) {
      whereClause += ` AND name ILIKE $${paramIndex++}`;
      params.push(`%${options.search}%`);
    }

    if (options?.cursor) {
      whereClause += ` AND id > $${paramIndex++}`;
      params.push(options.cursor);
    }

    const countResult = await this.pool.query(
      `SELECT COUNT(*) as total FROM agents ${whereClause}`,
      params
    );
    const totalCount = parseInt(countResult.rows[0]!["total"] as string, 10);

    const result = await this.pool.query(
      `SELECT id, namespace, name, api_version, kind, spec, status, labels, annotations,
              version, created_by, created_at, updated_at, deleted_at
       FROM agents ${whereClause}
       ORDER BY id ASC
       LIMIT $${paramIndex}`,
      [...params, pageSize]
    );

    const agents = result.rows.map((row: unknown) => this.mapRow(row as Record<string, unknown>));
    const nextCursor = agents.length === pageSize ? agents[agents.length - 1]!.id : "";

    return { agents, nextCursor, totalCount };
  }

  async create(params: {
    namespace: string;
    name: string;
    apiVersion?: string;
    kind?: string;
    spec?: Record<string, unknown>;
    status?: Record<string, unknown>;
    labels?: Record<string, string>;
    annotations?: Record<string, string>;
    createdBy?: string;
  }): Promise<AgentRow> {
    const id = crypto.randomUUID();
    const apiVersion = params.apiVersion ?? "egaop.io/v1";
    const kind = params.kind ?? "Agent";
    const spec = params.spec ?? {};
    const status = params.status ?? { phase: "Pending", health_status: "Healthy" };
    const labels = params.labels ?? {};
    const annotations = params.annotations ?? {};
    const createdBy = params.createdBy ?? "";

    const result = await this.pool.query(
      `INSERT INTO agents (id, namespace, name, api_version, kind, spec, status, labels, annotations, created_by)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8::jsonb, $9::jsonb, $10)
       RETURNING id, namespace, name, api_version, kind, spec, status, labels, annotations,
                 version, created_by, created_at, updated_at, deleted_at`,
      [id, params.namespace, params.name, apiVersion, kind,
       JSON.stringify(spec), JSON.stringify(status), JSON.stringify(labels), JSON.stringify(annotations),
       createdBy]
    );

    return this.mapRow(result.rows[0]!);
  }

  async update(
    namespace: string,
    name: string,
    params: {
      spec?: Record<string, unknown>;
      labels?: Record<string, string>;
      annotations?: Record<string, string>;
    }
  ): Promise<AgentRow | null> {
    const sets: string[] = [];
    const setValues: unknown[] = [];
    let paramIndex = 3;

    if (params.spec) {
      sets.push(`spec = spec || $${paramIndex++}::jsonb`);
      setValues.push(JSON.stringify(params.spec));
    }
    if (params.labels) {
      sets.push(`labels = labels || $${paramIndex++}::jsonb`);
      setValues.push(JSON.stringify(params.labels));
    }
    if (params.annotations) {
      sets.push(`annotations = annotations || $${paramIndex++}::jsonb`);
      setValues.push(JSON.stringify(params.annotations));
    }

    if (sets.length === 0) {
      return this.findByNamespaceAndName(namespace, name);
    }

    sets.push(`version = version + 1`);
    sets.push(`updated_at = NOW()`);

    const result = await this.pool.query(
      `UPDATE agents
       SET ${sets.join(", ")}
       WHERE namespace = $1 AND name = $2 AND deleted_at IS NULL
       RETURNING id, namespace, name, api_version, kind, spec, status, labels, annotations,
                 version, created_by, created_at, updated_at, deleted_at`,
      [namespace, name, ...setValues]
    );

    if (result.rows.length === 0) return null;
    return this.mapRow(result.rows[0]!);
  }

  async softDelete(namespace: string, name: string): Promise<AgentRow | null> {
    const result = await this.pool.query(
      `UPDATE agents
       SET deleted_at = NOW(), updated_at = NOW()
       WHERE namespace = $1 AND name = $2 AND deleted_at IS NULL
       RETURNING id, namespace, name, api_version, kind, spec, status, labels, annotations,
                 version, created_by, created_at, updated_at, deleted_at`,
      [namespace, name]
    );
    if (result.rows.length === 0) return null;
    return this.mapRow(result.rows[0]!);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  private mapRow(row: Record<string, unknown>): AgentRow {
    return {
      id: row["id"] as string,
      namespace: row["namespace"] as string,
      name: row["name"] as string,
      api_version: row["api_version"] as string,
      kind: row["kind"] as string,
      spec: typeof row["spec"] === "string" ? JSON.parse(row["spec"] as string) : (row["spec"] as Record<string, unknown>),
      status: typeof row["status"] === "string" ? JSON.parse(row["status"] as string) : (row["status"] as Record<string, unknown>),
      labels: typeof row["labels"] === "string" ? JSON.parse(row["labels"] as string) : (row["labels"] as Record<string, string>),
      annotations: typeof row["annotations"] === "string" ? JSON.parse(row["annotations"] as string) : (row["annotations"] as Record<string, string>),
      version: parseInt(row["version"] as string, 10),
      created_by: row["created_by"] as string,
      created_at: row["created_at"] as string,
      updated_at: row["updated_at"] as string,
      deleted_at: row["deleted_at"] as string | null,
    };
  }
}

let instance: AgentRepository | null = null;

export function getAgentRepository(): AgentRepository {
  if (!instance) {
    instance = new AgentRepository();
  }
  return instance;
}

export function resetAgentRepository(): void {
  if (instance) {
    instance.close();
    instance = null;
  }
}
