/* eslint-disable @typescript-eslint/no-explicit-any */

// Ambient declarations for @temporalio/client — package ships without .d.ts
declare module "@temporalio/client" {
  export interface ConnectionOptions {
    address: string;
    tls?: {
      clientCertPair: {
        crt: Buffer;
        key: Buffer;
      };
    };
  }

  export class Connection {
    static connect(options: ConnectionOptions): Promise<Connection>;
    close(): void;
  }

  export interface WorkflowStartOptions {
    args?: unknown[];
    taskQueue: string;
    workflowId: string;
    workflowExecutionTimeout?: string;
  }

  export class Client {
    constructor(options: { connection: Connection; namespace: string });
    workflow: {
      start(
        workflowType: (...args: unknown[]) => any,
        options: WorkflowStartOptions
      ): Promise<WorkflowHandle>;
      getHandle(workflowId: string): WorkflowHandle;
      list(options: {
        query?: string;
        pageSize?: number;
      }): AsyncIterable<WorkflowExecutionInfo>;
    };
  }

  export interface WorkflowHandle {
    readonly workflowId: string;
    readonly firstExecutionRunId: string;
    describe(): Promise<WorkflowExecutionDescription>;
    fetchHistory(): Promise<{ events?: any[] }>;
    result<T = unknown>(): Promise<T>;
    signal(signalDef: any, ...args: unknown[]): Promise<void>;
    query(queryDef: any, ...args: unknown[]): Promise<any>;
    cancel(): Promise<void>;
    terminate(reason?: string): Promise<void>;
  }

  export interface WorkflowExecutionInfo {
    readonly workflowId: string;
    readonly type: string;
    readonly status: { name: string };
    readonly startTime: Date;
    readonly closeTime?: Date;
  }

  export interface WorkflowExecutionDescription {
    readonly workflowId: string;
    readonly status: { name: string };
    readonly raw?: Record<string, unknown>;
  }
}

// Ambient declarations for @opentelemetry packages — some ship without .d.ts
declare module "@opentelemetry/exporter-trace-otlp-http" {
  import { SpanExporter } from "@opentelemetry/sdk-trace-base";
  export class OTLPTraceExporter implements SpanExporter {
    constructor(config?: Record<string, unknown>);
    export(
      spans: unknown[],
      resultCallback: (result: { code: number }) => void
    ): void;
    shutdown(): Promise<void>;
  }
}

declare module "@opentelemetry/exporter-prometheus" {
  import { IMetricReader } from "@opentelemetry/sdk-metrics";
  export class PrometheusExporter implements IMetricReader {
    constructor(config?: Record<string, unknown>);
    selectAggregation(): any;
    selectAggregationTemporality(): any;
    selectCardinalityLimit(): any;
    setMetricProducer(): void;
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
