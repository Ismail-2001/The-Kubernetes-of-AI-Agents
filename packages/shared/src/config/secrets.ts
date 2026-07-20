import fs from "fs";
import path from "path";

const SECRETS_DIR = "/run/secrets";

/**
 * Read a secret value from Docker secrets (/run/secrets/<name>)
 * with fallback to environment variable.
 *
 * Priority:
 *   1. /run/secrets/<snake_case_name>  (Docker secrets)
 *   2. process.env[UPPER_CASE_NAME]   (environment variable)
 *   3. undefined                       (not set)
 *
 * Never logs the actual value — only whether it was found.
 */
export function getSecret(envVarName: string): string | undefined {
  // Try Docker secrets file first
  const secretFileName = envVarName.toLowerCase();
  const secretPath = path.join(SECRETS_DIR, secretFileName);

  try {
    const value = fs.readFileSync(secretPath, "utf-8").trim();
    if (value.length > 0) {
      return value;
    }
  } catch {
    // File doesn't exist or not readable — fall through to env var
  }

  // Fall back to environment variable
  const envValue = process.env[envVarName];
  if (envValue && envValue.trim().length > 0) {
    return envValue.trim();
  }

  return undefined;
}

/**
 * Load all secrets into process.env at startup.
 * Call this BEFORE validateSecrets().
 *
 * Reads from Docker secrets files and populates process.env
 * for any secret that is set via file but not via env var.
 */
export function loadSecretsIntoEnv(): void {
  const secretNames = [
    "JWT_SECRET",
    "EGAOP_MASTER_ENCRYPTION_KEY",
    "POSTGRES_PASSWORD",
    "OPENAI_API_KEY",
    "GRAFANA_PASSWORD",
    "INTERNAL_SERVICE_TOKEN",
  ];

  for (const name of secretNames) {
    if (!process.env[name] || process.env[name].trim().length === 0) {
      const value = getSecret(name);
      if (value) {
        process.env[name] = value;
      }
    }
  }
}
