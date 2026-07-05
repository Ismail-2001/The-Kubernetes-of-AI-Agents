export interface ApiResponse<T> {
  data: T;
  meta: { traceId: string; timestamp: string };
}

export interface ApiErrorData {
  message: string;
  code: string;
  meta?: { traceId: string; timestamp: string };
}

export interface PaginatedData<T> {
  items: T[];
  total: number;
  page: number;
  limit: number;
  hasNext: boolean;
}

export interface Agent {
  id: string;
  name: string;
  version: string;
  namespace: string;
  status: "pending" | "running" | "succeeded" | "failed" | "cancelled";
  health: "Healthy" | "Degraded" | "Unhealthy";
  createdAt: string;
  updatedAt?: string;
  lastExecution?: string;
  spec: Record<string, unknown>;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
  owner: string;
  apiVersion?: string;
  kind?: string;
}

export interface AgentListFilters {
  namespace?: string;
  status?: Agent["status"];
  search?: string;
  page?: number;
  limit?: number;
}

export interface Namespace {
  name: string;
  displayName: string;
  agentCount: number;
  status: "active" | "inactive";
  createdAt: string;
}

export interface TraceSpan {
  spanId: string;
  traceId: string;
  parentSpanId?: string;
  operationName: string;
  serviceName: string;
  startTime: string;
  endTime: string;
  durationMs: number;
  status: "ok" | "error" | "unset";
  attributes: Record<string, string>;
}

export interface Trace {
  traceId: string;
  agentId: string;
  executionId: string;
  operationName: string;
  startTime: string;
  endTime: string;
  durationMs: number;
  spanCount: number;
  errorCount: number;
  spans: TraceSpan[];
}

export interface TraceListFilters {
  namespace?: string;
  from?: string;
  to?: string;
  page?: number;
  limit?: number;
}

export interface DashboardMetrics {
  activeAgents: number;
  executions24h: number;
  avgLatencyMs: number;
  errorRate: number;
  totalCostUsd: number;
  activeNamespaces: number;
}

export interface Execution {
  id: string;
  agentId: string;
  agentName: string;
  namespace: string;
  status: "running" | "succeeded" | "failed" | "cancelled" | "queued";
  startTime: string;
  endTime?: string;
  durationMs?: number;
  costUsd?: number;
  traceId: string;
}

export interface RunAgentResponse {
  executionId: string;
  workflowId: string;
  agentId: string;
  agentName: string;
  status: string;
  startTime: string;
  message: string;
}

export interface HealthStatus {
  status: "healthy" | "degraded" | "unhealthy";
  services: { name: string; status: string; latencyMs: number }[];
}

export interface SSEEvent {
  type: "agent.status_changed" | "execution.completed" | "execution.started";
  data: Record<string, unknown>;
}
