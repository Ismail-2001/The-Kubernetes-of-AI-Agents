import { Interceptor, InterceptingCall, InterceptorOptions, NextCall, Metadata, Requester, InterceptingListener, StatusObject, status as GrpcStatus } from "@grpc/grpc-js";
import type { ServerInterceptor, ServerInterceptingCallInterface, ServerMethodDefinition } from "@grpc/grpc-js";
import { ServerInterceptingCall } from "@grpc/grpc-js";
import { spanEnrichmentInterceptor } from "./span-enrichment.js";

const RETRYABLE_CODES = new Set([
  GrpcStatus.UNAVAILABLE,
  GrpcStatus.DEADLINE_EXCEEDED,
  GrpcStatus.RESOURCE_EXHAUSTED,
  GrpcStatus.INTERNAL,
]);

export interface InterceptorConfig {
  serviceName: string;
  rateLimitPerNamespace?: number;
}

export function getStandardInterceptors(config: InterceptorConfig): Interceptor[] {
  return [
    retryInterceptor(),
    spanEnrichmentInterceptor({ serviceName: config.serviceName }),
    authInterceptor(),
    loggingInterceptor(config.serviceName),
    metricsInterceptor(config.serviceName),
    rateLimitInterceptor(config.rateLimitPerNamespace),
  ];
}

const MAX_RETRIES = 3;
const BASE_DELAY_MS = 200;

function retryInterceptor(): Interceptor {
  return (options: InterceptorOptions, nextCall: NextCall): InterceptingCall => {
    let retriesLeft = MAX_RETRIES;
    const method = options.method_definition?.path ?? "unknown";

    const requester: Requester = {
      start(_metadata: Metadata, listener: InterceptingListener): Partial<InterceptingListener> {
        return {
          onReceiveStatus: (status: StatusObject): void => {
            if (RETRYABLE_CODES.has(status.code) && retriesLeft > 0) {
              retriesLeft--;
              const attempt = MAX_RETRIES - retriesLeft;
              const delay = BASE_DELAY_MS * Math.pow(2, attempt - 1);
              const jitter = Math.floor(Math.random() * delay * 0.3);

              process.stdout.write(JSON.stringify({
                level: "info",
                msg: "gRPC_retry",
                method,
                attempt,
                max_retries: MAX_RETRIES,
                delay_ms: delay + jitter,
                status_code: status.code,
              }) + "\n");

              setTimeout(() => {
                const retryCall = nextCall(options);
                retryCall.start(new Metadata(), {
                  onReceiveStatus: (s: StatusObject) => listener.onReceiveStatus(s),
                });
              }, delay + jitter);
              return;
            }
            listener.onReceiveStatus(status);
          },
        };
      },
    };
    return new InterceptingCall(nextCall(options), requester);
  };
}

/**
 * Client-side interceptor: attaches INTERNAL_SERVICE_TOKEN to outgoing gRPC calls.
 * Services use this to authenticate to each other.
 */
function authInterceptor(): Interceptor {
  return (options: InterceptorOptions, nextCall: NextCall): InterceptingCall => {
    const token = process.env.INTERNAL_SERVICE_TOKEN ?? "";
    const requester: Requester = {
      start(metadata: Metadata, listener: InterceptingListener): void {
        if (token) {
          metadata.set("x-service-token", token);
        }
      },
    };
    return new InterceptingCall(nextCall(options), requester);
  };
}

/**
 * Server-side interceptor: validates INTERNAL_SERVICE_TOKEN on incoming gRPC calls.
 * Rejects calls that don't carry a valid token.
 *
 * Skip validation if INTERNAL_SERVICE_TOKEN is not set (dev mode).
 */
export function createServiceTokenServerInterceptor(): ServerInterceptor {
  const expectedToken = process.env.INTERNAL_SERVICE_TOKEN ?? "";

  return (
    methodDescriptor: ServerMethodDefinition<any, any>,
    call: any
  ): ServerInterceptingCall => {
    const methodPath = methodDescriptor.path ?? "unknown";

    const wrappedCall: any = {
      start: (callback: any) => {
        const wrappedListener = {
          onReceiveMetadata: (metadata: Metadata, passthrough: (m: Metadata) => void) => {
            // Skip validation if no token is configured (dev mode)
            if (!expectedToken) {
              passthrough(metadata);
              return;
            }

            const providedToken = (metadata.get("x-service-token")[0] as string) ?? "";

            if (providedToken !== expectedToken) {
              process.stdout.write(JSON.stringify({
                level: "warn",
                msg: "SERVICE_TOKEN_REJECTED",
                method: methodPath,
                timestamp: new Date().toISOString(),
              }) + "\n");

              call.sendStatus({
                code: 16, // UNAUTHENTICATED
                details: "Invalid or missing service token",
                metadata: new (metadata.constructor as new () => Metadata)(),
              });
              return;
            }

            passthrough(metadata);
          },
          onReceiveMessage: (message: any, passthrough: (m: any) => void) => {
            passthrough(message);
          },
          onReceiveHalfClose: (passthrough: () => void) => {
            passthrough();
          },
          onCancel: () => {},
        };
        callback(wrappedListener);
      },
      sendMetadata: (metadata: any, callback: any) => callback(metadata),
      sendMessage: (message: any, callback: any) => callback(message),
      sendStatus: (status: any, callback: any) => callback(status),
      startRead: () => call.startRead(),
      getPeer: () => call.getPeer(),
      getDeadline: () => call.getDeadline(),
      getHost: () => call.getHost(),
      getAuthContext: () => call.getAuthContext(),
      getConnectionInfo: () => call.getConnectionInfo(),
      getMetricsRecorder: () => call.getMetricsRecorder(),
    };

    return new ServerInterceptingCall(call as any, wrappedCall as any);
  };
}

function loggingInterceptor(serviceName: string): Interceptor {
  return (options: InterceptorOptions, nextCall: NextCall): InterceptingCall => {
    const method = options.method_definition?.path ?? "unknown";
    const requester: Requester = {
      start(_metadata: Metadata, listener: InterceptingListener): Partial<InterceptingListener> {
        const startMs = Date.now();
        return {
          onReceiveStatus: (status: StatusObject): void => {
            const durationMs = Date.now() - startMs;
            const logEntry: Record<string, unknown> = {
              service: serviceName,
              method,
              duration_ms: durationMs,
              code: status.code,
            };
            if (status.code !== 0) {
              logEntry.error = status.details;
              process.stdout.write(JSON.stringify({ level: "warn", msg: "gRPC call failed", ...logEntry }) + "\n");
            } else {
              process.stdout.write(JSON.stringify({ level: "info", msg: "gRPC call completed", ...logEntry }) + "\n");
            }
            listener.onReceiveStatus(status);
          },
        };
      },
    };
    return new InterceptingCall(nextCall(options), requester);
  };
}

function metricsInterceptor(serviceName: string): Interceptor {
  const counters = new Map<string, number>();

  return (options: InterceptorOptions, nextCall: NextCall): InterceptingCall => {
    const method = options.method_definition?.path ?? "unknown";
    const requester: Requester = {
      start(_metadata: Metadata, listener: InterceptingListener): Partial<InterceptingListener> {
        const startMs = Date.now();
        return {
          onReceiveStatus: (status: StatusObject): void => {
            const durationMs = Date.now() - startMs;
            const key = `${serviceName}.${method}`;
            counters.set(key, (counters.get(key) ?? 0) + 1);
            process.stdout.write(JSON.stringify({
              metric: "call_duration_ms",
              service: serviceName,
              method,
              duration_ms: durationMs,
              status_code: status.code,
            }) + "\n");
            listener.onReceiveStatus(status);
          },
        };
      },
    };
    return new InterceptingCall(nextCall(options), requester);
  };
}

function rateLimitInterceptor(maxPerNamespace?: number): Interceptor {
  const rpm = maxPerNamespace ?? parseInt(process.env.RATE_LIMIT_RPM ?? "60", 10);
  const windowMs = 60_000;
  const buckets = new Map<string, number[]>();

  return (_options: InterceptorOptions, nextCall: NextCall): InterceptingCall => {
    const requester: Requester = {
      start(metadata: Metadata, listener: InterceptingListener): Partial<InterceptingListener> | void {
        const namespace = (metadata.get("x-namespace")[0] as string) ?? "default";
        const now = Date.now();
        const cutoff = now - windowMs;
        let timestamps = buckets.get(namespace);
        if (!timestamps) {
          timestamps = [];
          buckets.set(namespace, timestamps);
        }
        const active = timestamps.filter((t) => t > cutoff);
        buckets.set(namespace, active);
        if (active.length >= rpm) {
          listener.onReceiveStatus({
            code: 8 as GrpcStatus,
            details: "Rate limit exceeded",
            metadata: metadata,
          });
          return;
        }
        active.push(now);
      },
    };
    return new InterceptingCall(nextCall(_options), requester);
  };
}
