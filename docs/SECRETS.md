# Secret Management

## Required Secrets

| Variable | Purpose | Min Length | Generate |
|:---|:---|:---:|:---|
| `EGAOP_MASTER_ENCRYPTION_KEY` | AES-256-GCM encryption for secret-store | 32 | `openssl rand -hex 32` |
| `JWT_SECRET` | JWT token signing/verification | 32 | `openssl rand -hex 32` |
| `POSTGRES_PASSWORD` | PostgreSQL authentication | 8 | `openssl rand -base64 24` |
| `OPENAI_API_KEY` | OpenAI API access | 10+ | https://platform.openai.com/api-keys |
| `GRAFANA_PASSWORD` | Grafana admin dashboard | 8 | `openssl rand -base64 16` |

## Generating All Secrets

```bash
# Generate all at once
cat > .env << 'EOF'
EGAOP_MASTER_ENCRYPTION_KEY=$(openssl rand -hex 32)
JWT_SECRET=$(openssl rand -hex 32)
POSTGRES_PASSWORD=$(openssl rand -base64 24)
OPENAI_API_KEY=  # your OpenAI API key
GRAFANA_PASSWORD=$(openssl rand -base64 16)
EOF

# Or generate individually
openssl rand -hex 32      # EGAOP_MASTER_ENCRYPTION_KEY, JWT_SECRET
openssl rand -base64 24   # POSTGRES_PASSWORD
openssl rand -base64 16   # GRAFANA_PASSWORD
```

### GitHub Actions CI secrets

```bash
node scripts/generate-secrets.mjs           # fresh set -> secrets/github-secrets.env (gitignored)
node scripts/generate-secrets.mjs --force   # rotate (overwrites existing file)
```

Paste each `NAME=value` into repo → Settings → Secrets and variables → Actions.
Manual fill-ins: `OPENAI_API_KEY`, `SLACK_WEBHOOK`, `AZURE_*` (see `docs/AZURE-SETUP.md`).

## Where Secrets Are Loaded

| Environment | Source | Notes |
|:---|:---|:---|
| Local dev | `.env` file | Loaded by Docker Compose automatically |
| Docker Compose | `.env` file | `${VAR:?...}` syntax fails fast if missing |
| Kubernetes | K8s Secrets | Mounted as env vars or volumes |
| Production (vault) | HashiCorp Vault / AWS Secrets Manager | Injected at runtime via sidecar or SDK |

## Startup Validation

Every service calls `validateSecrets()` from `@e-gaop/shared` before starting:

- Validates all required env vars are present
- Rejects known-bad values: `default`, `changeme`, `secret`, `dev-key-do-not-use-in-production`
- Enforces minimum lengths
- Logs validation result without printing actual values
- **Fails closed**: missing/weak secret = `process.exit(1)`

```
✓ EGAOP_MASTER_ENCRYPTION_KEY validated (64 chars)
✓ JWT_SECRET validated (64 chars)
✓ POSTGRES_PASSWORD validated (32 chars)
✓ OPENAI_API_KEY validated (51 chars)
✓ GRAFANA_PASSWORD validated (22 chars)
```

### Rotation & verification tooling

```bash
./scripts/rotate-secrets.sh --dry-run   # preview rotation (JWT / DB / master key / tokens)
./scripts/verify-secrets.sh             # pre-deploy: presence, length, entropy, DB/Redis connectivity
```

## Key Rotation — `EGAOP_MASTER_ENCRYPTION_KEY`

### How encryption works

- Algorithm: **AES-256-GCM** (12-byte random IV, 16-byte salt, 16-byte auth tag).
- Key derivation: **scrypt** (`cost=16384, blockSize=8, parallelization=1`) over the
  master key material + per-secret random salt. There is no Argon2id in the codebase.
- The stored payload's `keyId` field is a **non-secret label** (e.g. `v1`), never key
  material. Optionally set `EGAOP_MASTER_KEY_ID` to change the label on new writes.
- `decrypt(payload, masterKey)` derives from the master key + the payload's salt. The
  `keyId` label is informational only.

### Legacy rows (pre-hardening)

Rows written before this hardening embedded the master key in the `keyId` field and
mislabelled the KDF as `argon2id`. Those rows still decrypt (same scrypt derivation).
On the next `GetSecret`, secret-store **lazily re-encrypts** the row in place with a
non-embedded `keyId` and truthful KDF metadata. No offline migration job is required;
reads never fail because of the upgrade (upgrade errors are logged, the decrypted
value is still returned).

### Rotation procedure

1. **Keep the old key** accessible (do NOT delete from vault/secrets manager)
2. **Generate a new key**: `openssl rand -hex 32`
3. **Update the env var** with the new key (optionally bump `EGAOP_MASTER_KEY_ID`)
4. **Re-encrypt existing rows** with `reencryptWithNewKey(oldPayload, oldKey, newKey)`
   (used by the lazy-upgrade path; a batch job can walk all rows the same way)
5. **All new encryptions** use the new key automatically
6. **Verify**: spot-check `GetSecret`, then retire the old key

### Backup Rule

**NEVER** delete an encryption key until ALL data encrypted with it has been either:
- Re-encrypted with the new key, OR
- Expired and deleted per retention policy

## Git History Incident

**Commit `e591635`** contained a hardcoded fallback value:
```
EGAOP_MASTER_ENCRYPTION_KEY=dev-key-do-not-use-in-production
```

This value was in docker-compose.yml and .env.example. It has since been removed
and replaced with `${VAR:?...}` syntax. However, it remains in git history.

**Action required**: If this key was ever used in production (even briefly), it
must be considered compromised. Generate a new key and rotate immediately.
