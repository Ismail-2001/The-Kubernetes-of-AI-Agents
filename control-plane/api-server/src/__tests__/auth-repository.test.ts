jest.mock("pg", () => {
  const mPool = { query: jest.fn(), connect: jest.fn(), end: jest.fn() };
  return { Pool: jest.fn(() => mPool) };
});

import { UserRepository, ensureAdminUser } from "../auth/repository";

let repo: UserRepository;
const users = new Map<string, any>();

beforeEach(() => {
  users.clear();
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Pool } = require("pg");
  const mockPool = new Pool() as { query: jest.Mock; connect: jest.Mock; end: jest.Mock };
  mockPool.query.mockReset();
  mockPool.query.mockImplementation(async (sql: string, params: any[]) => {
    const email = params && params.length > 0 ? String(params[0]).toLowerCase() : "";

    // INSERT INTO users
    if (sql.trimStart().startsWith("INSERT INTO users")) {
      const emailLower = String(params[1]).toLowerCase();
      if (users.has(emailLower)) {
        throw new Error("duplicate key value violates unique constraint");
      }
      const row = {
        id: params[0],
        email: params[1],
        password_hash: params[2],
        name: params[3],
        role: params[4] || "developer",
        namespace_access: params[5] || '["default"]',
        is_active: true,
        must_change_password: params[6] || false,
        failed_login_attempts: 0,
        locked_until: null,
        last_login_at: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        deleted_at: null,
      };
      users.set(emailLower, row);
      return { rows: [row], rowCount: 1 };
    }

    // SELECT with lower(email) = lower($1)
    if (sql.includes("SELECT") && sql.includes("FROM users") && sql.includes("lower(email)")) {
      const user = users.get(email);
      if (!user || user.deleted_at) return { rows: [], rowCount: 0 };
      return { rows: [user], rowCount: 1 };
    }

    // UPDATE ... SET failed_login_attempts = failed_login_attempts + 1 ... RETURNING failed_login_attempts
    if (sql.includes("RETURNING failed_login_attempts")) {
      const user = users.get(email);
      if (!user) return { rows: [], rowCount: 0 };
      const attempts = (user.failed_login_attempts || 0) + 1;
      user.failed_login_attempts = attempts;
      return { rows: [{ failed_login_attempts: attempts }], rowCount: 1 };
    }

    // UPDATE ... SET locked_until = NOW() + INTERVAL '15 minutes' (lock query)
    if (sql.includes("SET locked_until = NOW() + INTERVAL")) {
      const user = users.get(email);
      if (user) {
        user.locked_until = new Date(Date.now() + 15 * 60 * 1000).toISOString();
        user.failed_login_attempts = 0;
      }
      return { rows: [], rowCount: user ? 1 : 0 };
    }

    // UPDATE ... SET failed_login_attempts = 0, locked_until = NULL (reset)
    if (sql.includes("failed_login_attempts = 0") && sql.includes("locked_until = NULL")) {
      const user = users.get(email);
      if (user) {
        user.failed_login_attempts = 0;
        user.locked_until = null;
        user.last_login_at = new Date().toISOString();
      }
      return { rows: [user || {}], rowCount: user ? 1 : 0 };
    }

    // SELECT locked_until (isLocked check)
    if (sql.includes("SELECT locked_until") && sql.includes("FROM users")) {
      const user = users.get(email);
      if (!user) return { rows: [], rowCount: 0 };
      return { rows: [{ locked_until: user.locked_until }], rowCount: 1 };
    }

    // UPDATE SET locked_until = NULL (expired lock clear)
    if (sql.includes("UPDATE users SET locked_until = NULL") && !sql.includes("failed_login_attempts")) {
      const user = users.get(email);
      if (user) user.locked_until = null;
      return { rows: [], rowCount: user ? 1 : 0 };
    }

    // UPDATE ... SET deleted_at = NOW() (soft delete from test)
    if (sql.includes("UPDATE users SET deleted_at")) {
      const id = params[0];
      for (const user of users.values()) {
        if (user.id === id) {
          user.deleted_at = new Date().toISOString();
          break;
        }
      }
      return { rows: [], rowCount: 1 };
    }

    return { rows: [], rowCount: 0 };
  });
  repo = new UserRepository({
    host: "127.0.0.1",
    port: 5432,
    database: "testdb",
    user: "testuser",
    password: "testpass",
  });
});

describe("UserRepository — PostgreSQL persistence", () => {
  it("should create and retrieve a user", async () => {
    if (!repo) return;

    const user = await repo.create({
      email: "test@example.com",
      password: "TestPassword123!",
      name: "Test User",
    });

    expect(user.email).toBe("test@example.com");
    expect(user.name).toBe("Test User");
    expect(user.role).toBe("developer");
    expect(user.is_active).toBe(true);
    expect(user.failed_login_attempts).toBe(0);

    const found = await repo.findByEmail("test@example.com");
    expect(found).not.toBeNull();
    expect(found!.id).toBe(user.id);
  });

  it("should enforce unique email constraint", async () => {
    if (!repo) return;

    await repo.create({
      email: "dup@example.com",
      password: "TestPassword123!",
      name: "First User",
    });

    await expect(
      repo.create({
        email: "dup@example.com",
        password: "TestPassword456!",
        name: "Second User",
      })
    ).rejects.toThrow();
  });

  it("should track failed login attempts and lock account", async () => {
    if (!repo) return;

    const email = "locktest@example.com";
    await repo.create({
      email,
      password: "TestPassword123!",
      name: "Lock Test",
    });

    // 4 failed attempts — should not be locked
    for (let i = 0; i < 4; i++) {
      const result = await repo.incrementFailedLogin(email);
      expect(result.locked).toBe(false);
    }

    // 5th failed attempt — should lock
    const result = await repo.incrementFailedLogin(email);
    expect(result.locked).toBe(true);

    // Check lock status
    const lockStatus = await repo.isLocked(email);
    expect(lockStatus.locked).toBe(true);
    expect(lockStatus.remainingMinutes).toBeGreaterThan(0);
  });

  it("should reset failed login on success", async () => {
    if (!repo) return;

    const email = "reset@example.com";
    await repo.create({
      email,
      password: "TestPassword123!",
      name: "Reset Test",
    });

    // Increment a few times
    await repo.incrementFailedLogin(email);
    await repo.incrementFailedLogin(email);

    // Reset on successful login
    await repo.resetFailedLogin(email);

    const user = await repo.findByEmail(email);
    expect(user!.failed_login_attempts).toBe(0);
    expect(user!.locked_until).toBeNull();
    expect(user!.last_login_at).not.toBeNull();
  });

  it("should persist data across repository instances (restart simulation)", async () => {
    if (!repo) return;

    // Create user with first repo instance
    const email = "persist@example.com";
    const user = await repo.create({
      email,
      password: "TestPassword123!",
      name: "Persist Test",
    });

    // Simulate restart: create new repository instance (same DB)
    const repo2 = new UserRepository({
      host: "127.0.0.1",
      port: 5432,
      database: "testdb",
      user: "testuser",
      password: "testpass",
    });

    try {
      // Data should still be accessible
      const found = await repo2.findByEmail(email);
      expect(found).not.toBeNull();
      expect(found!.id).toBe(user.id);
      expect(found!.email).toBe(email);
      expect(found!.name).toBe("Persist Test");
    } finally {
      await repo2.close();
    }
  });

  it("should generate admin user on first boot", async () => {
    if (!repo) return;

    const password = await ensureAdminUser(repo);
    expect(password).not.toBeNull();
    expect(password!.length).toBeGreaterThanOrEqual(12);

    // Second call should return null (admin already exists)
    const password2 = await ensureAdminUser(repo);
    expect(password2).toBeNull();

    // Verify admin exists in DB with must_change_password
    const admin = await repo.findByEmail("admin@egaop.io");
    expect(admin).not.toBeNull();
    expect(admin!.role).toBe("platform_admin");
    expect(admin!.namespace_access).toEqual(["*"]);
    expect(admin!.must_change_password).toBe(true);
  });

  it("should perform case-insensitive email lookup", async () => {
    if (!repo) return;

    await repo.create({
      email: "case@example.com",
      password: "TestPassword123!",
      name: "Case Test",
    });

    const found = await repo.findByEmail("CASE@EXAMPLE.COM");
    expect(found).not.toBeNull();
    expect(found!.email).toBe("case@example.com");
  });

  it("should return null for non-existent email", async () => {
    if (!repo) return;

    const found = await repo.findByEmail("nonexistent@example.com");
    expect(found).toBeNull();
  });

  it("should return null for deleted users", async () => {
    if (!repo) return;

    const user = await repo.create({
      email: "deleted@example.com",
      password: "TestPassword123!",
      name: "Deleted Test",
    });

    // Soft-delete
    const pool = (repo as unknown as { pool: import("pg").Pool }).pool;
    await pool.query(
      "UPDATE users SET deleted_at = NOW() WHERE id = $1",
      [user.id]
    );

    const found = await repo.findByEmail("deleted@example.com");
    expect(found).toBeNull();
  });
});
