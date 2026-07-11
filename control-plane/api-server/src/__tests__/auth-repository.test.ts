import { UserRepository, ensureAdminUser } from "../auth/repository";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { GenericContainer, Wait } = require("testcontainers");

// ─── Test with real PostgreSQL via testcontainers ──────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let pgContainer: any = null;
let repo: UserRepository | null = null;
let postgresPort = 0;

beforeAll(async () => {
  const container = await new GenericContainer("postgres:15")
    .withEnvironment({
      POSTGRES_USER: "testuser",
      POSTGRES_PASSWORD: "testpass",
      POSTGRES_DB: "testdb",
    })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage("database system is ready to accept connections", 2))
    .withStartupTimeout(120000)
    .start();

  pgContainer = container;
  postgresPort = container.getMappedPort(5432);

  // Run migrations
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Client } = require("pg");
  const client = new Client({
    host: "127.0.0.1",
    port: postgresPort,
    user: "testuser",
    password: "testpass",
    database: "testdb",
  });
  await client.connect();

  // Create users table (subset of migration 004)
  await client.query(`
    CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

    DO $$
    BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'user_role') THEN
            CREATE TYPE user_role AS ENUM ('platform_admin', 'namespace_admin', 'developer', 'viewer');
        END IF;
    END $$;

    CREATE TABLE IF NOT EXISTS users (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        email VARCHAR(255) NOT NULL UNIQUE,
        password_hash VARCHAR(255) NOT NULL,
        name VARCHAR(255) NOT NULL,
        role user_role NOT NULL DEFAULT 'developer',
        namespace_access JSONB NOT NULL DEFAULT '[]',
        is_active BOOLEAN NOT NULL DEFAULT true,
        must_change_password BOOLEAN NOT NULL DEFAULT false,
        last_login_at TIMESTAMPTZ,
        failed_login_attempts INT NOT NULL DEFAULT 0,
        locked_until TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        deleted_at TIMESTAMPTZ
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users (lower(email)) WHERE deleted_at IS NULL;
  `);
  await client.end();

  // Create repository connected to test DB
  repo = new UserRepository({
    host: "127.0.0.1",
    port: postgresPort,
    database: "testdb",
    user: "testuser",
    password: "testpass",
  });
}, 180000);

afterAll(async () => {
  if (repo) await repo.close();
  if (pgContainer) await pgContainer.stop();
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
      port: postgresPort,
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
