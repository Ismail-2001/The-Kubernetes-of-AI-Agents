import { context, trace, SpanStatusCode, type Span, type SpanKind } from "@opentelemetry/api";
import {
  type Interceptor,
  type InterceptingCall,
  type InterceptorOptions,
  type NextCall,
  type Metadata,
  type Requester,
  type InterceptingListener,
  type StatusObject,
  InterceptingCall as InterceptingCallImpl,
} from "@grpc/grpc-js";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import { getTracer } from "../telemetry/index.js";

const propagator = new W3CTraceContextPropagator();

export interface SpanEnrichmentConfig {
  serviceName: string;
}

export function spanEnrichmentInterceptor(config: SpanEnrichmentConfig): Interceptor {
  const tracer = getTracer();

  return (options: InterceptorOptions, nextCall: NextCall): InterceptingCall => {
    const methodPath = options.method_definition?.path ?? "unknown";
    const parts = methodPath.split("/").filter(Boolean);
    const grpcService = parts.length >= 2 ? parts[0]! : "unknown";
    const grpcMethod = parts.length >= 2 ? parts[1]! : parts[parts.length - 1] ?? "unknown";

    const requester: Requester = {
      start(metadata: Metadata, listener: InterceptingListener): Partial<InterceptingListener> {
        const carrier: Record<string, string> = {};
        const metadataMap = metadata.getMap();
        for (const [key, value] of Object.entries(metadataMap)) {
          carrier[key] = typeof value === "string" ? value : new TextDecoder().decode(value);
        }

        const extractedContext = propagator.extract(context.active(), carrier, {
          get(carrier: Record<string, string>, key: string): string | undefined {
            return carrier[key];
          },
          keys(carrier: Record<string, string>): string[] {
            return Object.keys(carrier);
          },
        });

        const span = tracer.startSpan(
          `grpc.${grpcService}.${grpcMethod}`,
          {
            kind: 1 as SpanKind,
            attributes: {
              "rpc.system": "grpc",
              "rpc.service": grpcService,
              "rpc.method": grpcMethod,
              "rpc.grpc.status_code": 0,
            },
          },
          extractedContext
        );

        const namespaceValues = metadata.get("x-namespace");
        const agentIdValues = metadata.get("x-agent-id");
        const namespace = (namespaceValues[0] as string) ?? "default";
        const agentId = (agentIdValues[0] as string) ?? "";
        span.setAttribute("namespace", namespace);
        if (agentId) {
          span.setAttribute("agent.id", agentId);
        }

        const spanContext = span.spanContext();
        if (spanContext.traceId) {
          metadata.set("traceparent", `00-${spanContext.traceId}-${spanContext.spanId}-01`);
        }

        const carrierForInject: Record<string, string> = {};
        propagator.inject(context.active(), carrierForInject, {
          set(carrier: Record<string, string>, key: string, value: string): void {
            carrier[key] = value;
          },
        });
        for (const [key, value] of Object.entries(carrierForInject)) {
          if (key !== "traceparent") {
            metadata.set(key, value);
          }
        }

        return {
          onReceiveStatus: (status: StatusObject): void => {
            const grpcStatusCode = typeof status.code === "number" ? status.code : 0;

            if (grpcStatusCode !== 0) {
              span.setStatus({
                code: SpanStatusCode.ERROR,
                message: status.details || `gRPC error: ${grpcStatusCode}`,
              });
              span.setAttribute("rpc.grpc.status_code", grpcStatusCode);

              if (status.details) {
                span.recordException(new Error(status.details));
              }
            } else {
              span.setStatus({ code: SpanStatusCode.OK });
              span.setAttribute("rpc.grpc.status_code", 0);
            }

            span.end();
            listener.onReceiveStatus(status);
          },
        };
      },
    };

    return new InterceptingCallImpl(nextCall(options), requester);
  };
}
