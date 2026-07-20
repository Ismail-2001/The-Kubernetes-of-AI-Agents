import { Pool } from "pg";
import type { Namespace, NamespaceTierValue, NamespaceQuotas } from "@e-gaop/shared";

interface NamespaceRow {
  id: string;
  slug: string;
  display_name: string;
  tier: NamespaceTierValue;
  owner_id: string;
  max_agents: number;
  max_concurrent_executions: number;
  max_memory_mb: number;
  max_tool_calls_per_minute: number;
  created_at: Date;
  updated_at: Date;
  suspended_at: Date | null;
  deleted_at: Date | null;
}

function rowToNamespace(row: NamespaceRow): Namespace {
  return {
    id: row.id,
    slug: row.slug,
    displayName: row.display_name,
    tier: row.tier,
    ownerId: row.owner_id,
    quotas: {
      maxAgents: row.max_agents,
      maxConcurrentExecutions: row.max_concurrent_executions,
      maxMemoryMB: row.max_memory_mb,
      maxToolCallsPerMinute: row.max_tool_calls_per_minute,
    },
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    suspendedAt: row.suspended_at ?? undefined,
    deletedAt: row.deleted_at ?? undefined,
  };
}

export class NamespaceRepository {
  private pool: Pool;

  constructor() {
    this.pool = new Pool({
      host: process.env.POSTGRES_HOST ?? "postgres",
      port: parseInt(process.env.POSTGRES_PORT ?? "5432", 10),
      database: process.env.POSTGRES_DB ?? "egaop",
      user: process.env.POSTGRES_USER ?? "egaop",
      password: process.env.POSTGRES_PASSWORD ?? "",
      max: 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
    });
  }

  async create(params: {
    slug: string;
    displayName: string;
    tier: NamespaceTierValue;
    ownerId: string;
    quotas: NamespaceQuotas;
  }): Promise<Namespace> {
    const result = await this.pool.query<NamespaceRow>(
      `INSERT INTO namespaces (slug, display_name, tier, owner_id, max_agents, max_concurrent_executions, max_memory_mb, max_tool_calls_per_minute)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [
        params.slug,
        params.displayName,
        params.tier,
        params.ownerId,
        params.quotas.maxAgents,
        params.quotas.maxConcurrentExecutions,
        params.quotas.maxMemoryMB,
        params.quotas.maxToolCallsPerMinute,
      ]
    );
    return rowToNamespace(result.rows[0]!);
  }

  async findBySlug(slug: string): Promise<Namespace | null> {
    const result = await this.pool.query<NamespaceRow>(
      `SELECT * FROM namespaces WHERE slug = $1 AND deleted_at IS NULL`,
      [slug]
    );
    return result.rows[0] ? rowToNamespace(result.rows[0]) : null;
  }

  async list(opts: { ownerId?: string; pageSize?: number; pageToken?: string } = {}): Promise<{ namespaces: Namespace[]; nextPageToken: string; totalCount: number }> {
    const pageSize = Math.min(opts.pageSize ?? 50, 100);
    const conditions: string[] = ["deleted_at IS NULL"];
    const params: unknown[] = [];
    let paramIdx = 1;

    if (opts.ownerId) {
      conditions.push(`owner_id = $${paramIdx++}`);
      params.push(opts.ownerId);
    }

    if (opts.pageToken) {
      conditions.push(`(SELECT created_at FROM namespaces WHERE id = $${paramIdx++}) < ns.created_at`);
      params.push(opts.pageToken);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    const countResult = await this.pool.query(`SELECT COUNT(*) as count FROM namespaces ns ${where}`, params);
    const totalCount = parseInt(countResult.rows[0]!.count, 10);

    const dataResult = await this.pool.query<NamespaceRow>(
      `SELECT * FROM namespaces ns ${where} ORDER BY created_at DESC LIMIT $${paramIdx}`,
      [...params, pageSize + 1]
    );

    const rows = dataResult.rows;
    const hasNext = rows.length > pageSize;
    const page = hasNext ? rows.slice(0, pageSize) : rows;

    return {
      namespaces: page.map(rowToNamespace),
      nextPageToken: hasNext ? page[page.length - 1]!.id : "",
      totalCount,
    };
  }

  async update(slug: string, fields: { displayName?: string; quotas?: Partial<NamespaceQuotas> }): Promise<Namespace | null> {
    const sets: string[] = ["updated_at = NOW()"];
    const params: unknown[] = [];
    let paramIdx = 1;

    if (fields.displayName !== undefined) {
      sets.push(`display_name = $${paramIdx++}`);
      params.push(fields.displayName);
    }
    if (fields.quotas?.maxAgents !== undefined) {
      sets.push(`max_agents = $${paramIdx++}`);
      params.push(fields.quotas.maxAgents);
    }
    if (fields.quotas?.maxConcurrentExecutions !== undefined) {
      sets.push(`max_concurrent_executions = $${paramIdx++}`);
      params.push(fields.quotas.maxConcurrentExecutions);
    }
    if (fields.quotas?.maxMemoryMB !== undefined) {
      sets.push(`max_memory_mb = $${paramIdx++}`);
      params.push(fields.quotas.maxMemoryMB);
    }
    if (fields.quotas?.maxToolCallsPerMinute !== undefined) {
      sets.push(`max_tool_calls_per_minute = $${paramIdx++}`);
      params.push(fields.quotas.maxToolCallsPerMinute);
    }

    params.push(slug);
    const result = await this.pool.query<NamespaceRow>(
      `UPDATE namespaces SET ${sets.join(", ")} WHERE slug = $${paramIdx} AND deleted_at IS NULL RETURNING *`,
      params
    );
    return result.rows[0] ? rowToNamespace(result.rows[0]) : null;
  }

  async suspend(slug: string): Promise<Namespace | null> {
    const result = await this.pool.query<NamespaceRow>(
      `UPDATE namespaces SET suspended_at = NOW(), updated_at = NOW() WHERE slug = $1 AND deleted_at IS NULL RETURNING *`,
      [slug]
    );
    return result.rows[0] ? rowToNamespace(result.rows[0]) : null;
  }

  async softDelete(slug: string): Promise<Namespace | null> {
    const result = await this.pool.query<NamespaceRow>(
      `UPDATE namespaces SET deleted_at = NOW(), updated_at = NOW() WHERE slug = $1 AND deleted_at IS NULL RETURNING *`,
      [slug]
    );
    return result.rows[0] ? rowToNamespace(result.rows[0]) : null;
  }

  async ping(): Promise<boolean> {
    try {
      await this.pool.query("SELECT 1");
      return true;
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
