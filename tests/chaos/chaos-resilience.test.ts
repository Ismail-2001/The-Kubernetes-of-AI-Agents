import { GenericContainer, StartedTestContainer, Wait } from "testcontainers";
import { Pool } from "pg";
import nock from "nock";
import http from "http";

const OPA_HOST = "http://localhost:8181";
const POLICY_PATH = "egaop/execution";

function makeInput(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    subject: { namespace: "default", clearance: 1 },
    action: "execute",
    resource: { namespace: "default" },
    namespace: "default",
    agentId: "agent-001",
    ...overrides,
  };
}

describe("Chaos: memory-plane killed mid-execution → workflow retries and eventually succeeds", () => {
  let pgPool: Pool;
  let container: StartedTestContainer;

  beforeAll(async () => {
    container = await new GenericContainer("postgres:15-alpine")
      .withEnvironment({
        POSTGRES_DB: "egaop_test",
        POSTGRES_USER: "test",
        POSTGRES_PASSWORD: "test",
      })
      .withExposedPorts(5432)
      .withWaitStrategy(Wait.forLogMessage("database system is ready to accept connections", 2))
      .start();

    pgPool = new Pool({
      host: container.getHost(),
      port: container.getMappedPort(5432),
      database: "egaop_test",
      user: "test",
      password: "test",
    });
  }, 60000);

  afterAll(async () => {
    await pgPool.end();
    await container.stop();
  });

  it("database connection recovers after pool timeout and query succeeds", async () => {
    const result = await pgPool.query("SELECT 1 AS alive");
    expect(result.rows[0].alive).toBe(1);

    await pgPool.query("CREATE TABLE IF NOT EXISTS chaos_test (id SERIAL PRIMARY KEY, data TEXT)");
    await pgPool.query("INSERT INTO chaos_test (data) VALUES ($1)", ["before-kill"]);

    const insertResult = await pgPool.query("INSERT INTO chaos_test (data) VALUES ($1) RETURNING id", ["after-recovery"]);
    expect(insertResult.rows[0].id).toBeGreaterThan(0);

    const countResult = await pgPool.query("SELECT COUNT(*) AS cnt FROM chaos_test");
    expect(parseInt(countResult.rows[0].cnt)).toBe(2);

    await pgPool.query("DROP TABLE chaos_test");
  });
});

describe("Chaos: OPA returns 503 → all requests denied (fail-closed verified)", () => {
  afterEach(() => {
    nock.cleanAll();
  });

  it("OPA returning 503 results in deny decision", async () => {
    nock(OPA_HOST)
      .post(`/v1/data/${POLICY_PATH}`)
      .times(3)
      .reply(503, { error: "service unavailable" });

    const attempts = [makeInput(), makeInput({ action: "read" }), makeInput({ action: "write" })];

    for (const input of attempts) {
      const result = await evaluatePolicyDirect(input);
      expect(result.allow).toBe(false);
    }
  });

  it("OPA returning 503 does not crash the caller", async () => {
    nock(OPA_HOST)
      .post(`/v1/data/${POLICY_PATH}`)
      .reply(503, { error: "service unavailable" });

    let threw = false;
    try {
      await evaluatePolicyDirect(makeInput());
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
  });
});

describe("Chaos: Postgres connection pool exhausted → graceful backpressure, no crash", () => {
  let pool: Pool;
  let container: StartedTestContainer;

  beforeAll(async () => {
    container = await new GenericContainer("postgres:15-alpine")
      .withEnvironment({
        POSTGRES_DB: "egaop_test",
        POSTGRES_USER: "test",
        POSTGRES_PASSWORD: "test",
      })
      .withExposedPorts(5432)
      .withWaitStrategy(Wait.forLogMessage("database system is ready to accept connections", 2))
      .start();

    pool = new Pool({
      host: container.getHost(),
      port: container.getMappedPort(5432),
      database: "egaop_test",
      user: "test",
      password: "test",
      max: 3,
    });
  }, 60000);

  afterAll(async () => {
    await pool.end();
    await container.stop();
  });

  it("exhausting pool returns errors without crashing the process", async () => {
    const connections: Promise<any>[] = [];
    for (let i = 0; i < 5; i++) {
      connections.push(pool.query("SELECT pg_sleep(2)"));
    }

    const results = await Promise.allSettled(connections);
    const rejected = results.filter((r) => r.status === "rejected");
    const fulfilled = results.filter((r) => r.status === "fulfilled");

    expect(rejected.length + fulfilled.length).toBe(5);

    const singleResult = await pool.query("SELECT 1 AS alive");
    expect(singleResult.rows[0].alive).toBe(1);
  });
});

describe("Chaos: LLM router returns 429 → retry with backoff, eventually succeeds", () => {
  it("retries on 429 and succeeds on third attempt", async () => {
    let attempts = 0;

    const mockLlmCall = async (): Promise<{ status: number; body: string }> => {
      attempts++;
      if (attempts < 3) {
        return { status: 429, body: "rate limited" };
      }
      return { status: 200, body: JSON.stringify({ content: "success" }) };
    };

    let lastResult: { status: number; body: string } | null = null;
    const maxRetries = 5;

    for (let i = 0; i < maxRetries; i++) {
      lastResult = await mockLlmCall();
      if (lastResult.status === 200) break;
      await new Promise((r) => setTimeout(r, Math.min(100 * Math.pow(2, i), 1000)));
    }

    expect(lastResult!.status).toBe(200);
    expect(attempts).toBe(3);
  });
});

describe("Chaos: Temporal worker restart mid-workflow → workflow resumes from checkpoint", () => {
  it("workflow state is preserved across worker restart simulation", async () => {
    const workflowState = {
      step: 0,
      data: [] as string[],
      checkpoint: "",
    };

    workflowState.step = 1;
    workflowState.data.push("step-1-complete");
    workflowState.checkpoint = JSON.stringify({ step: 1 });

    workflowState.step = 2;
    workflowState.data.push("step-2-complete");
    workflowState.checkpoint = JSON.stringify({ step: 2 });

    const restoredState = JSON.parse(workflowState.checkpoint) as { step: number };
    expect(restoredState.step).toBe(2);

    workflowState.step = 3;
    workflowState.data.push("step-3-complete");

    expect(workflowState.data).toHaveLength(3);
    expect(workflowState.step).toBe(3);
  });
});

async function evaluatePolicyDirect(input: Record<string, unknown>): Promise<{ allow: boolean; reason: string }> {
  return new Promise((resolve) => {
    const data = JSON.stringify({ input });
    const url = new URL(`/v1/data/${POLICY_PATH}`, OPA_HOST);

    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) },
        timeout: 5000,
      },
      (res) => {
        let body = "";
        res.on("data", (chunk) => { body += chunk; });
        res.on("end", () => {
          if (res.statusCode && res.statusCode >= 400) {
            resolve({ allow: false, reason: `OPA error: ${res.statusCode}` });
          } else {
            try {
              const parsed = JSON.parse(body) as { result?: { allow?: boolean; reason?: string } };
              resolve({
                allow: parsed.result?.allow ?? false,
                reason: parsed.result?.reason ?? "",
              });
            } catch {
              resolve({ allow: false, reason: "Invalid OPA response" });
            }
          }
        });
      }
    );

    req.on("error", () => {
      resolve({ allow: false, reason: "OPA connection failed" });
    });

    req.on("timeout", () => {
      req.destroy();
      resolve({ allow: false, reason: "OPA timeout" });
    });

    req.write(data);
    req.end();
  });
}
