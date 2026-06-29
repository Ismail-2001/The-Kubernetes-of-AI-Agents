"use client";

import { Suspense, useState, useMemo } from "react";
import {
  Clock,
  CheckCircle,
  XCircle,
  AlertTriangle,
  ChevronRight,
  ChevronLeft,
  Layers,
} from "lucide-react";
import { useTraces, useTrace } from "@/lib/api/queries";
import type { TraceSpan, Execution } from "@/lib/types";
import {
  ApiErrorBoundary,
  EmptyState,
  SkeletonTable,
} from "@/components/ErrorStates";

const TIME_RANGES = [
  { label: "1h", value: "1h" },
  { label: "6h", value: "6h" },
  { label: "24h", value: "24h" },
  { label: "7d", value: "7d" },
] as const;

function getTimeRangeAgo(value: string): string {
  const now = Date.now();
  const ms: Record<string, number> = {
    "1h": 3_600_000,
    "6h": 21_600_000,
    "24h": 86_400_000,
    "7d": 604_800_000,
  };
  return new Date(now - (ms[value] ?? ms["1h"])).toISOString();
}

const SERVICE_COLORS: Record<string, string> = {
  "api-server": "bg-brand-primary",
  "llm-router": "bg-brand-secondary",
  "tool-proxy": "bg-accent",
  "sandbox-runtime": "bg-success",
  "memory-plane": "bg-info",
  "observability-plane": "bg-warning",
  "policy-plane": "bg-error",
};

function getServiceColor(serviceName: string): string {
  if (SERVICE_COLORS[serviceName]) return SERVICE_COLORS[serviceName];
  let hash = 0;
  for (let i = 0; i < serviceName.length; i++) {
    hash = (hash * 31 + serviceName.charCodeAt(i)) | 0;
  }
  const hue = Math.abs(hash) % 360;
  return `bg-[hsl(${hue},60%,50%)]`;
}

function StatusIcon({ status }: { status: string }) {
  if (status === "succeeded" || status === "ok")
    return <CheckCircle className="w-4 h-4 text-success" />;
  if (status === "failed" || status === "error")
    return <XCircle className="w-4 h-4 text-error" />;
  if (status === "running")
    return <Clock className="w-4 h-4 text-info animate-pulse" />;
  return <AlertTriangle className="w-4 h-4 text-warning" />;
}

function SpanWaterfall({ spans, traceStartMs }: { spans: TraceSpan[]; traceStartMs: number }) {
  const traceEndMs = Math.max(...spans.map((s) => new Date(s.endTime).getTime()));
  const traceDurationMs = Math.max(traceEndMs - traceStartMs, 1);

  const sortedSpans = useMemo(
    () => [...spans].sort((a, b) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime()),
    [spans]
  );

  return (
    <div className="space-y-1">
      {sortedSpans.map((span) => {
        const spanStartMs = new Date(span.startTime).getTime();
        const spanDurationMs = span.durationMs;
        const leftPct = ((spanStartMs - traceStartMs) / traceDurationMs) * 100;
        const widthPct = Math.max((spanDurationMs / traceDurationMs) * 100, 0.5);
        const isError = span.status === "error";
        const colorClass = getServiceColor(span.serviceName);

        return (
          <div
            key={span.spanId}
            className="group flex items-center gap-3 py-1 px-3 hover:bg-white/[0.02] rounded-lg transition-colors"
          >
            <div className="w-48 shrink-0 truncate text-xs text-text-secondary font-mono" title={span.operationName}>
              {span.operationName}
            </div>
            <div className="flex-1 relative h-6">
              <div
                className={`absolute top-0 h-full rounded-sm ${colorClass} ${
                  isError ? "ring-2 ring-error/50" : "opacity-80"
                } group-hover:opacity-100 transition-opacity`}
                style={{ left: `${leftPct}%`, width: `${widthPct}%` }}
              />
              <div className="absolute inset-0 flex items-center px-2">
                <span className="text-[10px] font-bold text-white drop-shadow-md opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap">
                  {span.serviceName} — {span.durationMs}ms
                </span>
              </div>
            </div>
            <div className="w-20 shrink-0 text-right text-xs text-text-muted">
              {span.durationMs}ms
            </div>
          </div>
        );
      })}
    </div>
  );
}

function TraceDetail({ traceId, onBack }: { traceId: string; onBack: () => void }) {
  const { data, isLoading } = useTrace(traceId);

  if (isLoading) {
    return (
      <div className="glass-card p-8 animate-pulse space-y-4">
        <div className="h-6 bg-white/5 rounded w-1/3" />
        <div className="h-4 bg-white/5 rounded w-1/2" />
        <div className="space-y-2 mt-8">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="h-8 bg-white/5 rounded" />
          ))}
        </div>
      </div>
    );
  }

  const trace = data?.data;
  if (!trace) {
    return (
      <EmptyState label="Trace not found" description={`No trace found with ID ${traceId}`} />
    );
  }

  const traceStartMs = new Date(trace.startTime).getTime();

  return (
    <div className="space-y-6">
      <button
        onClick={onBack}
        className="flex items-center gap-2 text-sm text-text-secondary hover:text-text-primary transition-colors"
      >
        <ChevronLeft className="w-4 h-4" /> Back to traces
      </button>

      <div className="glass-card p-6 space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-xl font-bold text-text-primary">{trace.operationName}</h2>
            <p className="text-xs text-text-muted font-mono mt-1">Trace: {trace.traceId}</p>
          </div>
          <div className="flex items-center gap-4 text-sm text-text-secondary">
            <span>{trace.spanCount} spans</span>
            <span>{trace.durationMs}ms</span>
            {trace.errorCount > 0 && (
              <span className="text-error font-semibold">{trace.errorCount} errors</span>
            )}
          </div>
        </div>
      </div>

      <div className="glass-card p-6">
        <h3 className="text-sm font-bold uppercase tracking-widest text-text-muted mb-4">
          Span Waterfall
        </h3>
        <SpanWaterfall spans={trace.spans} traceStartMs={traceStartMs} />
      </div>

      <div className="glass-card overflow-hidden">
        <div className="p-4 border-b border-white/5">
          <h3 className="text-sm font-bold uppercase tracking-widest text-text-muted">
            All Spans
          </h3>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="border-b border-white/5">
                <th className="px-4 py-2 text-left text-[10px] font-bold uppercase tracking-widest text-text-muted">
                  Span ID
                </th>
                <th className="px-4 py-2 text-left text-[10px] font-bold uppercase tracking-widest text-text-muted">
                  Operation
                </th>
                <th className="px-4 py-2 text-left text-[10px] font-bold uppercase tracking-widest text-text-muted">
                  Service
                </th>
                <th className="px-4 py-2 text-left text-[10px] font-bold uppercase tracking-widest text-text-muted">
                  Status
                </th>
                <th className="px-4 py-2 text-right text-[10px] font-bold uppercase tracking-widest text-text-muted">
                  Duration
                </th>
              </tr>
            </thead>
            <tbody>
              {trace.spans.map((span) => (
                <tr key={span.spanId} className="border-b border-white/5 hover:bg-white/[0.02]">
                  <td className="px-4 py-3 text-xs font-mono text-text-muted">{span.spanId}</td>
                  <td className="px-4 py-3 text-sm text-text-primary">{span.operationName}</td>
                  <td className="px-4 py-3">
                    <span
                      className={`inline-block px-2 py-0.5 rounded text-[10px] font-bold text-white ${getServiceColor(
                        span.serviceName
                      )}`}
                    >
                      {span.serviceName}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <StatusIcon status={span.status} />
                  </td>
                  <td className="px-4 py-3 text-sm text-text-secondary text-right">
                    {span.durationMs}ms
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function TraceList() {
  const [timeRange, setTimeRange] = useState("1h");
  const [selectedTraceId, setSelectedTraceId] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const limit = 20;

  const from = getTimeRangeAgo(timeRange);
  const { data, isLoading } = useTraces({ from, page, limit });
  const executions = data?.data?.items ?? [];
  const total = data?.data?.total ?? 0;
  const hasNext = data?.data?.hasNext ?? false;

  if (selectedTraceId) {
    return <TraceDetail traceId={selectedTraceId} onBack={() => setSelectedTraceId(null)} />;
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-text-primary">Observability</h1>
          <p className="text-sm text-text-secondary mt-1">
            Trace execution flows across all agents
          </p>
        </div>
        <div className="flex items-center gap-1 bg-white/5 border border-white/10 rounded-xl p-1">
          {TIME_RANGES.map((tr) => (
            <button
              key={tr.value}
              onClick={() => { setTimeRange(tr.value); setPage(1); }}
              className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all ${
                timeRange === tr.value
                  ? "bg-brand-primary text-white shadow-lg shadow-brand-primary/20"
                  : "text-text-secondary hover:text-text-primary hover:bg-white/5"
              }`}
            >
              {tr.label}
            </button>
          ))}
        </div>
      </div>

      {isLoading ? (
        <SkeletonTable rows={10} />
      ) : executions.length === 0 ? (
        <EmptyState
          label="No traces found"
          description={`No executions in the last ${timeRange}`}
        />
      ) : (
        <div className="glass-card overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-white/5">
                  <th className="px-6 py-3 text-left text-[10px] font-bold uppercase tracking-widest text-text-muted">
                    Execution
                  </th>
                  <th className="px-6 py-3 text-left text-[10px] font-bold uppercase tracking-widest text-text-muted">
                    Agent
                  </th>
                  <th className="px-6 py-3 text-left text-[10px] font-bold uppercase tracking-widest text-text-muted">
                    Status
                  </th>
                  <th className="px-6 py-3 text-left text-[10px] font-bold uppercase tracking-widest text-text-muted">
                    Duration
                  </th>
                  <th className="px-6 py-3 text-left text-[10px] font-bold uppercase tracking-widest text-text-muted">
                    Time
                  </th>
                  <th className="px-6 py-3" />
                </tr>
              </thead>
              <tbody>
                {executions.map((exec) => (
                  <tr
                    key={exec.id}
                    onClick={() => setSelectedTraceId(exec.traceId)}
                    className="border-b border-white/5 hover:bg-white/[0.02] cursor-pointer transition-colors"
                  >
                    <td className="px-6 py-4 text-sm font-mono text-text-secondary">{exec.id}</td>
                    <td className="px-6 py-4 text-sm text-text-primary">{exec.agentName}</td>
                    <td className="px-6 py-4">
                      <StatusIcon status={exec.status} />
                    </td>
                    <td className="px-6 py-4 text-sm text-text-secondary">
                      {exec.durationMs != null ? `${exec.durationMs}ms` : "—"}
                    </td>
                    <td className="px-6 py-4 text-sm text-text-muted">
                      {new Date(exec.startTime).toLocaleString()}
                    </td>
                    <td className="px-6 py-4">
                      <ChevronRight className="w-4 h-4 text-text-muted" />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="p-4 border-t border-white/5 flex items-center justify-between">
            <p className="text-xs text-text-muted">
              Showing {(page - 1) * limit + 1}–{Math.min(page * limit, total)} of {total}
            </p>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={page <= 1}
                className="p-2 rounded-lg hover:bg-white/5 text-text-secondary disabled:opacity-30 transition-colors"
              >
                <ChevronLeft className="w-4 h-4" />
              </button>
              <span className="text-xs font-semibold text-text-secondary px-2">Page {page}</span>
              <button
                onClick={() => setPage((p) => p + 1)}
                disabled={!hasNext}
                className="p-2 rounded-lg hover:bg-white/5 text-text-secondary disabled:opacity-30 transition-colors"
              >
                <ChevronRight className="w-4 h-4" />
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default function ObservabilityPage() {
  return (
    <ApiErrorBoundary>
      <TraceList />
    </ApiErrorBoundary>
  );
}
