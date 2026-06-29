import { z, type ZodSchema } from "zod";

const configCache = new Map<string, unknown>();

export function loadConfig<T>(schema: ZodSchema<T>, serviceName?: string): T {
  const cacheKey = serviceName ?? "default";
  if (configCache.has(cacheKey)) {
    return configCache.get(cacheKey) as T;
  }

  const result = schema.safeParse(process.env);
  if (!result.success) {
    const formatted = result.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(
      `Configuration validation failed${serviceName ? ` for ${serviceName}` : ""}:\n${formatted}`
    );
  }

  configCache.set(cacheKey, result.data);
  return result.data;
}

export const BaseConfigSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  LOG_LEVEL: z.string().default("info"),
  TLS_ENABLED: z
    .string()
    .default("false")
    .transform((v) => v === "true"),
  TLS_CERT_DIR: z.string().default("/etc/egaop/certs"),
});

export type BaseConfig = z.infer<typeof BaseConfigSchema>;
