export {
  getStandardInterceptors,
  createServiceTokenServerInterceptor,
  type InterceptorConfig,
} from "./grpc/interceptors.js";
export {
  encrypt,
  decrypt,
  generateNonce,
  hashForCache,
  hashPassword,
  comparePassword,
  signJWT,
  verifyJWT,
  type EncryptedPayload,
  type JWTClaims,
} from "./crypto/index.js";
export {
  AgentError,
  PolicyDeniedError,
  PersistenceError,
  TimeoutError,
  NamespaceNotFoundError,
  NamespaceSuspendedError,
  CrossNamespaceError,
  QuotaExceededError,
  grpcStatusFromError,
  toStructuredLog,
} from "./errors/index.js";
export {
  initTracing,
  getTracer,
  withSpan,
  shutdownTracing,
} from "./telemetry/index.js";
export {
  initMetrics,
  getMeter,
  getStandardMeters,
  shutdownMetrics,
} from "./metrics/index.js";
export { spanEnrichmentInterceptor } from "./grpc/span-enrichment.js";
export {
  createNamespaceEnforcementInterceptor,
  createNamespaceServerInterceptor,
  clearNamespaceCache,
  updateNamespaceCache,
  type NamespaceEnforcementConfig,
} from "./grpc/namespace-enforcement.js";
export {
  QuotaEnforcer,
  type QuotaEnforcerConfig,
} from "./quotas/enforcer.js";
export {
  type Namespace,
  type NamespaceQuotas,
  type NamespaceTierValue,
  type AuditLogEntry,
  NamespaceTier,
  CreateNamespaceSchema,
  UpdateNamespaceSchema,
  NamespaceQuotasSchema,
  DEFAULT_QUOTAS,
  validateSlug,
  isNamespaceSuspended,
  isNamespaceDeleted,
} from "./namespaces/model.js";
export {
  loadConfig,
  BaseConfigSchema,
  type BaseConfig,
} from "./config/index.js";
export { validateSecrets } from "./config/validate-secrets.js";
export { getSecret, loadSecretsIntoEnv } from "./config/secrets.js";
export { RateLimiter } from "./rate-limiter.js";
export { getServerCredentials, getClientCredentials } from "./tls.js";
export { getPool, closePool } from "./db.js";
