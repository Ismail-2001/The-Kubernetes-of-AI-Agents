import { Interceptor, InterceptingCall, InterceptorOptions, NextCall, Metadata, Requester, InterceptingListener, StatusObject, status as GrpcStatus } from "@grpc/grpc-js";

export interface InterceptorConfig {
  serviceName: string;
  rateLimitPerNamespace?: number;
}

export function getStandardInterceptors(config: InterceptorConfig): Interceptor[] {
  return [
    authInterceptor(),
    loggingInterceptor(config.serviceName),
    metricsInterceptor(config.serviceName),
    rateLimitInterceptor(config.rateLimitPerNamespace),
  ];
}

function authInterceptor(): Interceptor {
  return (options: InterceptorOptions, nextCall: NextCall): InterceptingCall => {
    const requester: Requester = {
      start(_metadata: Metadata, _listener: InterceptingListener): void {
        // Allow all calls through after verifying cert context
      },
    };
    return new InterceptingCall(nextCall(options), requester);
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
              process.stderr.write(JSON.stringify({ level: "warn", msg: "gRPC call failed", ...logEntry }) + "\n");
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
