import pino from "pino";

const logger = pino({
  level: process.env.LOG_LEVEL || "info",
});

const KNOWN_BAD_VALUES = new Set([
  "default",
  "changeme",
  "secret",
  "password",
  "admin",
  "dev-key-do-not-use-in-production",
  "dev-key-do-not-use-in-production-32-chars!!",
]);

interface SecretSpec {
  name: string;
  minLength?: number;
  rejectValues?: string[];
}

const REQUIRED_SECRETS: SecretSpec[] = [
  { name: "EGAOP_MASTER_ENCRYPTION_KEY", minLength: 32 },
  { name: "JWT_SECRET", minLength: 32 },
  { name: "POSTGRES_PASSWORD", minLength: 8 },
  { name: "OPENAI_API_KEY", minLength: 10 },
  { name: "GRAFANA_PASSWORD", minLength: 8 },
];

function validateValue(spec: SecretSpec, value: string): string | null {
  if (!value || value.trim().length === 0) {
    return `${spec.name} is not set`;
  }

  const allRejected = [
    ...KNOWN_BAD_VALUES,
    ...(spec.rejectValues ?? []),
  ];

  if (allRejected.includes(value)) {
    return `${spec.name} is a known-bad or default value`;
  }

  if (spec.minLength && value.length < spec.minLength) {
    return `${spec.name} is too short (${value.length} < ${spec.minLength} chars)`;
  }

  return null;
}

/**
 * Validate all required secrets before service startup.
 * Call this BEFORE any server starts listening.
 *
 * Fails closed: missing or weak secret = process.exit(1).
 *
 * Never prints actual secret values — only length/success info.
 */
export function validateSecrets(extraSecrets?: SecretSpec[]): void {
  const specs = [...REQUIRED_SECRETS, ...(extraSecrets ?? [])];
  const errors: string[] = [];

  for (const spec of specs) {
    const value = process.env[spec.name] ?? "";
    const error = validateValue(spec, value);

    if (error) {
      errors.push(`  ✗ ${error}`);
    } else {
      logger.info(`✓ ${spec.name} validated (${value.length} chars)`);
    }
  }

  if (errors.length > 0) {
    logger.fatal(
      `Secret validation failed — refusing to start:\n${errors.join("\n")}`
    );
    process.exit(1);
  }

  logger.info("All secrets validated successfully");
}
