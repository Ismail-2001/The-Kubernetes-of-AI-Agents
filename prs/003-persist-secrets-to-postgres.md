# PR 3 — Persist secrets to Postgres; remove hardcoded credentials

**Title:** `fix(secret-store): persist encrypted secrets to Postgres instead of process memory`

### What was broken

`secret-store` performed real AES-256-GCM encryption but held the encrypted payload in `const encryptedVault: Map<string, string> = new Map()` — a process restart silently erased every secret in the platform. The `CreateSecret` handler logged "Encrypting and persisting new secret to vault" regardless of whether anything durable happened. Separately, a default Grafana admin credential was committed in plaintext in the README.

### What changed

- Added migration `005_secrets.sql` — `secrets` table with UUID PK, `namespace`, `name`, `encrypted_data` (TEXT), `type` (defaults to `'api_key'`), `created_at`, `updated_at`, and `UNIQUE(namespace, name)` constraint.
- Added `SecretRepository` (`secret-store/src/repository.ts`) backed by `pg.Pool` with methods: `upsert()`, `get()`, `delete()`, `list()`, `close()`. All SQL queries against the `secrets` table. Encryption/decryption happens before/after the repository call, so Postgres never sees plaintext.
- Replaced `encryptedVault` Map in `secret-store/src/index.ts` with `new SecretRepository()` (line 50). All gRPC handlers call `repo.upsert()` and `repo.get()`.
- Fixed the "persisting" log line to only fire after a confirmed successful write; DB-unreachable now surfaces a clear error instead of a silent no-op success.
- Removed plaintext Grafana credential from README; documented operator's responsibility to rotate any third-party default credential E-GAOP doesn't directly control.
- `docker-compose.yml:123` now uses `GF_SECURITY_ADMIN_PASSWORD: ${GRAFANA_PASSWORD:?Set GRAFANA_PASSWORD in .env}` — fails fast if not set.
- `.env.example:69-72`: `GRAFANA_USER=admin` and `GRAFANA_PASSWORD=` (empty, requiring user to fill in).
- No `gitleaks` or equivalent was added to CI in this PR — this remains open.

### Evidence

- **Restart-survival**: Migration `005_secrets.sql` explicitly states "Replaces in-memory Map with PostgreSQL-backed encrypted blob storage." `SecretRepository` class at `src/repository.ts` uses `pg.Pool` for all operations. A secret created before a process restart is retrievable after, against the same Postgres instance.
- **No in-memory fallback**: `index.ts:50` instantiates `new SecretRepository()`. No `Map`, `WeakMap`, or in-memory store exists in the secret-store directory. `grep -r "Map\|WeakMap" secret-store/src/` returns no vault-related results.
- **Negative test**: DB unreachable during `CreateSecret` returns a gRPC error; the secret is not silently lost.
- **No hardcoded credentials**: `grep -r "changeme\|admin:admin\|password.*=" README.md .env.example` returns no hardcoded credential strings. README line 329 documents Grafana access as `admin / GRAFANA_PASSWORD from .env`.
- Migration `005_secrets.sql` exists at `migrations/005_secrets.sql` (21 lines). Defines correct schema with indexes on `(namespace, name)` and `(namespace)`.
- `secret-store` tests pass (repository-backed, not Map-backed).

### What's still open

- Key-rotation cadence/procedure: the `secrets` table has no `rotated_at` column or rotation policy. Secrets are stored but never automatically rotated.
- HA/backup strategy for the Postgres-backed secret store is not addressed in this PR.
- A dedicated Vault backend (e.g., HashiCorp Vault) is not integrated — Postgres is used as a pragmatic interim solution.
- `gitleaks` or equivalent secret-scanning CI step was not added in this PR.
