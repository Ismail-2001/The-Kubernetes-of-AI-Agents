#!/usr/bin/env node
import pg from "pg";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(__dirname, "../migrations");
const ADVISORY_LOCK_ID = 90125;

function usage() {
  console.log(`
Usage: node scripts/migrate.mjs <command> [options]

Commands:
  up        Apply all pending migrations
  down      Roll back last migration (add --count=N for N steps)
  status    Show applied vs pending migrations
  create    Create a new migration file (must set --name)

Options:
  --name=<name>      Name for the new migration (used with 'create')
  --count=<N>        Number of migrations to roll back (used with 'down', default 1)
  --dry-run          Preview without applying
  --connection=<str> Postgres connection string (default: POSTGRES_URL env var)
  --dir=<path>       Migration files directory (default: migrations/)

Examples:
  node scripts/migrate.mjs up
  node scripts/migrate.mjs down --count=2 --dry-run
  node scripts/migrate.mjs status
  node scripts/migrate.mjs create --name=add_api_keys_index
`.trim());
  process.exit(1);
}

function parseArgs() {
  const args = process.argv.slice(2);
  const command = args.find((a) => !a.startsWith("--")) || "help";
  const opts = {};
  for (const arg of args) {
    if (arg === "--dry-run") opts.dryRun = true;
    if (arg.startsWith("--name=")) opts.name = arg.split("=")[1];
    if (arg.startsWith("--count=")) opts.count = parseInt(arg.split("=")[1], 10) || 1;
    if (arg.startsWith("--connection=")) opts.connection = arg.split("=")[1];
    if (arg.startsWith("--dir=")) opts.dir = arg.split("=")[1];
  }
  opts.connection = opts.connection || process.env.POSTGRES_URL;
  if (!opts.connection) {
    console.error("ERROR: POSTGRES_URL env var or --connection flag required");
    process.exit(1);
  }
  opts.dir = opts.dir || MIGRATIONS_DIR;
  return { command, opts };
}

async function withLock(pool, fn) {
  const client = await pool.connect();
  try {
    await client.query("SET lock_timeout = '10s'");
    await client.query("SELECT pg_advisory_lock($1)", [ADVISORY_LOCK_ID]);
    try {
      return await fn(client);
    } finally {
      await client.query("SELECT pg_advisory_unlock($1)", [ADVISORY_LOCK_ID]);
    }
  } finally {
    client.release();
  }
}

function loadMigrations(dir) {
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".sql") && !f.endsWith(".down.sql"));
  const migrations = files.sort().map((file) => {
    const match = file.match(/^(\d+)[_-]*(.*)\.sql$/);
    if (!match) return null;
    const version = parseInt(match[1], 10);
    const name = match[2].replace(/[-_]/g, " ");
    const upSql = fs.readFileSync(path.join(dir, file), "utf-8");
    const downFile = path.join(dir, file.replace(".sql", ".down.sql"));
    const downSql = fs.existsSync(downFile) ? fs.readFileSync(downFile, "utf-8") : null;
    return { version, name, file, upSql, downSql };
  }).filter(Boolean);
  return migrations;
}

async function ensureSchemaTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version     INT PRIMARY KEY,
      name        VARCHAR(255) NOT NULL,
      applied_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      checksum    VARCHAR(64) NOT NULL,
      dirty       BOOLEAN NOT NULL DEFAULT false
    )
  `);
}

async function getApplied(client) {
  const result = await client.query(
    "SELECT version, name, applied_at, checksum, dirty FROM schema_version ORDER BY version"
  );
  return result.rows;
}

async function cmdUp(pool, opts) {
  const migrations = loadMigrations(opts.dir);
  if (migrations.length === 0) {
    console.log("No migration files found");
    return;
  }

  await withLock(pool, async (client) => {
    await ensureSchemaTable(client);
    const applied = await getApplied(client);
    const appliedVersions = new Set(applied.map((r) => r.version));

    const pending = migrations.filter((m) => !appliedVersions.has(m.version));
    if (pending.length === 0) {
      console.log("Database is up to date — no pending migrations");
      return;
    }

    console.log(`Found ${pending.length} pending migration(s):`);
    for (const m of pending) {
      console.log(`  ${m.version}: ${m.name}`);
    }
    console.log("");

    for (const m of pending) {
      const checksum = cryptoHash(m.upSql);
      console.log(`Applying ${m.version}: ${m.name}...`);

      if (opts.dryRun) {
        console.log("  [DRY-RUN] would apply");
        continue;
      }

      try {
        await client.query("BEGIN");
        await client.query(m.upSql);
        await client.query(
          "INSERT INTO schema_version (version, name, checksum) VALUES ($1, $2, $3)",
          [m.version, m.name, checksum]
        );
        await client.query("COMMIT");
        console.log("  OK");
      } catch (err) {
        await client.query("ROLLBACK");
        console.error(`  FAILED: ${err.message}`);
        process.exit(1);
      }
    }
  });
}

async function cmdDown(pool, opts) {
  const count = opts.count || 1;

  await withLock(pool, async (client) => {
    await ensureSchemaTable(client);
    const applied = await getApplied(client);
    const toRevert = applied.slice(-count).reverse();

    if (toRevert.length === 0) {
      console.log("No migrations to roll back");
      return;
    }

    console.log(`Rolling back ${toRevert.length} migration(s):`);
    for (const m of toRevert) {
      console.log(`  ${m.version}: ${m.name}`);
    }

    for (const row of toRevert) {
      const mig = loadMigrations(opts.dir).find((m) => m.version === row.version);
      if (!mig || !mig.downSql) {
        console.error(`  Cannot roll back ${row.version}: no down migration found`);
        process.exit(1);
      }

      console.log(`Reverting ${row.version}: ${row.name}...`);
      if (opts.dryRun) {
        console.log("  [DRY-RUN] would revert");
        continue;
      }

      try {
        await client.query("BEGIN");
        await client.query(mig.downSql);
        await client.query("DELETE FROM schema_version WHERE version = $1", [row.version]);
        await client.query("COMMIT");
        console.log("  OK");
      } catch (err) {
        await client.query("ROLLBACK");
        console.error(`  FAILED: ${err.message}`);
        process.exit(1);
      }
    }
  });
}

async function cmdStatus(pool, opts) {
  const migrations = loadMigrations(opts.dir);
  if (migrations.length === 0) {
    console.log("No migration files found in", opts.dir);
    return;
  }

  await withLock(pool, async (client) => {
    await ensureSchemaTable(client);
    const applied = await getApplied(client);
    const appliedMap = new Map(applied.map((r) => [r.version, r]));

    const maxVersion = Math.max(...migrations.map((m) => m.version));
    const padLen = String(maxVersion).length;

    console.log("Migration Status:");
    console.log("─".repeat(70));
    console.log("  VERSION  NAME                                          STATUS       ");
    console.log("─".repeat(70));

    for (const m of migrations) {
      const a = appliedMap.get(m.version);
      const v = String(m.version).padStart(padLen);
      const name = m.name.padEnd(46);
      if (a) {
        const ts = new Date(a.applied_at).toISOString().replace("T", " ").slice(0, 19);
        console.log(`  ${v}      ${name} ${"APPLIED".padStart(12)}  ${ts}`);
      } else {
        console.log(`  ${v}      ${name} ${"PENDING".padStart(12)}`);
      }
    }
    console.log("─".repeat(70));
    console.log(`${applied.length} applied, ${migrations.length - applied.length} pending`);
  });
}

async function cmdCreate(opts) {
  if (!opts.name) {
    console.error("ERROR: --name is required for 'create' command");
    process.exit(1);
  }
  const dir = opts.dir;
  const existing = fs.readdirSync(dir).filter((f) => f.endsWith(".sql"));
  const maxVersion = existing.reduce((max, f) => {
    const m = f.match(/^(\d+)/);
    return m ? Math.max(max, parseInt(m[1], 10)) : max;
  }, 0);
  const nextVersion = String(maxVersion + 1).padStart(3, "0");
  const slug = opts.name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
  const filename = `${nextVersion}_${slug}.sql`;
  const filepath = path.join(dir, filename);

  if (fs.existsSync(filepath)) {
    console.error(`ERROR: ${filepath} already exists`);
    process.exit(1);
  }

  const template = `-- Migration ${nextVersion}: ${opts.name}
-- Created: ${new Date().toISOString()}

BEGIN;

-- TODO: write your migration here

COMMIT;
`;
  fs.writeFileSync(filepath, template, "utf-8");
  console.log(`Created: ${filepath}`);

  const downFilepath = path.join(dir, filename.replace(".sql", ".down.sql"));
  if (!fs.existsSync(downFilepath)) {
    const downTemplate = `-- Migration ${nextVersion}: ${opts.name} (rollback)
-- Created: ${new Date().toISOString()}

BEGIN;

-- TODO: revert the up migration here

COMMIT;
`;
    fs.writeFileSync(downFilepath, downTemplate, "utf-8");
    console.log(`Created: ${downFilepath}`);
  }
}

function cryptoHash(str) {
  return crypto.createHash("sha256").update(str).digest("hex").slice(0, 16);
}

async function main() {
  const { command, opts } = parseArgs();

  let pool;
  if (command !== "create" && command !== "help") {
    pool = new pg.Pool({
      connectionString: opts.connection,
      max: 1,
      connectionTimeoutMillis: 10000,
    });
  }

  try {
    switch (command) {
      case "up":
        await cmdUp(pool, opts);
        break;
      case "down":
        await cmdDown(pool, opts);
        break;
      case "status":
        await cmdStatus(pool, opts);
        break;
      case "create":
        await cmdCreate(opts);
        break;
      default:
        usage();
    }
  } finally {
    if (pool) await pool.end().catch(() => {});
  }
}

main().catch((err) => {
  console.error("Migration failed:", err.message);
  process.exit(1);
});
