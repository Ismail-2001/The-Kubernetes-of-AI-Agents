import {
  type Interceptor,
  InterceptingCall,
  type InterceptorOptions,
  type NextCall,
  type Metadata,
  type Requester,
  type InterceptingListener,
  type StatusObject,
  status as GrpcStatus,
} from "@grpc/grpc-js";
import type { ServerInterceptor, ServerInterceptingCallInterface, ServerMethodDefinition } from "@grpc/grpc-js";
import { ServerInterceptingCall } from "@grpc/grpc-js";

interface InterceptingServerListener {
  onReceiveMetadata(metadata: Metadata): void;
  onReceiveMessage(message: any): void;
  onReceiveHalfClose(): void;
  onCancel(): void;
}

export interface NamespaceEnforcementConfig {
  jwtSecret?: string;
  platformAdminRole?: string;
}

interface NamespaceState {
  exists: boolean;
  suspended: boolean;
  deleted: boolean;
}

interface Claims {
  sub: string;
  role: string;
  allowedNamespaces: string[];
  namespace?: string;
}

const namespaceCache = new Map<string, { state: NamespaceState; expiresAt: number }>();
const CACHE_TTL_MS = 60_000;

function getCachedNamespace(slug: string): NamespaceState | null {
  const entry = namespaceCache.get(slug);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    namespaceCache.delete(slug);
    return null;
  }
  return entry.state;
}

function setCachedNamespace(slug: string, state: NamespaceState): void {
  namespaceCache.set(slug, { state, expiresAt: Date.now() + CACHE_TTL_MS });
}

export function clearNamespaceCache(): void {
  namespaceCache.clear();
}

function parseClaims(raw: string): Claims | null {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return {
      sub: typeof parsed.sub === "string" ? parsed.sub : "",
      role: typeof parsed.role === "string" ? parsed.role : "user",
      allowedNamespaces: Array.isArray(parsed.allowed_namespaces)
        ? (parsed.allowed_namespaces as string[])
        : [],
      namespace: typeof parsed.namespace === "string" ? parsed.namespace : undefined,
    };
  } catch {
    return null;
  }
}

function extractNamespaceFromRequest(message: Record<string, unknown>): string | null {
  if (typeof message.namespace === "string" && message.namespace) {
    return message.namespace;
  }
  if (message.metadata && typeof message.metadata === "object") {
    const meta = message.metadata as Record<string, unknown>;
    if (typeof meta.namespace === "string" && meta.namespace) {
      return meta.namespace;
    }
  }
  return null;
}

function logSecurityEvent(
  event: string,
  details: Record<string, unknown>
): void {
  const entry = {
    level: "warn",
    msg: "SECURITY_EVENT",
    event,
    timestamp: new Date().toISOString(),
    ...details,
  };
  process.stderr.write(JSON.stringify(entry) + "\n");
}

export function createNamespaceEnforcementInterceptor(
  config: NamespaceEnforcementConfig = {}
): Interceptor {
  const platformAdminRole = config.platformAdminRole ?? "platform-admin";

  return (options: InterceptorOptions, nextCall: NextCall): InterceptingCall => {
    const methodPath = options.method_definition?.path ?? "unknown";

    const requester: Requester = {
      start(metadata: Metadata, listener: InterceptingListener): Partial<InterceptingListener> | void {
        const requestNamespace = extractNamespaceFromRequest(options.method_definition as unknown as Record<string, unknown>);

        const claimsRaw = (metadata.get("x-agent-claims")[0] as string) ?? "";
        const claims = parseClaims(claimsRaw);

        const callerNamespace = claims?.namespace ?? claims?.allowedNamespaces?.[0] ?? "default";
        const callerRole = claims?.role ?? "user";

        if (!requestNamespace) {
          return {};
        }

        if (requestNamespace !== callerNamespace && callerRole !== platformAdminRole) {
          logSecurityEvent("CROSS_NAMESPACE_ACCESS_ATTEMPT", {
            method: methodPath,
            caller_namespace: callerNamespace,
            target_namespace: requestNamespace,
            caller_role: callerRole,
            caller_sub: claims?.sub,
          });

          listener.onReceiveStatus({
            code: GrpcStatus.PERMISSION_DENIED,
            details: `Cross-namespace access denied: caller in '${callerNamespace}' cannot access '${requestNamespace}'`,
            metadata: new (metadata.constructor as new () => Metadata)(),
          });
          return;
        }

        const cached = getCachedNamespace(requestNamespace);
        if (cached) {
          if (cached.deleted) {
            listener.onReceiveStatus({
              code: GrpcStatus.NOT_FOUND,
              details: `Namespace '${requestNamespace}' not found`,
              metadata: new (metadata.constructor as new () => Metadata)(),
            });
            return;
          }
          if (cached.suspended) {
            logSecurityEvent("SUSPENDED_NAMESPACE_ACCESS", {
              method: methodPath,
              namespace: requestNamespace,
              caller_sub: claims?.sub,
            });
            listener.onReceiveStatus({
              code: GrpcStatus.UNAVAILABLE,
              details: `Namespace '${requestNamespace}' is suspended`,
              metadata: new (metadata.constructor as new () => Metadata)(),
            });
            return;
          }
        }

        metadata.set("x-resolved-namespace", requestNamespace);
        metadata.set("x-caller-namespace", callerNamespace);
        metadata.set("x-caller-role", callerRole);

        return {};
      },
    };

    return new InterceptingCall(nextCall(options), requester);
  };
}

export function updateNamespaceCache(
  slug: string,
  state: NamespaceState
): void {
  setCachedNamespace(slug, state);
}

export function createNamespaceServerInterceptor(
  config: NamespaceEnforcementConfig = {}
): ServerInterceptor {
  const platformAdminRole = config.platformAdminRole ?? "platform-admin";

  return (
    methodDescriptor: ServerMethodDefinition<any, any>,
    call: ServerInterceptingCallInterface
  ): ServerInterceptingCall => {
    const methodPath = methodDescriptor.path ?? "unknown";

    const wrappedCall: ServerInterceptingCallInterface = {
      start: (listener: InterceptingServerListener) => {
        const wrappedListener: InterceptingServerListener = {
          onReceiveMetadata: (metadata: Metadata) => {
            const claimsRaw = (metadata.get("x-agent-claims")[0] as string) ?? "";
            const claims = parseClaims(claimsRaw);

            const callerNamespace = claims?.namespace ?? claims?.allowedNamespaces?.[0] ?? "default";
            const callerRole = claims?.role ?? "user";

            const requestNamespace =
              (metadata.get("x-resolved-namespace")[0] as string) ?? callerNamespace;

            if (requestNamespace !== callerNamespace && callerRole !== platformAdminRole) {
              logSecurityEvent("CROSS_NAMESPACE_ACCESS_ATTEMPT", {
                method: methodPath,
                caller_namespace: callerNamespace,
                target_namespace: requestNamespace,
                caller_role: callerRole,
                caller_sub: claims?.sub,
              });

              call.sendStatus({
                code: GrpcStatus.PERMISSION_DENIED,
                details: `Cross-namespace access denied: caller in '${callerNamespace}' cannot access '${requestNamespace}'`,
                metadata: new (metadata.constructor as new () => Metadata)(),
              });
              return;
            }

            const cached = getCachedNamespace(requestNamespace);
            if (cached) {
              if (cached.deleted) {
                call.sendStatus({
                  code: GrpcStatus.NOT_FOUND,
                  details: `Namespace '${requestNamespace}' not found`,
                  metadata: new (metadata.constructor as new () => Metadata)(),
                });
                return;
              }
              if (cached.suspended) {
                logSecurityEvent("SUSPENDED_NAMESPACE_ACCESS", {
                  method: methodPath,
                  namespace: requestNamespace,
                  caller_sub: claims?.sub,
                });
                call.sendStatus({
                  code: GrpcStatus.UNAVAILABLE,
                  details: `Namespace '${requestNamespace}' is suspended`,
                  metadata: new (metadata.constructor as new () => Metadata)(),
                });
                return;
              }
            }

            metadata.set("x-resolved-namespace", requestNamespace);
            metadata.set("x-caller-namespace", callerNamespace);
            metadata.set("x-caller-role", callerRole);

            listener.onReceiveMetadata(metadata);
          },
          onReceiveMessage: (message: any) => {
            if (listener.onReceiveMessage) {
              listener.onReceiveMessage(message);
            }
          },
          onReceiveHalfClose: () => {
            if (listener.onReceiveHalfClose) {
              listener.onReceiveHalfClose();
            }
          },
          onCancel: () => {
            if (listener.onCancel) {
              listener.onCancel();
            }
          },
        };
        call.start(wrappedListener);
      },
      sendMetadata: (metadata: Metadata) => call.sendMetadata(metadata),
      sendMessage: (message: any, callback: () => void) => call.sendMessage(message, callback),
      sendStatus: (status) => call.sendStatus(status),
      startRead: () => call.startRead(),
      getPeer: () => call.getPeer(),
      getDeadline: () => call.getDeadline(),
      getHost: () => call.getHost(),
      getAuthContext: () => call.getAuthContext(),
      getConnectionInfo: () => call.getConnectionInfo(),
      getMetricsRecorder: () => call.getMetricsRecorder(),
    };

    return new ServerInterceptingCall(wrappedCall);
  };
}
