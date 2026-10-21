import { z } from "zod";
import {
  validate,
  PaginationQuerySchema,
  NamespaceQuerySchema,
  IdParamSchema,
  NameParamSchema,
  LoginSchema,
  RegisterSchema,
  ChangePasswordSchema,
  RefreshTokenSchema,
  UpdateAgentSchema,
  CreateAgentSchema,
  RunAgentSchema,
  RollbackAgentSchema,
  AgentListQuerySchema,
  TraceListQuerySchema,
  SLOQuerySchema,
  type ValidationReply,
  type ValidationRequest,
} from "../validation/index.js";

describe("Zod validation schemas", () => {
  describe("PaginationQuerySchema", () => {
    it("defaults page and limit", () => {
      const result = PaginationQuerySchema.safeParse({});
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.page).toBe(1);
        expect(result.data.limit).toBe(20);
      }
    });

    it("coerces string numbers", () => {
      const result = PaginationQuerySchema.safeParse({ page: "3", limit: "50" });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.page).toBe(3);
        expect(result.data.limit).toBe(50);
      }
    });

    it("rejects limit over max 100", () => {
      const result = PaginationQuerySchema.safeParse({ limit: 999 });
      expect(result.success).toBe(false);
    });
  });

  describe("LoginSchema", () => {
    it("accepts valid email+password", () => {
      expect(LoginSchema.safeParse({ email: "a@b.com", password: "pass" }).success).toBe(true);
    });

    it("rejects invalid email", () => {
      expect(LoginSchema.safeParse({ email: "bad", password: "pass" }).success).toBe(false);
    });

    it("rejects empty password", () => {
      expect(LoginSchema.safeParse({ email: "a@b.com", password: "" }).success).toBe(false);
    });
  });

  describe("RegisterSchema", () => {
    it("accepts valid registration", () => {
      const result = RegisterSchema.safeParse({ email: "a@b.com", password: "StrongPass123", name: "Test" });
      expect(result.success).toBe(true);
    });

    it("rejects short password", () => {
      expect(RegisterSchema.safeParse({ email: "a@b.com", password: "short", name: "Test" }).success).toBe(false);
    });

    it("rejects password without uppercase", () => {
      expect(RegisterSchema.safeParse({ email: "a@b.com", password: "alllowercase123", name: "Test" }).success).toBe(false);
    });

    it("rejects missing name", () => {
      expect(RegisterSchema.safeParse({ email: "a@b.com", password: "StrongPass123" }).success).toBe(false);
    });
  });

  describe("ChangePasswordSchema", () => {
    it("accepts valid passwords", () => {
      const result = ChangePasswordSchema.safeParse({ current_password: "old", new_password: "NewStrong123" });
      expect(result.success).toBe(true);
    });

    it("rejects weak new password", () => {
      expect(ChangePasswordSchema.safeParse({ current_password: "old", new_password: "weak" }).success).toBe(false);
    });
  });

  describe("CreateAgentSchema", () => {
    it("requires name", () => {
      expect(CreateAgentSchema.safeParse({}).success).toBe(false);
      expect(CreateAgentSchema.safeParse({ name: "agent-1" }).success).toBe(true);
    });

    it("defaults namespace to default", () => {
      const result = CreateAgentSchema.safeParse({ name: "agent-1" });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.namespace).toBe("default");
      }
    });
  });

  describe("RunAgentSchema", () => {
    it("accepts empty input (optional)", () => {
      expect(RunAgentSchema.safeParse({}).success).toBe(true);
    });

    it("accepts input with prompt", () => {
      expect(RunAgentSchema.safeParse({ input: { prompt: "Hello" } }).success).toBe(true);
    });

    it("accepts input with messages array", () => {
      const result = RunAgentSchema.safeParse({
        input: { messages: [{ role: "user", content: "Hi" }] },
      });
      expect(result.success).toBe(true);
    });
  });

  describe("RollbackAgentSchema", () => {
    it("requires version number", () => {
      expect(RollbackAgentSchema.safeParse({}).success).toBe(false);
      expect(RollbackAgentSchema.safeParse({ version: 1 }).success).toBe(true);
    });
  });

  describe("AgentListQuerySchema", () => {
    it("defaults status to all", () => {
      const result = AgentListQuerySchema.safeParse({});
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.status).toBe("all");
      }
    });
  });

  describe("SLOQuerySchema", () => {
    it("defaults window to 30", () => {
      const result = SLOQuerySchema.safeParse({});
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.window).toBe(30);
      }
    });

    it("rejects window over max 1440", () => {
      const result = SLOQuerySchema.safeParse({ window: 9999 });
      expect(result.success).toBe(false);
    });
  });

  describe("NamespaceQuerySchema", () => {
    it("defaults namespace to default and enforces length", () => {
      const result = NamespaceQuerySchema.safeParse({});
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.namespace).toBe("default");
      }
      expect(NamespaceQuerySchema.safeParse({ namespace: "" }).success).toBe(false);
      expect(NamespaceQuerySchema.safeParse({ namespace: "a".repeat(254) }).success).toBe(false);
    });
  });

  describe("IdParamSchema", () => {
    it("accepts uuid and rejects non-uuid", () => {
      const uuid = "123e4567-e89b-12d3-a456-426614174000";
      expect(IdParamSchema.safeParse({ id: uuid }).success).toBe(true);
      expect(IdParamSchema.safeParse({ id: "not-a-uuid" }).success).toBe(false);
    });
  });

  describe("NameParamSchema", () => {
    it("accepts valid DNS label", () => {
      expect(NameParamSchema.safeParse({ name: "my-agent-1" }).success).toBe(true);
    });

    it("rejects invalid DNS label", () => {
      expect(NameParamSchema.safeParse({ name: "-leading" }).success).toBe(false);
      expect(NameParamSchema.safeParse({ name: "UPPER" }).success).toBe(false);
      expect(NameParamSchema.safeParse({ name: "" }).success).toBe(false);
    });
  });

  describe("RefreshTokenSchema", () => {
    it("accepts empty object (cookie case) and provided token", () => {
      expect(RefreshTokenSchema.safeParse({}).success).toBe(true);
      expect(RefreshTokenSchema.safeParse({ refresh_token: "abc" }).success).toBe(true);
      expect(RefreshTokenSchema.safeParse({ refresh_token: "" }).success).toBe(false);
    });
  });

  describe("UpdateAgentSchema", () => {
    it("rejects empty patch and accepts non-empty patch", () => {
      expect(UpdateAgentSchema.safeParse({}).success).toBe(false);
      expect(UpdateAgentSchema.safeParse({ labels: { team: "x" } }).success).toBe(true);
    });
  });

  describe("TraceListQuerySchema", () => {
    it("extends pagination and defaults namespace", () => {
      const result = TraceListQuerySchema.safeParse({});
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.page).toBe(1);
        expect(result.data.namespace).toBe("default");
      }
    });
  });
});

// ── validate() preHandler middleware ─────────────────────────────────────────

describe("validate() middleware", () => {
  function makeReply(headers: Record<string, unknown> = {}) {
    const reply: ValidationReply = {
      getHeader: jest.fn((name: string) => headers[name]),
      status: jest.fn(() => reply),
      send: jest.fn(),
    };
    return reply;
  }

  it("replaces parsed body on success without responding", async () => {
    const request = { body: { page: "2", limit: "50" }, url: "/agents" } as ValidationRequest;
    const reply = makeReply({ "X-Request-ID": "trace-abc" });

    await validate("body", PaginationQuerySchema)(request, reply);

    expect(reply.status).not.toHaveBeenCalled();
    expect(reply.send).not.toHaveBeenCalled();
    expect(request.body).toEqual({ page: 2, limit: 50 });
  });

  it("sends RFC 7807 problem with traceId on failure", async () => {
    const request = { body: { limit: 9999 }, url: "/agents" } as ValidationRequest;
    const reply = makeReply({ "X-Request-ID": "trace-abc" });

    await validate("body", PaginationQuerySchema)(request, reply);

    expect(reply.status).toHaveBeenCalledWith(400);
    const problem = reply.send.mock.calls[0][0] as {
      type: string;
      status: number;
      instance: string;
      traceId: string;
      detail: string;
      errors: Array<{ path: string; code: string }>;
    };
    expect(problem.type).toBe("https://api.egaop.io/errors/validation");
    expect(problem.status).toBe(400);
    expect(problem.instance).toBe("/agents");
    expect(problem.traceId).toBe("trace-abc");
    expect(problem.detail).toContain("1 error(s)");
    expect(problem.errors[0].path).toBe("limit");
    expect(problem.errors[0].code).toBe("too_big");
    expect(request.body).toEqual({ limit: 9999 });
  });

  it("validates and replaces query params", async () => {
    const request = { query: { page: "3" }, url: "/traces" } as ValidationRequest;
    const reply = makeReply({ "X-Request-ID": "trace-q" });

    await validate("query", PaginationQuerySchema)(request, reply);

    expect(reply.status).not.toHaveBeenCalled();
    expect(request.query).toEqual({ page: 3, limit: 20 });
  });

  it("validates and replaces route params", async () => {
    const request = {
      params: { id: "123e4567-e89b-12d3-a456-426614174000" },
      url: "/agents/123e4567-e89b-12d3-a456-426614174000",
    } as ValidationRequest;
    const reply = makeReply({ "X-Request-ID": "trace-p" });

    await validate("params", IdParamSchema)(request, reply);

    expect(reply.status).not.toHaveBeenCalled();
    expect((request.params as { id: string }).id).toBe("123e4567-e89b-12d3-a456-426614174000");
  });

  it("generates a traceId when the request-id header is absent", async () => {
    const request = { body: { limit: 9999 }, url: "/agents" } as ValidationRequest;
    const reply = makeReply();

    await validate("body", PaginationQuerySchema)(request, reply);

    const problem = reply.send.mock.calls[0][0] as { traceId: string };
    expect(problem.traceId).toMatch(/^[0-9a-f-]{36}$/i);
  });

  it("generates a traceId when getHeader throws", async () => {
    const request = { body: { limit: 9999 }, url: "/agents" } as ValidationRequest;
    const reply: ValidationReply = {
      getHeader: jest.fn(() => {
        throw new Error("header access failed");
      }),
      status: jest.fn(() => reply),
      send: jest.fn(),
    };

    await validate("body", PaginationQuerySchema)(request, reply);

    expect(reply.status).toHaveBeenCalledWith(400);
    const problem = reply.send.mock.calls[0][0] as { traceId: string };
    expect(problem.traceId).toMatch(/^[0-9a-f-]{36}$/i);
  });
});
