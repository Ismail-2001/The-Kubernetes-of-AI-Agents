declare module "@opentelemetry/exporter-trace-otlp-http" {
  import { SpanExporter } from "@opentelemetry/sdk-trace-base";
  export class OTLPTraceExporter implements SpanExporter {
    constructor(config?: Record<string, unknown>);
    export(spans: unknown[], resultCallback: (result: { code: number }) => void): void;
    shutdown(): Promise<void>;
  }
}

declare module "@opentelemetry/exporter-prometheus" {
  export class PrometheusExporter {
    constructor(config?: Record<string, unknown>);
    selectAggregation(): any;
    selectAggregationTemporality(): any;
    selectCardinalityLimit(): any;
    setMetricProducer(metricProducer: unknown): void;
    getMetricsData(): Promise<any>;
    collect(): Promise<any>;
    shutdown(): Promise<void>;
    forceFlush(): Promise<void>;
  }
}

declare module "@opentelemetry/otlp-exporter-base" {
  export enum CompressionAlgorithm {
    GZIP = "gzip",
    NONE = "none",
  }
}

declare module "@opentelemetry/resources" {
  import { Attributes } from "@opentelemetry/api";
  export interface Resource {
    attributes: Attributes;
  }
  export function resourceFromAttributes(attributes: Attributes): Resource;
}

declare module "@opentelemetry/instrumentation-http" {
  export class HttpInstrumentation {
    constructor(config?: Record<string, unknown>);
  }
}

declare module "@opentelemetry/instrumentation-grpc" {
  export class GrpcInstrumentation {
    constructor(config?: Record<string, unknown>);
  }
}

declare module "@opentelemetry/instrumentation-pg" {
  export class PgInstrumentation {
    constructor(config?: Record<string, unknown>);
  }
}

declare module "@opentelemetry/sdk-node" {
  import { TracerProvider } from "@opentelemetry/sdk-trace-base";
  export class NodeSDK {
    constructor(config?: Record<string, unknown>);
    start(): void;
    shutdown(): Promise<void>;
    readonly tracerProvider: TracerProvider;
  }
}
