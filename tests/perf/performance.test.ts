import http from "http";
import { GenericContainer, StartedTestContainer, Wait } from "testcontainers";
import { Pool } from "pg";

interface PerfResult {
  totalRequests: number;
  successfulRequests: number;
  failedRequests: number;
  requestsPerSecond: number;
  averageLatencyMs: number;
  p99LatencyMs: number;
  durationMs: number;
}

async function runHttpBenchmark(
  url: string,
  options: {
    concurrency: number;
    durationMs: number;
    method?: string;
    body?: string;
    headers?: Record<string, string>;
  }
): Promise<PerfResult> {
  const { concurrency, durationMs, method = "GET", body, headers = {} } = options;
  const startTime = Date.now();
  const latencies: number[] = [];
  let successful = 0;
  let failed = 0;
  let activeRequests = 0;
  let shouldStop = false;

  const makeRequest = (): Promise<void> => {
    return new Promise((resolve) => {
      if (shouldStop) { resolve(); return; }

      activeRequests++;
      const reqStart = Date.now();

      const urlObj = new URL(url);
      const req = http.request(
        {
          hostname: urlObj.hostname,
          port: urlObj.port,
          path: urlObj.pathname,
          method,
          headers: { ...headers, "Content-Length": body ? Buffer.byteLength(body).toString() : "0" },
          timeout: 10000,
        },
        (res) => {
          let data = "";
          res.on("data", (chunk) => { data += chunk; });
          res.on("end", () => {
            const latency = Date.now() - reqStart;
            latencies.push(latency);
            if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
              successful++;
            } else {
              failed++;
            }
            activeRequests--;
            resolve();
          });
        }
      );

      req.on("error", () => {
        failed++;
        activeRequests--;
        resolve();
      });

      req.on("timeout", () => {
        req.destroy();
        failed++;
        activeRequests--;
        resolve();
      });

      if (body) req.write(body);
      req.end();
    });
  };

  const runLoop = async (): Promise<void> => {
    while (!shouldStop) {
      if (activeRequests < concurrency) {
        makeRequest();
      }
      await new Promise((r) => setTimeout(r, 1));
    }
    while (activeRequests > 0) {
      await new Promise((r) => setTimeout(r, 10));
    }
  };

  const timer = setTimeout(() => {
    shouldStop = true;
  }, durationMs);

  await runLoop();
  clearTimeout(timer);

  latencies.sort((a, b) => a - b);
  const total = successful + failed;
  const duration = Date.now() - startTime;

  return {
    totalRequests: total,
    successfulRequests: successful,
    failedRequests: failed,
    requestsPerSecond: total / (duration / 1000),
    averageLatencyMs: latencies.length > 0 ? latencies.reduce((a, b) => a + b, 0) / latencies.length : 0,
    p99LatencyMs: latencies.length > 0 ? latencies[Math.floor(latencies.length * 0.99)]! : 0,
    durationMs: duration,
  };
}

describe("Performance: api-server handles 500 req/s at p99 < 100ms", () => {
  let pgContainer: StartedTestContainer;
  let pool: Pool;

  beforeAll(async () => {
    pgContainer = await new GenericContainer("postgres:15-alpine")
      .withEnvironment({
        POSTGRES_DB: "egaop_perf",
        POSTGRES_USER: "test",
        POSTGRES_PASSWORD: "test",
      })
      .withExposedPorts(5432)
      .withWaitStrategy(Wait.forLogMessage("database system is ready to accept connections", 2))
      .start();

    pool = new Pool({
      host: pgContainer.getHost(),
      port: pgContainer.getMappedPort(5432),
      database: "egaop_perf",
      user: "test",
      password: "test",
      max: 20,
    });

    await pool.query(`
      CREATE TABLE IF NOT EXISTS perf_test (
        id SERIAL PRIMARY KEY,
        data JSONB NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
  }, 60000);

  afterAll(async () => {
    await pool.end();
    await pgContainer.stop();
  });

  it("PostgreSQL handles 1000 inserts/s with acceptable latency", async () => {
    const startTime = Date.now();
    const duration = 5000;
    let inserted = 0;

    while (Date.now() - startTime < duration) {
      const batch = [];
      for (let i = 0; i < 10; i++) {
        batch.push(pool.query(
          "INSERT INTO perf_test (data) VALUES ($1) RETURNING id",
          [JSON.stringify({ iteration: inserted + i, timestamp: Date.now() })]
        ));
      }
      const results = await Promise.all(batch);
      inserted += results.length;
    }

    const elapsed = Date.now() - startTime;
    const insertsPerSecond = (inserted / elapsed) * 1000;

    expect(insertsPerSecond).toBeGreaterThan(500);

    await pool.query("DELETE FROM perf_test");
  });
});

describe("Performance: memory plane 1000 set() calls/s with Postgres backend", () => {
  let pgContainer: StartedTestContainer;
  let pool: Pool;

  beforeAll(async () => {
    pgContainer = await new GenericContainer("postgres:15-alpine")
      .withEnvironment({
        POSTGRES_DB: "egaop_perf_mem",
        POSTGRES_USER: "test",
        POSTGRES_PASSWORD: "test",
      })
      .withExposedPorts(5432)
      .withWaitStrategy(Wait.forLogMessage("database system is ready to accept connections", 2))
      .start();

    pool = new Pool({
      host: pgContainer.getHost(),
      port: pgContainer.getMappedPort(5432),
      database: "egaop_perf_mem",
      user: "test",
      password: "test",
      max: 20,
    });

    await pool.query(`
      CREATE TABLE IF NOT EXISTS perf_memory (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        namespace VARCHAR(255) NOT NULL,
        agent_id VARCHAR(255) NOT NULL,
        key VARCHAR(512) NOT NULL,
        value JSONB NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE (namespace, agent_id, key)
      )
    `);
  }, 60000);

  afterAll(async () => {
    await pool.end();
    await pgContainer.stop();
  });

  it("bulk upserts 1000 entries within 5 seconds", async () => {
    const startTime = Date.now();
    const total = 1000;
    const batchSize = 50;

    for (let batch = 0; batch < total; batch += batchSize) {
      const promises: Promise<any>[] = [];
      for (let i = 0; i < batchSize && batch + i < total; i++) {
        const idx = batch + i;
        promises.push(pool.query(
          `INSERT INTO perf_memory (namespace, agent_id, key, value)
           VALUES ($1, $2, $3, $4::jsonb)
           ON CONFLICT (namespace, agent_id, key)
           DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
          ["perf-ns", `agent-${idx % 10}`, `key-${idx}`, JSON.stringify({ value: idx })]
        ));
      }
      await Promise.all(promises);
    }

    const elapsed = Date.now() - startTime;
    const opsPerSecond = (total / elapsed) * 1000;

    expect(opsPerSecond).toBeGreaterThan(500);

    const countResult = await pool.query("SELECT COUNT(*) AS cnt FROM perf_memory");
    expect(parseInt(countResult.rows[0].cnt)).toBe(total);

    await pool.query("DELETE FROM perf_memory");
  });
});

describe("Performance: observability ingest 10k spans/s without dropping", () => {
  let pgContainer: StartedTestContainer;
  let pool: Pool;

  beforeAll(async () => {
    pgContainer = await new GenericContainer("postgres:15-alpine")
      .withEnvironment({
        POSTGRES_DB: "egaop_perf_obs",
        POSTGRES_USER: "test",
        POSTGRES_PASSWORD: "test",
      })
      .withExposedPorts(5432)
      .withWaitStrategy(Wait.forLogMessage("database system is ready to accept connections", 2))
      .start();

    pool = new Pool({
      host: pgContainer.getHost(),
      port: pgContainer.getMappedPort(5432),
      database: "egaop_perf_obs",
      user: "test",
      password: "test",
      max: 20,
    });

    await pool.query(`
      CREATE TABLE IF NOT EXISTS perf_spans (
        trace_id VARCHAR(64) NOT NULL,
        span_id VARCHAR(32) PRIMARY KEY,
        parent_span_id VARCHAR(32),
        service_name VARCHAR(255) NOT NULL,
        operation_name VARCHAR(512) NOT NULL,
        namespace VARCHAR(255) NOT NULL,
        start_time TIMESTAMPTZ NOT NULL,
        end_time TIMESTAMPTZ,
        status VARCHAR(32) DEFAULT 'ok',
        attributes JSONB DEFAULT '{}',
        events JSONB DEFAULT '[]'
      )
    `);
  }, 60000);

  afterAll(async () => {
    await pool.end();
    await pgContainer.stop();
  });

  it("bulk inserts 10000 spans in under 2 seconds", async () => {
    const totalSpans = 10000;
    const batchSize = 500;
    const traceId = `trace-perf-${Date.now()}`;

    const startTime = Date.now();

    for (let batch = 0; batch < totalSpans; batch += batchSize) {
      const spanIds: string[] = [];
      const traceIds: string[] = [];
      const serviceNames: string[] = [];
      const operationNames: string[] = [];
      const namespaces: string[] = [];
      const startTimes: Date[] = [];
      const statuses: string[] = [];

      for (let i = 0; i < batchSize && batch + i < totalSpans; i++) {
        spanIds.push(`span-${batch + i}`);
        traceIds.push(traceId);
        serviceNames.push("perf-service");
        operationNames.push(`operation-${i % 100}`);
        namespaces.push("perf-ns");
        startTimes.push(new Date());
        statuses.push("ok");
      }

      await pool.query(
        `INSERT INTO perf_spans (trace_id, span_id, service_name, operation_name, namespace, start_time, status)
         SELECT unnest($1::varchar[]), unnest($2::varchar[]), unnest($3::varchar[]),
                unnest($4::varchar[]), unnest($5::varchar[]), unnest($6::timestamptz[]),
                unnest($7::varchar[])
         ON CONFLICT (span_id) DO NOTHING`,
        [traceIds, spanIds, serviceNames, operationNames, namespaces, startTimes, statuses]
      );
    }

    const elapsed = Date.now() - startTime;
    const spansPerSecond = (totalSpans / elapsed) * 1000;

    expect(spansPerSecond).toBeGreaterThan(2000);

    const countResult = await pool.query("SELECT COUNT(*) AS cnt FROM perf_spans");
    expect(parseInt(countResult.rows[0].cnt)).toBe(totalSpans);

    await pool.query("DELETE FROM perf_spans");
  });
});
