import { Pool } from "pg";
import crypto from "crypto";
import { hashPassword } from "@e-gaop/shared";

// ─── Types ────────────────────────────────────────────────────────────────

export interface UserRow {
  id: string;
  email: string;
  password_hash: string;
  name: string;
  role: string;
  namespace_access: string[];
  is_active: boolean;
  must_change_password: boolean;
  failed_login_attempts: number;
  locked_until: string | null;
  last_login_at: string | null;
  created_at: string;
  updated_at: string;
}

interface UserRepositoryConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
}

// ─── Repository ───────────────────────────────────────────────────────────

export class UserRepository {
  private pool: Pool;

  constructor(config?: UserRepositoryConfig) {
    this.pool = new Pool({
      host: config?.host ?? process.env.POSTGRES_HOST ?? "postgres",
      port: config?.port ?? parseInt(process.env.POSTGRES_PORT ?? "5432", 10),
      database: config?.database ?? process.env.POSTGRES_DB ?? "egaop",
      user: config?.user ?? process.env.POSTGRES_USER ?? "egaop",
      password:
        config?.password ??
        process.env.POSTGRES_PASSWORD ??
        "",
      max: 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
    });
  }

  async findByEmail(email: string): Promise<UserRow | null> {
    const result = await this.pool.query(
      `SELECT id, email, password_hash, name, role, namespace_access,
              is_active, must_change_password, failed_login_attempts, locked_until,
              last_login_at, created_at, updated_at
       FROM users
       WHERE lower(email) = lower($1) AND deleted_at IS NULL`,
      [email]
    );
    if (result.rows.length === 0) return null;
    const row = result.rows[0]!;
    return {
      ...row,
      namespace_access:
        typeof row["namespace_access"] === "string"
          ? JSON.parse(row["namespace_access"] as string)
          : (row["namespace_access"] as string[]),
    };
  }

  async findById(id: string): Promise<UserRow | null> {
    const result = await this.pool.query(
      `SELECT id, email, password_hash, name, role, namespace_access,
              is_active, must_change_password, failed_login_attempts, locked_until,
              last_login_at, created_at, updated_at
       FROM users
       WHERE id = $1 AND deleted_at IS NULL`,
      [id]
    );
    if (result.rows.length === 0) return null;
    const row = result.rows[0]!;
    return {
      ...row,
      namespace_access:
        typeof row["namespace_access"] === "string"
          ? JSON.parse(row["namespace_access"] as string)
          : (row["namespace_access"] as string[]),
    };
  }

  async create(params: {
    email: string;
    password: string;
    name: string;
    role?: string;
    namespaceAccess?: string[];
    mustChangePassword?: boolean;
  }): Promise<UserRow> {
    const id = crypto.randomUUID();
    const passwordHash = await hashPassword(params.password);
    const role = params.role ?? "developer";
    const namespaceAccess = params.namespaceAccess ?? ["default"];
    const mustChangePassword = params.mustChangePassword ?? false;

    const result = await this.pool.query(
      `INSERT INTO users (id, email, password_hash, name, role, namespace_access, must_change_password)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, email, password_hash, name, role, namespace_access,
                 is_active, must_change_password, failed_login_attempts, locked_until,
                 last_login_at, created_at, updated_at`,
      [id, params.email.toLowerCase(), passwordHash, params.name, role, JSON.stringify(namespaceAccess), mustChangePassword]
    );

    const row = result.rows[0]!;
    return {
      ...row,
      namespace_access:
        typeof row["namespace_access"] === "string"
          ? JSON.parse(row["namespace_access"] as string)
          : (row["namespace_access"] as string[]),
    };
  }

  async incrementFailedLogin(
    email: string
  ): Promise<{ locked: boolean; attempts: number }> {
    const result = await this.pool.query(
      `UPDATE users
       SET failed_login_attempts = failed_login_attempts + 1,
           updated_at = NOW()
       WHERE lower(email) = lower($1) AND deleted_at IS NULL
       RETURNING failed_login_attempts`,
      [email]
    );

    if (result.rows.length === 0) {
      return { locked: false, attempts: 0 };
    }

    const attempts = result.rows[0]!["failed_login_attempts"] as number;

    // Lock after 5 failed attempts
    if (attempts >= 5) {
      await this.pool.query(
        `UPDATE users
         SET locked_until = NOW() + INTERVAL '15 minutes',
             failed_login_attempts = 0,
             updated_at = NOW()
         WHERE lower(email) = lower($1) AND deleted_at IS NULL`,
        [email]
      );
      return { locked: true, attempts: 0 };
    }

    return { locked: false, attempts };
  }

  async resetFailedLogin(email: string): Promise<void> {
    await this.pool.query(
      `UPDATE users
       SET failed_login_attempts = 0,
           locked_until = NULL,
           last_login_at = NOW(),
           updated_at = NOW()
       WHERE lower(email) = lower($1) AND deleted_at IS NULL`,
      [email]
    );
  }

  async clearMustChangePassword(email: string): Promise<void> {
    await this.pool.query(
      `UPDATE users
       SET must_change_password = false,
           updated_at = NOW()
       WHERE lower(email) = lower($1) AND deleted_at IS NULL`,
      [email]
    );
  }

  async isLocked(email: string): Promise<{ locked: boolean; remainingMinutes: number }> {
    const result = await this.pool.query(
      `SELECT locked_until
       FROM users
       WHERE lower(email) = lower($1) AND deleted_at IS NULL`,
      [email]
    );

    if (result.rows.length === 0) {
      return { locked: false, remainingMinutes: 0 };
    }

    const lockedUntil = result.rows[0]!["locked_until"] as string | null;
    if (!lockedUntil) return { locked: false, remainingMinutes: 0 };

    const lockExpiry = new Date(lockedUntil).getTime();
    const now = Date.now();

    if (lockExpiry > now) {
      const remainingMs = lockExpiry - now;
      return { locked: true, remainingMinutes: Math.ceil(remainingMs / 60000) };
    }

    // Lock expired — clear it
    await this.pool.query(
      `UPDATE users SET locked_until = NULL, updated_at = NOW()
       WHERE lower(email) = lower($1) AND deleted_at IS NULL`,
      [email]
    );
    return { locked: false, remainingMinutes: 0 };
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

// ─── Singleton ────────────────────────────────────────────────────────────

let instance: UserRepository | null = null;

export function getUserRepository(): UserRepository {
  if (!instance) {
    instance = new UserRepository();
  }
  return instance;
}

export function resetUserRepository(): void {
  if (instance) {
    instance.close();
    instance = null;
  }
}

// ─── First-boot admin password generation ──────────────────────────────────

export async function ensureAdminUser(repo: UserRepository): Promise<string | null> {
  const existing = await repo.findByEmail("admin@egaop.io");
  if (existing) return null; // Admin already exists

  // Generate a random 16-char password with uppercase, lowercase, digits, and symbols
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*";
  const salt = crypto.randomBytes(16);
  let password = "";
  for (let i = 0; i < 16; i++) {
    password += chars[salt[i]! % chars.length];
  }

  // Ensure it has at least one of each required character type
  const required = ["A", "a", "1", "!"];
  for (let i = 0; i < required.length; i++) {
    if (!password.includes(required[i]!)) {
      const pos = salt[i]! % password.length;
      password = password.substring(0, pos) + required[i] + password.substring(pos + 1);
    }
  }

  await repo.create({
    email: "admin@egaop.io",
    password,
    name: "Platform Admin",
    role: "platform_admin",
    namespaceAccess: ["*"],
    mustChangePassword: true,
  });

  return password;
}
