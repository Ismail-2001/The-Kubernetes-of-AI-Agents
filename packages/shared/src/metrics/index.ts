import { MeterProvider } from "@opentelemetry/sdk-metrics";
import { PrometheusExporter } from "@opentelemetry/exporter-prometheus";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { diag } from "@opentelemetry/api";
import type { Meter, Histogram, Counter, UpDownCounter } from "@opentelemetry/api";
import { getPrometheusExporter } from "../telemetry/index";
import os from "os";

let meterProvider: MeterProvider | null = null;
const meters = new Map<string, Meter>();

interface StandardMeters {
  grpcRequestDurationMs: Histogram;
  agentExecutionTotal: Counter;
  llmTokensUsed: Counter;
  activeAgents: UpDownCounter;
  toolExecutionDurationMs: Histogram;
}

const meterCache = new Map<string, StandardMeters>();

export interface MetricsConfig {
  serviceName: string;
  port?: number;
}

export function initMetrics(config: MetricsConfig | string): PrometheusExporter {
  const serviceName = typeof config === "string" ? config : config.serviceName;
  const port = typeof config === "string" ? 9464 : (config.port ?? 9464);

  if (meterProvider) {
    const existing = getPrometheusExporter();
    if (existing) return existing;
  }

  const existingExporter = getPrometheusExporter();
  if (existingExporter) {
    diag.info(`[metrics] ${serviceName}: reusing PrometheusExporter from initTracing() on port ${port}`);
    const resource = resourceFromAttributes({
      "service.name": serviceName,
      "service.version": process.env.SERVICE_VERSION ?? "1.0.0",
      "deployment.environment": process.env.DEPLOYMENT_ENVIRONMENT ?? process.env.NODE_ENV ?? "development",
      "host.name": process.env.HOST_NAME ?? os.hostname(),
    });

    meterProvider = new MeterProvider({
      resource,
      readers: [existingExporter],
    });
    return existingExporter;
  }

  const exporter = new PrometheusExporter({
    port,
    appendTimestamp: true,
  });

  const resource = resourceFromAttributes({
    "service.name": serviceName,
    "service.version": process.env.SERVICE_VERSION ?? "1.0.0",
    "deployment.environment": process.env.DEPLOYMENT_ENVIRONMENT ?? process.env.NODE_ENV ?? "development",
    "host.name": process.env.HOST_NAME ?? os.hostname(),
  });

  meterProvider = new MeterProvider({
    resource,
    readers: [exporter],
  });

  diag.info(`Prometheus metrics exporter listening on port ${port}`);
  return exporter;
}

export function getMeter(name: string): Meter {
  if (meters.has(name)) {
    return meters.get(name)!;
  }

  if (!meterProvider) {
    diag.warn("MeterProvider not initialized. Call initMetrics() first. Returning noop meter.");
    const { NoopMeter } = require("@opentelemetry/api");
    return new NoopMeter();
  }

  const meter = meterProvider.getMeter(name);
  meters.set(name, meter);
  return meter;
}

export function getStandardMeters(serviceName: string): StandardMeters {
  if (meterCache.has(serviceName)) {
    return meterCache.get(serviceName)!;
  }

  const meter = getMeter(serviceName);

  const grpcRequestDurationMs = meter.createHistogram("grpc_request_duration_ms", {
    description: "Duration of gRPC requests in milliseconds",
    unit: "ms",
  });

  const agentExecutionTotal = meter.createCounter("agent_execution_total", {
    description: "Total number of agent executions",
  });

  const llmTokensUsed = meter.createCounter("llm_tokens_used", {
    description: "Total LLM tokens consumed",
  });

  const activeAgents = meter.createUpDownCounter("active_agents", {
    description: "Number of currently active agents",
  });

  const toolExecutionDurationMs = meter.createHistogram("tool_execution_duration_ms", {
    description: "Duration of tool executions in milliseconds",
    unit: "ms",
  });

  const standardMeters: StandardMeters = {
    grpcRequestDurationMs,
    agentExecutionTotal,
    llmTokensUsed,
    activeAgents,
    toolExecutionDurationMs,
  };

  meterCache.set(serviceName, standardMeters);
  return standardMeters;
}

let _budgetMeter: Meter | null = null;
let _budgetGauge: ReturnType<Meter["createGauge"]> | null = null;
let _budgetCounter: ReturnType<Meter["createCounter"]> | null = null;
function getBudgetMeter(): Meter {
  if (!_budgetMeter) _budgetMeter = getMeter("egaop-budget");
  return _budgetMeter;
}

export const namespaceBudgetUsage = {
  set(value: number, attrs?: Record<string, string | number>) {
    if (!_budgetGauge) {
      _budgetGauge = getBudgetMeter().createGauge("egaop_namespace_budget_usage_percent", {
        description: "Namespace budget utilization percentage",
        unit: "%",
      });
    }
    _budgetGauge.record(value, attrs);
  },
};

export const namespaceBudgetExhausted = {
  add(value: number, attrs?: Record<string, string | number>) {
    if (!_budgetCounter) {
      _budgetCounter = getBudgetMeter().createCounter("egaop_namespace_budget_exhausted_total", {
        description: "Number of requests rejected due to budget exhaustion",
        unit: "{requests}",
      });
    }
    _budgetCounter.add(value, attrs);
  },
};

export async function shutdownMetrics(): Promise<void> {
  if (meterProvider) {
    await meterProvider.shutdown();
    meterProvider = null;
    meters.clear();
    meterCache.clear();
  }
}
