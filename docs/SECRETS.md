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

## Key Rotation — `EGAOP_MASTER_ENCRYPTION_KEY`

### The Problem
Existing encrypted data is tied to the old key. Deleting the old key breaks decryption.

### The Solution: Key Versioning

Each `EncryptedPayload` includes a `keyId` field. The rotation procedure:

1. **Keep the old key** accessible (do NOT delete from vault/secrets manager)
2. **Generate a new key**: `openssl rand -hex 32`
3. **Update the env var** with the new key
4. **All new encryptions** use the new key
5. **Decryption checks `keyId`** — if it matches the old key, uses old key; if new, uses new key

### Implementation

```typescript
// In secret-store, derive key from keyId:
function deriveKeyFromId(keyId: string): Buffer {
  return crypto.createHash("sha256").update(keyId).digest();
}

// Encrypt uses the current master key
const payload = await encrypt(plaintext, currentKeyId);

// Decrypt uses the keyId stored in the payload
const plaintext = await decrypt(payload, payload.keyId);
```

### Step-by-Step Rotation

1. **Before rotation**: Verify old key still decrypts all data
2. **Generate new key**: `openssl rand -hex 32`
3. **Set new key**: Update `EGAOP_MASTER_ENCRYPTION_KEY` in secrets manager
4. **Deploy**: Rolling restart of secret-store pods
5. **Verify**: New encryptions use new key, old data still decrypts with old key
6. **Clean up** (optional): After all old data is re-encrypted or expired, you can remove the old key from the keyring

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
