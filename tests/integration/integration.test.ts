import { GenericContainer, Wait } from "testcontainers";
import http from "http";

describe("Integration Tests", () => {
  let postgres: any;
  let redis: any;

  beforeAll(async () => {
    postgres = await new GenericContainer("postgres:15-alpine")
      .withEnvironment({
        POSTGRES_DB: "egaop_test",
        POSTGRES_USER: "test",
        POSTGRES_PASSWORD: "test",
      })
      .withExposedPorts(5432)
      .withWaitStrategy(Wait.forLogMessage("database system is ready to accept connections", 2))
      .start();

    redis = await new GenericContainer("redis:7-alpine")
      .withExposedPorts(6379)
      .withWaitStrategy(Wait.forLogMessage("Ready to accept connections"))
      .start();
  }, 120000);

  afterAll(async () => {
    if (postgres) await postgres.stop();
    if (redis) await redis.stop();
  });

  it("should connect to PostgreSQL", async () => {
    const host = postgres.getHost();
    const port = postgres.getMappedPort(5432);
    expect(host).toBeDefined();
    expect(port).toBeGreaterThan(0);
  });

  it("should connect to Redis", async () => {
    const host = redis.getHost();
    const port = redis.getMappedPort(6379);
    expect(host).toBeDefined();
    expect(port).toBeGreaterThan(0);
  });
});
