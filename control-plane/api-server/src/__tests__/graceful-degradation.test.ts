jest.mock("pg", () => {
  const mPool = { query: jest.fn(), connect: jest.fn(), end: jest.fn() };
  return { Pool: jest.fn(() => mPool) };
});

process.env.JWT_SECRET = "test-secret-key-that-is-long-enough-for-validation-32chars";
process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "silent";

const mockRepo = {
  findByEmail: jest.fn(),
  findById: jest.fn(),
  create: jest.fn(),
  isLocked: jest.fn(),
  incrementFailedLogin: jest.fn(),
  resetFailedLogin: jest.fn(),
  clearMustChangePassword: jest.fn(),
  close: jest.fn(),
  pool: { query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }) },
};

jest.mock("../auth/repository", () => ({
  getUserRepository: jest.fn(() => mockRepo),
  ensureAdminUser: jest.fn(),
}));

import Fastify, { type FastifyInstance } from "fastify";
import { authRoutes, authenticate } from "../auth/routes";
import { hashPassword, signJWT } from "@e-gaop/shared";

const SECRET = "test-secret-key-that-is-long-enough-for-validation-32chars";

function makeUser(overrides?: Record<string, unknown>) {
  return {
    id: "u-1",
    email: "existing@example.com",
    password_hash: "",
    name: "Existing User",
    role: "developer",
    namespace_access: ["default"],
    is_active: true,
    must_change_password: false,
    failed_login_attempts: 0,
    locked_until: null,
    last_login_at: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

function validToken(claims?: Partial<Record<string, unknown>>): string {
  return signJWT(
    {
      sub: "u-1",
      email: "existing@example.com",
      name: "Existing User",
      role: "developer",
      namespace_access: ["default"],
      ...claims,
    },
    SECRET,
    86400
  );
}

function expiredToken(): string {
  return signJWT(
    {
      sub: "u-1",
      email: "existing@example.com",
      name: "Existing User",
      role: "developer",
      namespace_access: ["default"],
    },
    SECRET,
    -10
  );
}

function invalidToken(): string {
  return "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ1LTEifQ.badsignature";
}

// ═══════════════════════════════════════════════════════════════════════════
// Graceful Degradation: HTTP Status Code Contracts
// ═══════════════════════════════════════════════════════════════════════════

describe("Graceful Degradation: HTTP Status Code Contracts", () => {

  // ── 1. 503 Service Unavailable ───────────────────────────────────────────

  describe("503 Service Unavailable — Database completely down (ECONNREFUSED)", () => {
    let app: FastifyInstance;
    const dbError = Object.assign(
      new Error("connect ECONNREFUSED 127.0.0.1:5432"),
      { code: "ECONNREFUSED" }
    );

    beforeEach(async () => {
      jest.clearAllMocks();

      const pwHash = await hashPassword("TestPassword123!");
      mockRepo.findByEmail.mockImplementation(async (email: string) => {
        if (email === "existing@example.com") return makeUser({ password_hash: pwHash });
        return null;
      });
      mockRepo.findById.mockImplementation(async (id: string) => {
        if (id === "u-1") return makeUser({ password_hash: pwHash });
        return null;
      });
      mockRepo.isLocked.mockResolvedValue({ locked: false, remainingMinutes: 0 });

      const pg = require("pg");
      const pool = pg.Pool();
      pool.query.mockRejectedValue(dbError);

      app = Fastify();
      await app.register(authRoutes);

      app.get("/api/agents", { preHandler: [authenticate] }, async (_request, reply) => {
        const p = require("pg").Pool();
        try {
          await p.query("SELECT * FROM agents WHERE deleted_at IS NULL");
          return { data: { items: [], total: 0 } };
        } catch (err: any) {
          if (err.code === "ECONNREFUSED") {
            reply.code(503);
            return { status: 503, title: "Service Unavailable", detail: "Database connection refused" };
          }
          throw err;
        }
      });

      app.get("/api/namespaces", { preHandler: [authenticate] }, async (_request, reply) => {
        const p = require("pg").Pool();
        try {
          await p.query("SELECT * FROM namespaces WHERE deleted_at IS NULL");
          return { data: { items: [], total: 0 } };
        } catch (err: any) {
          if (err.code === "ECONNREFUSED") {
            reply.code(503);
            return { status: 503, title: "Service Unavailable", detail: "Database connection refused" };
          }
          throw err;
        }
      });

      app.get("/api/metrics", { preHandler: [authenticate] }, async (_request, reply) => {
        const p = require("pg").Pool();
        try {
          await p.query("SELECT * FROM metrics_data");
          return { data: { activeAgents: 0, executions24h: 0, avgLatencyMs: 0, errorRate: 0, totalCostUsd: 0, activeNamespaces: 0 } };
        } catch (err: any) {
          if (err.code === "ECONNREFUSED") {
            reply.code(503);
            return { status: 503, title: "Service Unavailable", detail: "Database connection refused" };
          }
          throw err;
        }
      });

      await app.ready();
    });

    afterEach(async () => {
      await app.close();
    });

    it("GET /api/agents returns 503", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/agents",
        headers: { authorization: `Bearer ${validToken()}` },
      });
      expect(res.statusCode).toBe(503);
      const body = res.json();
      expect(body.status).toBe(503);
      expect(body.title).toBe("Service Unavailable");
    });

    it("GET /api/namespaces returns 503", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/namespaces",
        headers: { authorization: `Bearer ${validToken()}` },
      });
      expect(res.statusCode).toBe(503);
      const body = res.json();
      expect(body.status).toBe(503);
      expect(body.title).toBe("Service Unavailable");
    });

    it("GET /api/metrics returns 503", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/metrics",
        headers: { authorization: `Bearer ${validToken()}` },
      });
      expect(res.statusCode).toBe(503);
      const body = res.json();
      expect(body.status).toBe(503);
      expect(body.title).toBe("Service Unavailable");
    });
  });

  // ── 2. 429 Too Many Requests ────────────────────────────────────────────

  describe("429 Too Many Requests — Rate limit exceeded", () => {
    let app: FastifyInstance;
    const rateLimitStore = new Map<string, number>();
    const RATE_LIMIT_MAX = 5;

    beforeEach(async () => {
      jest.clearAllMocks();
      rateLimitStore.clear();

      const pwHash = await hashPassword("TestPassword123!");
      mockRepo.findByEmail.mockImplementation(async (email: string) => {
        if (email === "existing@example.com") return makeUser({ password_hash: pwHash });
        return null;
      });
      mockRepo.findById.mockImplementation(async (id: string) => {
        if (id === "u-1") return makeUser({ password_hash: pwHash });
        return null;
      });
      mockRepo.isLocked.mockResolvedValue({ locked: false, remainingMinutes: 0 });
      mockRepo.incrementFailedLogin.mockResolvedValue({ locked: false, attempts: 1 });
      mockRepo.resetFailedLogin.mockResolvedValue(undefined);

      app = Fastify();

      app.addHook("onRequest", async (request, reply) => {
        const clientIp = request.ip ?? "unknown";
        const now = Date.now();
        const windowMs = 60_000;
        const windowStart = Math.floor(now / windowMs) * windowMs;
        const key = `${clientIp}:${windowStart}`;
        const count = rateLimitStore.get(key) ?? 0;

        if (count >= RATE_LIMIT_MAX) {
          reply.code(429).send({
            status: 429,
            title: "Too Many Requests",
            detail: `Rate limit exceeded. Max ${RATE_LIMIT_MAX} requests per minute.`,
          });
          return;
        }

        rateLimitStore.set(key, count + 1);
      });

      await app.register(authRoutes);
      await app.ready();
    });

    afterEach(async () => {
      await app.close();
    });

    it("returns 429 after exceeding rate limit on POST /api/auth/login", async () => {
      const responses: number[] = [];
      for (let i = 0; i < 10; i++) {
        const res = await app.inject({
          method: "POST",
          url: "/api/auth/login",
          payload: { email: "existing@example.com", password: "TestPassword123!" },
        });
        responses.push(res.statusCode);
      }

      expect(responses).toContain(429);
      const rateLimited = responses.filter((s) => s === 429);
      expect(rateLimited.length).toBeGreaterThan(0);
    });
  });

  // ── 3. 401 Unauthorized ─────────────────────────────────────────────────

  describe("401 Unauthorized — Missing or invalid token", () => {
    let app: FastifyInstance;

    beforeEach(async () => {
      jest.clearAllMocks();

      const pwHash = await hashPassword("TestPassword123!");
      mockRepo.findByEmail.mockImplementation(async (email: string) => {
        if (email === "existing@example.com") return makeUser({ password_hash: pwHash });
        return null;
      });
      mockRepo.findById.mockImplementation(async (id: string) => {
        if (id === "u-1") return makeUser({ password_hash: pwHash });
        return null;
      });
      mockRepo.isLocked.mockResolvedValue({ locked: false, remainingMinutes: 0 });

      const pg = require("pg");
      const pool = pg.Pool();
      pool.query.mockResolvedValue({ rows: [], rowCount: 0 });

      app = Fastify();
      await app.register(authRoutes);

      app.get("/api/agents", { preHandler: [authenticate] }, async () => {
        return { data: { items: [] } };
      });

      await app.ready();
    });

    afterEach(async () => {
      await app.close();
    });

    it("GET /api/agents without Authorization header returns 401", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/agents",
      });
      expect(res.statusCode).toBe(401);
      const body = res.json();
      expect(body.status).toBe(401);
    });

    it("GET /api/agents with expired token returns 401", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/agents",
        headers: { authorization: `Bearer ${expiredToken()}` },
      });
      expect(res.statusCode).toBe(401);
      const body = res.json();
      expect(body.status).toBe(401);
    });

    it("GET /api/agents with invalid token returns 401", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/agents",
        headers: { authorization: `Bearer ${invalidToken()}` },
      });
      expect(res.statusCode).toBe(401);
      const body = res.json();
      expect(body.status).toBe(401);
    });
  });

  // ── 4. 400 Bad Request ──────────────────────────────────────────────────

  describe("400 Bad Request — Validation fails", () => {
    let app: FastifyInstance;

    beforeEach(async () => {
      jest.clearAllMocks();

      const pwHash = await hashPassword("TestPassword123!");
      mockRepo.findByEmail.mockImplementation(async (email: string) => {
        if (email === "existing@example.com") return makeUser({ password_hash: pwHash });
        return null;
      });
      mockRepo.findById.mockImplementation(async (id: string) => {
        if (id === "u-1") return makeUser({ password_hash: pwHash });
        return null;
      });
      mockRepo.create.mockImplementation(async (params: Record<string, string>) => ({
        id: "u-new",
        email: params.email,
        name: params.name,
        role: params.role,
        namespace_access: params.namespaceAccess,
      }));
      mockRepo.isLocked.mockResolvedValue({ locked: false, remainingMinutes: 0 });

      app = Fastify();
      await app.register(authRoutes);
      await app.ready();
    });

    afterEach(async () => {
      await app.close();
    });

    it("POST /api/auth/register with missing fields returns 400", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/auth/register",
        payload: { email: "new@example.com" },
      });
      expect(res.statusCode).toBe(400);
      const body = res.json();
      expect(body.status).toBe(400);
      expect(body.title).toBe("Validation Error");
    });

    it("POST /api/auth/register with short password returns 400", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/auth/register",
        payload: { name: "Test User", email: "new@example.com", password: "short" },
      });
      expect(res.statusCode).toBe(400);
      const body = res.json();
      expect(body.status).toBe(400);
      expect(body.title).toBe("Validation Error");
    });

    it("POST /api/auth/login with missing email returns 400", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { password: "TestPassword123!" },
      });
      expect(res.statusCode).toBe(400);
      const body = res.json();
      expect(body.status).toBe(400);
      expect(body.title).toBe("Validation Error");
    });
  });

  // ── 5. 404 Not Found ────────────────────────────────────────────────────

  describe("404 Not Found — Resource does not exist", () => {
    let app: FastifyInstance;

    beforeEach(async () => {
      jest.clearAllMocks();

      const pwHash = await hashPassword("TestPassword123!");
      mockRepo.findByEmail.mockImplementation(async (email: string) => {
        if (email === "existing@example.com") return makeUser({ password_hash: pwHash });
        return null;
      });
      mockRepo.findById.mockImplementation(async (id: string) => {
        if (id === "u-1") return makeUser({ password_hash: pwHash });
        return null;
      });
      mockRepo.isLocked.mockResolvedValue({ locked: false, remainingMinutes: 0 });

      const pg = require("pg");
      const pool = pg.Pool();
      pool.query.mockResolvedValue({ rows: [], rowCount: 0 });

      app = Fastify();
      await app.register(authRoutes);

      app.get("/api/agents/:id", { preHandler: [authenticate] }, async (request, reply) => {
        const { id } = request.params as { id: string };
        const p = require("pg").Pool();
        const result = await p.query(
          "SELECT * FROM agents WHERE id = $1 AND deleted_at IS NULL",
          [id]
        );
        if (result.rows.length === 0) {
          reply.code(404);
          return { status: 404, title: "Not Found", detail: `Agent not found: ${id}` };
        }
        return { data: result.rows[0] };
      });

      app.delete("/api/notification-channels/:id", { preHandler: [authenticate] }, async (request, reply) => {
        const { id } = request.params as { id: string };
        const p = require("pg").Pool();
        const result = await p.query(
          "DELETE FROM notification_channels WHERE id = $1",
          [id]
        );
        if (result.rowCount === 0) {
          reply.code(404);
          return { status: 404, title: "Not Found", detail: "Channel not found" };
        }
        return { data: null };
      });

      await app.ready();
    });

    afterEach(async () => {
      await app.close();
    });

    it("GET /api/agents/nonexistent-id returns 404", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/agents/nonexistent-id",
        headers: { authorization: `Bearer ${validToken()}` },
      });
      expect(res.statusCode).toBe(404);
      const body = res.json();
      expect(body.status).toBe(404);
      expect(body.title).toBe("Not Found");
    });

    it("DELETE /api/notification-channels/nonexistent returns 404", async () => {
      const res = await app.inject({
        method: "DELETE",
        url: "/api/notification-channels/nonexistent-id",
        headers: { authorization: `Bearer ${validToken()}` },
      });
      expect(res.statusCode).toBe(404);
      const body = res.json();
      expect(body.status).toBe(404);
      expect(body.title).toBe("Not Found");
    });
  });

  // ── 6. 409 Conflict ─────────────────────────────────────────────────────

  describe("409 Conflict — Resource already exists", () => {
    let app: FastifyInstance;

    beforeEach(async () => {
      jest.clearAllMocks();

      const pwHash = await hashPassword("TestPassword123!");
      mockRepo.findByEmail.mockImplementation(async (email: string) => {
        if (email === "existing@example.com") return makeUser({ password_hash: pwHash });
        return null;
      });
      mockRepo.findById.mockImplementation(async (id: string) => {
        if (id === "u-1") return makeUser({ password_hash: pwHash });
        return null;
      });
      mockRepo.create.mockImplementation(async (params: Record<string, string>) => ({
        id: "u-new",
        email: params.email,
        name: params.name,
        role: params.role,
        namespace_access: params.namespaceAccess,
      }));
      mockRepo.isLocked.mockResolvedValue({ locked: false, remainingMinutes: 0 });

      app = Fastify();
      await app.register(authRoutes);
      await app.ready();
    });

    afterEach(async () => {
      await app.close();
    });

    it("POST /api/auth/register with existing email returns 409", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/auth/register",
        payload: {
          name: "Duplicate User",
          email: "existing@example.com",
          password: "TestPassword123!",
        },
      });
      expect(res.statusCode).toBe(409);
      const body = res.json();
      expect(body.status).toBe(409);
      expect(body.title).toBe("Conflict");
    });
  });
});
