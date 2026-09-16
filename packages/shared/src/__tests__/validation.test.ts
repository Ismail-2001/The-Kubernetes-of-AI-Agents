import { z } from "zod";
import {
  PaginationQuerySchema,
  LoginSchema,
  RegisterSchema,
  ChangePasswordSchema,
  CreateAgentSchema,
  RunAgentSchema,
  RollbackAgentSchema,
  AgentListQuerySchema,
  SLOQuerySchema,
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
});
