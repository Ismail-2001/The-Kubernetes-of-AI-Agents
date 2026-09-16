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

describe("Auth routes", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    const pwHash = await hashPassword("TestPassword123!");
    mockRepo.findByEmail.mockImplementation(async (email: string) => {
      if (email === "existing@example.com") return makeUser({ password_hash: pwHash });
      if (email === "inactive@example.com") return makeUser({ id: "u-2", email, is_active: false });
      return null;
    });
    mockRepo.findById.mockImplementation(async (id: string) => {
      if (id === "u-1") return makeUser({ password_hash: await hashPassword("TestPassword123!") });
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
    mockRepo.incrementFailedLogin.mockResolvedValue({ locked: false, attempts: 1 });
    mockRepo.resetFailedLogin.mockResolvedValue(undefined);
    mockRepo.clearMustChangePassword.mockResolvedValue(undefined);
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    app = Fastify();
    await app.register(authRoutes);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  describe("POST /api/auth/register", () => {
    it("registers a new user and returns a token", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/auth/register",
        payload: { name: "New User", email: "new@example.com", password: "TestPassword123!" },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.data.token).toBeDefined();
      expect(body.data.user.email).toBe("new@example.com");
      expect(mockRepo.create).toHaveBeenCalled();
    });

    it("returns 400 when required fields are missing", async () => {
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

    it("returns 400 when password is too short", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/auth/register",
        payload: { name: "X", email: "new@example.com", password: "short" },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().status).toBe(400);
    });

    it("returns 400 when password lacks complexity", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/auth/register",
        payload: { name: "X", email: "new@example.com", password: "onlylowercaseletters" },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().status).toBe(400);
    });

    it("returns 409 when email already registered", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/auth/register",
        payload: { name: "X", email: "existing@example.com", password: "TestPassword123!" },
      });
      expect(res.statusCode).toBe(409);
      const body = res.json();
      expect(body.title).toBe("Conflict");
    });
  });

  describe("POST /api/auth/login", () => {
    it("logs in with valid credentials", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { email: "existing@example.com", password: "TestPassword123!" },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.data.token).toBeDefined();
      expect(body.data.user.email).toBe("existing@example.com");
    });

    it("returns 400 when credentials are missing", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { email: "existing@example.com" },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().status).toBe(400);
    });

    it("returns 401 for unknown user", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { email: "nobody@example.com", password: "TestPassword123!" },
      });
      expect(res.statusCode).toBe(401);
    });

    it("returns 401 for deactivated account (same as invalid credentials)", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { email: "inactive@example.com", password: "TestPassword123!" },
      });
      expect(res.statusCode).toBe(401);
      const body = res.json();
      expect(body.title).toBe("Invalid Credentials");
    });

    it("returns 429 when account is locked", async () => {
      mockRepo.isLocked.mockResolvedValueOnce({ locked: true, remainingMinutes: 15 });
      const res = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { email: "existing@example.com", password: "TestPassword123!" },
      });
      expect(res.statusCode).toBe(429);
      const body = res.json();
      expect(body.title).toBe("Account Locked");
    });

    it("returns 401 for wrong password and increments failures", async () => {
      mockRepo.incrementFailedLogin.mockResolvedValueOnce({ locked: true, attempts: 0 });
      const res = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { email: "existing@example.com", password: "WrongPassword123!" },
      });
      expect(res.statusCode).toBe(401);
      expect(mockRepo.incrementFailedLogin).toHaveBeenCalledWith("existing@example.com");
    });
  });

  describe("POST /api/auth/change-password", () => {
    it("changes password for authenticated user", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/auth/change-password",
        headers: { authorization: `Bearer ${validToken()}` },
        payload: { current_password: "TestPassword123!", new_password: "NewPassword456!" },
      });
      expect(res.statusCode).toBe(200);
      expect(mockRepo.pool.query).toHaveBeenCalled();
    });

    it("returns 400 when fields are missing", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/auth/change-password",
        headers: { authorization: `Bearer ${validToken()}` },
        payload: { current_password: "TestPassword123!" },
      });
      expect(res.statusCode).toBe(400);
    });

    it("returns 401 when current password is wrong", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/auth/change-password",
        headers: { authorization: `Bearer ${validToken()}` },
        payload: { current_password: "NotThePassword!", new_password: "NewPassword456!" },
      });
      expect(res.statusCode).toBe(401);
    });

    it("returns 400 when new password is too short", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/auth/change-password",
        headers: { authorization: `Bearer ${validToken()}` },
        payload: { current_password: "TestPassword123!", new_password: "short" },
      });
      expect(res.statusCode).toBe(400);
    });
  });

  describe("GET /api/auth/me", () => {
    it("returns the current user from the token", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/auth/me",
        headers: { authorization: `Bearer ${validToken()}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().data.id).toBe("u-1");
    });

    it("returns 401 without a token", async () => {
      const res = await app.inject({ method: "GET", url: "/api/auth/me" });
      expect(res.statusCode).toBe(401);
    });
  });

  describe("POST /api/auth/logout", () => {
    it("logs out and revokes the token", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/auth/logout",
        headers: { authorization: `Bearer ${validToken()}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().data.message).toContain("revoked");
    });

    it("returns 401 without a token", async () => {
      const res = await app.inject({ method: "POST", url: "/api/auth/logout" });
      expect(res.statusCode).toBe(401);
    });
  });

  describe("authenticate middleware", () => {
    it("rejects requests without a token", async () => {
      const reply = {
        code: jest.fn().mockReturnThis(),
        status: jest.fn().mockReturnThis(),
        send: jest.fn(),
        getHeader: jest.fn().mockReturnValue(undefined),
      } as unknown as import("fastify").FastifyReply;
      await authenticate({ headers: {} } as never, reply);
      expect(reply.status).toHaveBeenCalledWith(401);
    });

    it("rejects requests with an invalid token", async () => {
      const reply = {
        code: jest.fn().mockReturnThis(),
        status: jest.fn().mockReturnThis(),
        send: jest.fn(),
        getHeader: jest.fn().mockReturnValue(undefined),
      } as unknown as import("fastify").FastifyReply;
      await authenticate({ headers: { authorization: "Bearer not-a-jwt" } } as never, reply);
      expect(reply.status).toHaveBeenCalledWith(401);
    });

    it("attaches claims for a valid token", async () => {
      const request: Record<string, unknown> = {
        headers: { authorization: `Bearer ${validToken()}` },
      };
      const reply = {
        code: jest.fn().mockReturnThis(),
        status: jest.fn().mockReturnThis(),
        send: jest.fn(),
        getHeader: jest.fn().mockReturnValue(undefined),
      } as unknown as import("fastify").FastifyReply;
      await authenticate(request as never, reply);
      expect(reply.status).not.toHaveBeenCalled();
      expect((request.user as Record<string, unknown>).sub).toBe("u-1");
    });
  });
});
