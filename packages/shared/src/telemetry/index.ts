import { trace, diag, DiagConsoleLogger, DiagLogLevel, type Span, type Tracer } from "@opentelemetry/api";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { PrometheusExporter } from "@opentelemetry/exporter-prometheus";
import { ConsoleSpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { CompressionAlgorithm } from "@opentelemetry/otlp-exporter-base";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { HttpInstrumentation } from "@opentelemetry/instrumentation-http";
import { GrpcInstrumentation } from "@opentelemetry/instrumentation-grpc";
import { PgInstrumentation } from "@opentelemetry/instrumentation-pg";
import os from "os";

let initialized = false;
let sdk: NodeSDK | null = null;
let tracerInstance: Tracer | null = null;
let traceExporter: OTLPTraceExporter | null = null;
let prometheusExporter: PrometheusExporter | null = null;

diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.ERROR);

export interface TelemetryConfig {
  serviceName: string;
  serviceVersion?: string;
  endpoint?: string;
  metricsPort?: number;
}

export function initTracing(config: TelemetryConfig | string): void {
  if (initialized) return;
  initialized = true;

  const serviceName = typeof config === "string" ? config : config.serviceName;
  const serviceVersion =
    typeof config === "string"
      ? process.env.SERVICE_VERSION ?? "1.0.0"
      : config.serviceName ?? process.env.SERVICE_VERSION ?? "1.0.0";
  const endpoint =
    typeof config === "string"
      ? process.env.OTEL_EXPORTER_OTLP_ENDPOINT
      : config.endpoint ?? process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  const metricsPort =
    typeof config === "string" ? 9464 : config.metricsPort ?? 9464;

  // Skip OTel initialization entirely if no collector endpoint is configured
  if (!endpoint) {
    // Fallback mode: still expose Prometheus metrics locally, traces go to console
    const resource = resourceFromAttributes({
      "service.name": serviceName,
      "service.version": serviceVersion,
      "deployment.environment": process.env.DEPLOYMENT_ENVIRONMENT ?? process.env.NODE_ENV ?? "development",
      "k8s.namespace.name": process.env.NAMESPACE ?? "default",
      "host.name": process.env.HOST_NAME ?? os.hostname(),
    });

    try {
      prometheusExporter = new PrometheusExporter({
        port: metricsPort,
        appendTimestamp: true,
      });
    } catch {
      prometheusExporter = null;
    }

    sdk = new NodeSDK({
      resource,
      spanProcessors: [new SimpleSpanProcessor(new ConsoleSpanExporter())],
      metricReader: prometheusExporter ?? undefined,
      instrumentations: [
        new HttpInstrumentation(),
        new GrpcInstrumentation(),
        new PgInstrumentation(),
      ],
    });

    try {
      sdk.start();
    } catch {
      // best-effort
    }

    tracerInstance = trace.getTracer(serviceName, serviceVersion);
    diag.info(`[telemetry] ${serviceName}: OTel fallback mode — traces → console, metrics → Prometheus :${metricsPort}/metrics`);
    return;
  }

  // Suppress OTel unhandled promise rejections (DNS errors when collector is unreachable)
  const originalListeners = process.listenerCount("unhandledRejection");
  process.removeAllListeners("unhandledRejection");
  process.on("unhandledRejection", (reason) => {
    const msg = reason instanceof Error ? reason.message : String(reason);
    if (msg.includes("ENOTFOUND") || msg.includes("getaddrinfo") || msg.includes("ECONNREFUSED")) {
      return; // suppress OTel DNS errors
    }
    // Re-emit for non-OTel errors — but only if we were the ones who removed listeners
    if (originalListeners === 0) {
      console.error("[telemetry] Unhandled rejection:", reason);
    }
  });

  try {
    traceExporter = new OTLPTraceExporter({
      url: `${endpoint}/v1/traces`,
      compression: CompressionAlgorithm.GZIP,
    });
  } catch {
    traceExporter = null;
  }

  try {
    prometheusExporter = new PrometheusExporter({
      port: metricsPort,
      appendTimestamp: true,
    });
  } catch {
    prometheusExporter = null;
  }

  const resource = resourceFromAttributes({
    "service.name": serviceName,
    "service.version": serviceVersion,
    "deployment.environment": process.env.DEPLOYMENT_ENVIRONMENT ?? process.env.NODE_ENV ?? "development",
    "k8s.namespace.name": process.env.NAMESPACE ?? "default",
    "host.name": process.env.HOST_NAME ?? os.hostname(),
  });

  sdk = new NodeSDK({
    resource,
    traceExporter: traceExporter ?? undefined,
    metricReader: prometheusExporter ?? undefined,
    instrumentations: [
      new HttpInstrumentation(),
      new GrpcInstrumentation(),
      new PgInstrumentation(),
    ],
  });

  try {
    sdk.start();
  } catch {
    // OTel startup is best-effort; don't crash the process if collector is unreachable
  }

  tracerInstance = trace.getTracer(serviceName, serviceVersion);
  diag.info(`[telemetry] ${serviceName}: traces → OTLP ${endpoint}, metrics → Prometheus :${metricsPort}/metrics`);
}

export function getTracer(): Tracer {
  if (!tracerInstance) {
    tracerInstance = trace.getTracer("e-gaop-default");
  }
  return tracerInstance;
}

export function getPrometheusExporter(): PrometheusExporter | null {
  return prometheusExporter;
}

export async function withSpan<T>(name: string, fn: (span: Span) => Promise<T>): Promise<T> {
  const tracer = getTracer();
  return tracer.startActiveSpan(name, async (span) => {
    try {
      const result = await fn(span);
      span.setStatus({ code: 0 });
      return result;
    } catch (err) {
      span.setStatus({ code: 2, message: err instanceof Error ? err.message : String(err) });
      span.recordException(err instanceof Error ? err : new Error(String(err)));
      throw err;
    } finally {
      span.end();
    }
  });
}

export async function shutdownTracing(): Promise<void> {
  if (sdk) {
    await sdk.shutdown();
    sdk = null;
    tracerInstance = null;
    prometheusExporter = null;
    initialized = false;
  }
}
