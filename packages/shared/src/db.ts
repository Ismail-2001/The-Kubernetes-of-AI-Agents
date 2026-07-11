import { Pool, PoolConfig } from "pg";

let pool: Pool | null = null;

const DEFAULT_CONFIG: PoolConfig = {
  max: parseInt(process.env.DB_POOL_MAX || "20", 10),
  idleTimeoutMillis: parseInt(process.env.DB_IDLE_TIMEOUT_MS || "30000", 10),
  connectionTimeoutMillis: parseInt(process.env.DB_CONNECTION_TIMEOUT_MS || "2000", 10),
  connectionString: process.env.DATABASE_URL,
};

async function connectWithRetry(
  config: PoolConfig,
  attempt: number = 1,
  maxAttempts: number = 5
): Promise<Pool> {
  try {
    const testPool = new Pool(config);
    await testPool.query("SELECT 1");
    return testPool;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (attempt >= maxAttempts) {
      process.stderr.write(
        JSON.stringify({
          timestamp: new Date().toISOString(),
          level: "fatal",
          message: `Failed to connect to PostgreSQL after ${maxAttempts} attempts: ${message}`,
        }) + "\n"
      );
      process.exit(1);
    }

    const backoffMs = Math.min(1000 * Math.pow(2, attempt - 1), 30000);
    process.stderr.write(
      JSON.stringify({
        timestamp: new Date().toISOString(),
        level: "warn",
        message: `PostgreSQL connection attempt ${attempt}/${maxAttempts} failed: ${message}. Retrying in ${backoffMs}ms`,
      }) + "\n"
    );

    await new Promise((resolve) => setTimeout(resolve, backoffMs));
    return connectWithRetry(config, attempt + 1, maxAttempts);
  }
}

export async function getPool(): Promise<Pool> {
  if (pool) return pool;

  pool = await connectWithRetry(DEFAULT_CONFIG);

  pool.on("error", (err) => {
    process.stderr.write(
      JSON.stringify({
        timestamp: new Date().toISOString(),
        level: "error",
        message: `PostgreSQL pool error: ${err.message}`,
      }) + "\n"
    );
  });

  return pool;
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

function setupGracefulShutdown(): void {
  const shutdown = async () => {
    await closePool();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

if (process.env.NODE_ENV !== "test") {
  setupGracefulShutdown();
}
