# PR 2 — Move auth off in-memory store onto Postgres

**Title:** `fix(api-server): persist users/auth to Postgres instead of an in-memory Map`

### What was broken

The initial audit identified that `control-plane/api-server/src/auth/routes.ts` held all user accounts in a `const users = new Map<string, UserRow>()`. A process restart erased every account. A complete Postgres schema already existed at `migrations/004_users_and_auth.sql` (roles, lockout fields, soft delete) but was not wired in. The seeded default admin credential (`changeme123456!`) was hardcoded in source.

### What changed

- Added `UserRepository` (`control-plane/api-server/src/auth/repository.ts`), backed by `pg.Pool` via `getUserRepository()` singleton, following the same pattern as `memory-plane/src/repository.ts`.
- Replaced all `Map`-based reads/writes in `auth/routes.ts` with repository calls; preserved existing function signatures.
- Enforced `failed_login_attempts` / `locked_until` at the repository layer (`incrementFailedLogin`, `resetFailedLogin` methods).
- Replaced the hardcoded admin seed with `ensureAdminUser()` which generates a random 16-char password on first boot, creates `admin@egaop.io` with `platform_admin` role and `["*"]` namespace access, and sets `mustChangePassword: true` enforced server-side on first login.
- The migration `004_users_and_auth.sql` defines: `user_role` ENUM (`platform_admin`, `namespace_admin`, `developer`, `viewer`), `users` table (UUID PK, email unique, password_hash, name, role, namespace_access JSONB, is_active, must_change_password, last_login_at, failed_login_attempts, locked_until, created_at, updated_at, deleted_at for soft delete), `user_sessions` table, `password_resets` table, and a unique partial index on `lower(email)` WHERE `deleted_at IS NULL`.
- Removed plaintext default credential from README and `.env.example`.

### Evidence

- **Postgres-backed repository confirmed**: `UserRepository` class at `src/auth/repository.ts:33` creates `new pg.Pool(...)` in constructor. All operations (`findByEmail`, `findById`, `create`, `incrementFailedLogin`, etc.) are SQL queries against the `users` table. No `Map`, `WeakMap`, or in-memory fallback exists.
- **Restart-survival**: Since all state is in Postgres, a process restart against the same Postgres instance preserves users and lockout state. The singleton `getUserRepository()` creates a new pool on re-instantiation but connects to the same database.
- **Migration 004 exists and is correct**: 65 lines at `migrations/004_users_and_auth.sql`. Defines all required tables, constraints, and indexes.
- **`ensureAdminUser`**: Generates password via `crypto.randomBytes(12).toString('base64')`, logs at WARN with rotate-immediately notice, sets `must_change_password = true`.
- **No in-memory fallback**: `routes.ts` imports `getUserRepository()` and calls it for every request. No `Map` or in-memory cache exists in the auth directory.
- Auth repository tests exist at `src/__tests__/auth-repository.test.ts` (PostgreSQL persistence tests).

### What's still open

- Password reset flow is defined in the migration (`password_resets` table) but the API route implementation is not yet wired up.
- Session/token expiry policy (the `user_sessions` table has `expires_at` but token refresh logic is not fully implemented).
- The `namespace_access` JSONB field is stored but not enforced at the query level — access checks happen in application code.
