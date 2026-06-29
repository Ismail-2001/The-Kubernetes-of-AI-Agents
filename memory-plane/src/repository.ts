import { Pool, PoolClient } from "pg";

interface MemoryEntry {
  id: string;
  namespace: string;
  agentId: string;
  key: string;
  value: Record<string, unknown>;
  embedding: number[] | null;
  createdAt: Date;
  updatedAt: Date;
  expiresAt: Date | null;
}

interface SearchResult {
  entry: MemoryEntry;
  similarity: number;
}

export class MemoryPlaneRepository {
  private readonly pool: Pool;
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(pool: Pool) {
    this.pool = pool;
  }

  async set(
    namespace: string,
    agentId: string,
    key: string,
    value: Record<string, unknown>,
    ttlSeconds?: number,
    embedding?: number[]
  ): Promise<void> {
    const expiresAt = ttlSeconds
      ? new Date(Date.now() + ttlSeconds * 1000)
      : null;

    const embeddingArray = embedding
      ? `[${embedding.join(",")}]`
      : null;

    await this.pool.query(
      `INSERT INTO agent_memory (namespace, agent_id, key, value, embedding, expires_at, updated_at)
       VALUES ($1, $2, $3, $4::jsonb, $5::vector, $6, NOW())
       ON CONFLICT (namespace, agent_id, key)
       DO UPDATE SET
         value = EXCLUDED.value,
         embedding = COALESCE(EXCLUDED.embedding, agent_memory.embedding),
         expires_at = COALESCE(EXCLUDED.expires_at, agent_memory.expires_at),
         updated_at = NOW()`,
      [namespace, agentId, key, JSON.stringify(value), embeddingArray, expiresAt]
    );
  }

  async get(
    namespace: string,
    agentId: string,
    key: string
  ): Promise<MemoryEntry | null> {
    const result = await this.pool.query(
      `SELECT id, namespace, agent_id, key, value, embedding, created_at, updated_at, expires_at
       FROM agent_memory
       WHERE namespace = $1 AND agent_id = $2 AND key = $3
         AND (expires_at IS NULL OR expires_at > NOW())`,
      [namespace, agentId, key]
    );

    if (result.rows.length === 0) return null;

    return this.mapRow(result.rows[0]!);
  }

  async delete(namespace: string, agentId: string, key: string): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE agent_memory
       SET expires_at = NOW()
       WHERE namespace = $1 AND agent_id = $2 AND key = $3
         AND (expires_at IS NULL OR expires_at > NOW())`,
      [namespace, agentId, key]
    );

    return (result.rowCount ?? 0) > 0;
  }

  async searchSimilar(
    namespace: string,
    embedding: number[],
    topK: number = 10
  ): Promise<SearchResult[]> {
    const embeddingArray = `[${embedding.join(",")}]`;

    const result = await this.pool.query(
      `SELECT id, namespace, agent_id, key, value, embedding, created_at, updated_at, expires_at,
              1 - (embedding <=> $1::vector) AS similarity
       FROM agent_memory
       WHERE namespace = $2
         AND embedding IS NOT NULL
         AND (expires_at IS NULL OR expires_at > NOW())
       ORDER BY embedding <=> $1::vector
       LIMIT $3`,
      [embeddingArray, namespace, topK]
    );

    return result.rows.map((row) => ({
      entry: this.mapRow(row),
      similarity: parseFloat(row.similarity as string),
    }));
  }

  async clearExpired(): Promise<number> {
    const result = await this.pool.query(
      `DELETE FROM agent_memory
       WHERE expires_at IS NOT NULL AND expires_at < NOW()`
    );

    return result.rowCount ?? 0;
  }

  startCleanupInterval(intervalMs: number = 300000): void {
    this.stopCleanupInterval();
    this.cleanupTimer = setInterval(() => {
      this.clearExpired().catch((err) => {
        process.stderr.write(
          JSON.stringify({
            timestamp: new Date().toISOString(),
            level: "error",
            message: `Failed to clear expired memory: ${err.message}`,
          }) + "\n"
        );
      });
    }, intervalMs);
    if (this.cleanupTimer && typeof this.cleanupTimer === "object" && "unref" in this.cleanupTimer) {
      this.cleanupTimer.unref();
    }
  }

  stopCleanupInterval(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  async list(
    namespace: string,
    agentId: string,
    limit: number = 100,
    offset: number = 0
  ): Promise<MemoryEntry[]> {
    const result = await this.pool.query(
      `SELECT id, namespace, agent_id, key, value, embedding, created_at, updated_at, expires_at
       FROM agent_memory
       WHERE namespace = $1 AND agent_id = $2
         AND (expires_at IS NULL OR expires_at > NOW())
       ORDER BY updated_at DESC
       LIMIT $3 OFFSET $4`,
      [namespace, agentId, limit, offset]
    );

    return result.rows.map((row) => this.mapRow(row));
  }

  private mapRow(row: Record<string, unknown>): MemoryEntry {
    return {
      id: row.id as string,
      namespace: row.namespace as string,
      agentId: row.agent_id as string,
      key: row.key as string,
      value: row.value as Record<string, unknown>,
      embedding: row.embedding as number[] | null,
      createdAt: row.created_at as Date,
      updatedAt: row.updated_at as Date,
      expiresAt: row.expires_at as Date | null,
    };
  }

  async transaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }
}
