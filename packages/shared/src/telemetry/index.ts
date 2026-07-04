import { context, trace, diag, DiagConsoleLogger, DiagLogLevel, type Span, type Tracer } from "@opentelemetry/api";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { PrometheusExporter } from "@opentelemetry/exporter-prometheus";
import { CompressionAlgorithm } from "@opentelemetry/otlp-exporter-base";
import { type Resource, resourceFromAttributes } from "@opentelemetry/resources";
import { HttpInstrumentation } from "@opentelemetry/instrumentation-http";
import { GrpcInstrumentation } from "@opentelemetry/instrumentation-grpc";
import { PgInstrumentation } from "@opentelemetry/instrumentation-pg";
import os from "os";

let initialized = false;
let sdk: NodeSDK | null = null;
let tracerInstance: Tracer | null = null;
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
      : config.serviceVersion ?? process.env.SERVICE_VERSION ?? "1.0.0";
  const endpoint =
    typeof config === "string"
      ? process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? "http://localhost:4318"
      : config.endpoint ?? process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? "http://localhost:4318";
  const metricsPort =
    typeof config === "string" ? 9464 : config.metricsPort ?? 9464;

  const traceExporter = new OTLPTraceExporter({
    url: `${endpoint}/v1/traces`,
    compression: CompressionAlgorithm.GZIP,
  });

  prometheusExporter = new PrometheusExporter({
    port: metricsPort,
    appendTimestamp: true,
  });

  const resource = resourceFromAttributes({
    "service.name": serviceName,
    "service.version": serviceVersion,
    "deployment.environment": process.env.DEPLOYMENT_ENVIRONMENT ?? process.env.NODE_ENV ?? "development",
    "k8s.namespace.name": process.env.NAMESPACE ?? "default",
    "host.name": process.env.HOST_NAME ?? os.hostname(),
  });

  sdk = new NodeSDK({
    resource,
    traceExporter,
    metricReader: prometheusExporter,
    instrumentations: [
      new HttpInstrumentation(),
      new GrpcInstrumentation(),
      new PgInstrumentation(),
    ],
  });

  sdk.start();

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
