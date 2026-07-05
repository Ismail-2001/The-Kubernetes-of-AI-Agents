import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import crypto from "crypto";
import { hashPassword, comparePassword, signJWT, verifyJWT, type JWTClaims } from "@e-gaop/shared";

const JWT_SECRET = process.env.JWT_SECRET || "";
const JWT_EXPIRES_SEC = 86400; // 24 hours

interface UserRow {
  id: string;
  email: string;
  password_hash: string;
  name: string;
  role: string;
  namespace_access: string[];
  is_active: boolean;
  failed_login_attempts: number;
  locked_until: string | null;
  last_login_at: string | null;
}

// ── In-memory user store (replace with DB when pg is available) ──────────────
// This is a temporary solution. In production, use PostgreSQL directly.
const users = new Map<string, UserRow>();

// Seed default admin
const adminId = crypto.randomUUID();
const adminHash = hashPasswordSync("changeme123456!");
users.set("admin@egaop.io", {
  id: adminId,
  email: "admin@egaop.io",
  password_hash: adminHash,
  name: "Platform Admin",
  role: "platform_admin",
  namespace_access: ["*"],
  is_active: true,
  failed_login_attempts: 0,
  locked_until: null,
  last_login_at: null,
});

function hashPasswordSync(password: string): string {
  const salt = crypto.randomBytes(32);
  const hash = crypto.scryptSync(password, salt, 64, {
    cost: 16384,
    blockSize: 8,
    parallelization: 1,
  });
  return `scrypt:16384:8:1:${salt.toString("base64")}:${hash.toString("base64")}`;
}

function comparePasswordSync(password: string, storedHash: string): boolean {
  const parts = storedHash.split(":");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;

  const cost = parseInt(parts[1] ?? "0", 10);
  const blockSize = parseInt(parts[2] ?? "0", 10);
  const parallelization = parseInt(parts[3] ?? "0", 10);
  const salt = Buffer.from(parts[4] ?? "", "base64");
  const expectedHash = Buffer.from(parts[5] ?? "", "base64");

  const hash = crypto.scryptSync(password, salt, 64, {
    cost,
    blockSize,
    parallelization,
  });

  return crypto.timingSafeEqual(hash, expectedHash);
}

// ── Auth middleware ──────────────────────────────────────────────────────────

export async function authenticate(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  let token: string | null = null;

  // Check Authorization header first
  const authHeader = request.headers.authorization;
  if (authHeader?.startsWith("Bearer ")) {
    token = authHeader.slice(7);
  }

  // Fallback to cookie
  if (!token) {
    const cookies = request.cookies;
    token = cookies?.egaop_token ?? null;
  }

  if (!token) {
    reply.code(401).send({ error: { message: "Missing or invalid authorization header", code: "UNAUTHORIZED" } });
    return;
  }

  const claims = verifyJWT(token, JWT_SECRET);
  if (!claims) {
    reply.code(401).send({ error: { message: "Invalid or expired token", code: "UNAUTHORIZED" } });
    return;
  }

  // Attach claims to request for downstream use
  (request as any).user = claims;
}

// ── Auth routes ─────────────────────────────────────────────────────────────

export async function authRoutes(fastify: FastifyInstance): Promise<void> {
  // POST /api/auth/register
  fastify.post("/api/auth/register", async (request, reply) => {
    const body = request.body as { name?: string; email?: string; password?: string };

    if (!body?.email || !body?.password || !body?.name) {
      reply.code(400).send({ error: { message: "Name, email, and password are required", code: "VALIDATION_ERROR" } });
      return;
    }

    const email = body.email.toLowerCase().trim();
    const password = body.password;

    // Validate password strength
    if (password.length < 12) {
      reply.code(400).send({ error: { message: "Password must be at least 12 characters", code: "VALIDATION_ERROR" } });
      return;
    }

    if (!/[A-Z]/.test(password) || !/[a-z]/.test(password) || !/[0-9]/.test(password)) {
      reply.code(400).send({ error: { message: "Password must contain uppercase, lowercase, and numbers", code: "VALIDATION_ERROR" } });
      return;
    }

    // Check if user already exists
    if (users.has(email)) {
      reply.code(409).send({ error: { message: "An account with this email already exists", code: "CONFLICT" } });
      return;
    }

    const id = crypto.randomUUID();
    const passwordHash = await hashPassword(password);

    const user: UserRow = {
      id,
      email,
      password_hash: passwordHash,
      name: body.name.trim(),
      role: "developer",
      namespace_access: ["default"],
      is_active: true,
      failed_login_attempts: 0,
      locked_until: null,
      last_login_at: null,
    };

    users.set(email, user);

    // Generate JWT
    const claims: Omit<JWTClaims, "iat" | "exp"> = {
      sub: id,
      email,
      name: user.name,
      role: user.role,
      namespace_access: user.namespace_access,
    };
    const token = signJWT(claims, JWT_SECRET, JWT_EXPIRES_SEC);

    return {
      data: {
        user: { id, email, name: user.name, role: user.role },
        token,
      },
      meta: { traceId: crypto.randomUUID(), timestamp: new Date().toISOString() },
    };
  });

  // POST /api/auth/login
  fastify.post("/api/auth/login", async (request, reply) => {
    const body = request.body as { email?: string; password?: string };

    if (!body?.email || !body?.password) {
      reply.code(400).send({ error: { message: "Email and password are required", code: "VALIDATION_ERROR" } });
      return;
    }

    const email = body.email.toLowerCase().trim();
    const user = users.get(email);

    if (!user) {
      // Always return same error for invalid email/password to prevent enumeration
      reply.code(401).send({ error: { message: "Invalid email or password", code: "INVALID_CREDENTIALS" } });
      return;
    }

    if (!user.is_active) {
      reply.code(403).send({ error: { message: "Account is deactivated", code: "ACCOUNT_DISABLED" } });
      return;
    }

    // Check lockout
    if (user.locked_until && new Date(user.locked_until) > new Date()) {
      const remainingMs = new Date(user.locked_until).getTime() - Date.now();
      const remainingMin = Math.ceil(remainingMs / 60000);
      reply.code(429).send({
        error: {
          message: `Account is locked. Try again in ${remainingMin} minute${remainingMin > 1 ? "s" : ""}`,
          code: "ACCOUNT_LOCKED",
        },
      });
      return;
    }

    const valid = await comparePassword(body.password, user.password_hash);

    if (!valid) {
      user.failed_login_attempts++;

      // Lock after 5 failed attempts
      if (user.failed_login_attempts >= 5) {
        user.locked_until = new Date(Date.now() + 15 * 60 * 1000).toISOString(); // 15 minutes
        user.failed_login_attempts = 0;
      }

      reply.code(401).send({ error: { message: "Invalid email or password", code: "INVALID_CREDENTIALS" } });
      return;
    }

    // Reset failed attempts on success
    user.failed_login_attempts = 0;
    user.locked_until = null;
    user.last_login_at = new Date().toISOString();

    // Generate JWT
    const claims: Omit<JWTClaims, "iat" | "exp"> = {
      sub: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      namespace_access: user.namespace_access,
    };
    const token = signJWT(claims, JWT_SECRET, JWT_EXPIRES_SEC);

    return {
      data: {
        user: { id: user.id, email: user.email, name: user.name, role: user.role },
        token,
      },
      meta: { traceId: crypto.randomUUID(), timestamp: new Date().toISOString() },
    };
  });

  // GET /api/auth/me (protected)
  fastify.get("/api/auth/me", { preHandler: [authenticate] }, async (request) => {
    const claims = (request as any).user as JWTClaims;
    return {
      data: {
        id: claims.sub,
        email: claims.email,
        name: claims.name,
        role: claims.role,
        namespace_access: claims.namespace_access,
      },
      meta: { traceId: crypto.randomUUID(), timestamp: new Date().toISOString() },
    };
  });

  // POST /api/auth/logout (protected)
  fastify.post("/api/auth/logout", { preHandler: [authenticate] }, async () => {
    // In a real implementation, invalidate the token/session
    return {
      data: { message: "Logged out successfully" },
      meta: { traceId: crypto.randomUUID(), timestamp: new Date().toISOString() },
    };
  });
}
