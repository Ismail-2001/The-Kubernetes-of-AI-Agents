import { z, ZodSchema, ZodError } from "zod";
import type { FastifyRequest, FastifyReply } from "fastify";

// ── RFC 7807 Problem Details for validation errors ──────────────────────────

export interface ValidationProblem {
  type: string;
  title: string;
  status: number;
  detail: string;
  instance: string;
  traceId: string;
  errors: Array<{
    path: string;
    message: string;
    code: string;
  }>;
}

function formatZodError(err: ZodError, instance: string, traceId: string): ValidationProblem {
  return {
    type: "https://api.egaop.io/errors/validation",
    title: "Validation Error",
    status: 400,
    detail: `Request validation failed: ${err.issues.length} error(s)`,
    instance,
    traceId,
    errors: err.issues.map((issue) => ({
      path: issue.path.join("."),
      message: issue.message,
      code: issue.code,
    })),
  };
}

// ── Validation targets ──────────────────────────────────────────────────────

type ValidationTarget = "body" | "query" | "params";

// ── validate() middleware factory ────────────────────────────────────────────
// Returns a Fastify preHandler that validates the specified request property.

export function validate<T extends ZodSchema>(
  target: ValidationTarget,
  schema: T,
) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const traceId = (reply.getHeader("X-Request-ID") as string) || crypto.randomUUID();
    let data: unknown;

    switch (target) {
      case "body":
        data = request.body;
        break;
      case "query":
        data = request.query;
        break;
      case "params":
        data = request.params;
        break;
    }

    const result = schema.safeParse(data);
    if (!result.success) {
      const problem = formatZodError(result.error, request.url, traceId);
      reply.status(400).send(problem);
      return;
    }

    // Replace with parsed (coerced/defaulted) values
    switch (target) {
      case "body":
        (request as any).body = result.data;
        break;
      case "query":
        (request as any).query = result.data;
        break;
      case "params":
        (request as any).params = result.data;
        break;
    }
  };
}

// ── Common reusable schemas ─────────────────────────────────────────────────

export const PaginationQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export const NamespaceQuerySchema = z.object({
  namespace: z.string().min(1).max(253).default("default"),
});

export const IdParamSchema = z.object({
  id: z.string().uuid(),
});

export const NameParamSchema = z.object({
  name: z.string().min(1).max(253).regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/, "Must be a valid DNS label"),
});

// ── Auth schemas ────────────────────────────────────────────────────────────

export const LoginSchema = z.object({
  email: z.string().email("Invalid email address"),
  password: z.string().min(1, "Password is required"),
});

export const RegisterSchema = z.object({
  email: z.string().email("Invalid email address"),
  password: z
    .string()
    .min(12, "Password must be at least 12 characters")
    .regex(/[A-Z]/, "Password must contain at least one uppercase letter")
    .regex(/[a-z]/, "Password must contain at least one lowercase letter")
    .regex(/[0-9]/, "Password must contain at least one number"),
  name: z.string().min(1, "Name is required").max(255),
});

export const ChangePasswordSchema = z.object({
  current_password: z.string().min(1, "Current password is required"),
  new_password: z
    .string()
    .min(12, "Password must be at least 12 characters")
    .regex(/[A-Z]/, "Password must contain at least one uppercase letter")
    .regex(/[a-z]/, "Password must contain at least one lowercase letter")
    .regex(/[0-9]/, "Password must contain at least one number"),
});

export const RefreshTokenSchema = z.object({
  refresh_token: z.string().min(1, "Refresh token is required"),
}).partial(); // Either cookie or body is acceptable

// ── Agent schemas ───────────────────────────────────────────────────────────

export const CreateAgentSchema = z.object({
  name: z.string().min(1, "Agent name is required").max(253),
  namespace: z.string().min(1).max(253).default("default"),
  spec: z.record(z.unknown()).optional(),
  labels: z.record(z.string()).optional(),
  annotations: z.record(z.string()).optional(),
});

export const UpdateAgentSchema = z.object({
  namespace: z.string().min(1).max(253).optional(),
  spec: z.record(z.unknown()).optional(),
  labels: z.record(z.string()).optional(),
  annotations: z.record(z.string()).optional(),
}).refine((obj) => Object.keys(obj).length > 0, "At least one field must be provided");

export const RunAgentSchema = z.object({
  input: z.object({
    systemPrompt: z.string().optional(),
    prompt: z.string().optional(),
    messages: z.array(z.object({
      role: z.enum(["system", "user", "assistant"]),
      content: z.string(),
    })).optional(),
  }).optional(),
  namespace: z.string().min(1).max(253).default("default"),
  resourceNamespace: z.string().optional(),
  callerRole: z.string().optional(),
});

export const RollbackAgentSchema = z.object({
  version: z.number().int().min(1, "Version number is required"),
  namespace: z.string().min(1).max(253).default("default"),
});

export const AgentListQuerySchema = PaginationQuerySchema.extend({
  namespace: z.string().min(1).max(253).default("default"),
  status: z.enum(["running", "stopped", "error", "deploying", "all"]).default("all"),
  search: z.string().max(255).optional(),
});

// ── Namespace schemas ───────────────────────────────────────────────────────
// CreateNamespaceSchema and UpdateNamespaceSchema are defined in
// namespaces/model.ts and re-exported from the shared package index.
// Do NOT re-export them here to avoid duplicate identifier errors.

// ── Trace/Metrics schemas ───────────────────────────────────────────────────

export const TraceListQuerySchema = PaginationQuerySchema.extend({
  namespace: z.string().min(1).max(253).default("default"),
});

export const SLOQuerySchema = z.object({
  window: z.coerce.number().int().min(1).max(1440).default(30),
});

export { z, type ZodSchema, type ZodError };
