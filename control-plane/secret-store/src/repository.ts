import { Pool } from "pg";

// ─── Types ────────────────────────────────────────────────────────────────

export interface SecretRow {
  id: string;
  namespace: string;
  name: string;
  encryptedData: string;
  type: string;
  createdAt: string;
  updatedAt: string;
}

interface SecretRepositoryConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
}

// ─── Repository ───────────────────────────────────────────────────────────

export class SecretRepository {
  private pool: Pool;

  constructor(config?: SecretRepositoryConfig) {
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

  async upsert(params: {
    namespace: string;
    name: string;
    encryptedData: string;
    type: string;
  }): Promise<void> {
    await this.pool.query(
      `INSERT INTO secrets (namespace, name, encrypted_data, type)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (namespace, name)
       DO UPDATE SET encrypted_data = EXCLUDED.encrypted_data,
                     type = EXCLUDED.type,
                     updated_at = NOW()`,
      [params.namespace, params.name, params.encryptedData, params.type]
    );
  }

  async get(namespace: string, name: string): Promise<SecretRow | null> {
    const result = await this.pool.query(
      `SELECT id, namespace, name, encrypted_data, type, created_at, updated_at
       FROM secrets
       WHERE namespace = $1 AND name = $2`,
      [namespace, name]
    );
    if (result.rows.length === 0) return null;
    const row = result.rows[0]!;
    return {
      id: row["id"] as string,
      namespace: row["namespace"] as string,
      name: row["name"] as string,
      encryptedData: row["encrypted_data"] as string,
      type: row["type"] as string,
      createdAt: (row["created_at"] as Date).toISOString(),
      updatedAt: (row["updated_at"] as Date).toISOString(),
    };
  }

  async delete(namespace: string, name: string): Promise<boolean> {
    const result = await this.pool.query(
      `DELETE FROM secrets WHERE namespace = $1 AND name = $2`,
      [namespace, name]
    );
    return (result.rowCount ?? 0) > 0;
  }

  async list(namespace: string): Promise<string[]> {
    const result = await this.pool.query(
      `SELECT name FROM secrets WHERE namespace = $1 ORDER BY name`,
      [namespace]
    );
    return result.rows.map((row) => row["name"] as string);
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
