"use client";

import { Suspense } from "react";
import {
  Zap,
  DollarSign,
  AlertTriangle,
  Shield,
  Clock,
  CheckCircle,
  XCircle,
  ArrowUpRight,
} from "lucide-react";
import { useMetrics, useTraces, useHealth } from "@/lib/api/queries";
import { useSSE } from "@/lib/realtime";
import {
  ApiErrorBoundary,
  SkeletonCard,
  SkeletonTable,
  SkeletonDashboard,
  OfflineBanner,
} from "@/components/ErrorStates";

function MetricCards() {
  const { data, isLoading, error } = useMetrics();

  if (isLoading) {
    return (
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
        {Array.from({ length: 4 }).map((_, i) => (
          <SkeletonCard key={i} />
        ))}
      </div>
    );
  }

  if (error) {
    throw error;
  }

  const m = data?.data;
  const cards = [
    {
      label: "Active Agents",
      value: m?.activeAgents ?? 0,
      icon: Zap,
      color: "text-brand-primary",
      bg: "bg-brand-primary/10",
    },
    {
      label: "Executions (24h)",
      value: m?.executions24h?.toLocaleString() ?? "0",
      icon: Clock,
      color: "text-info",
      bg: "bg-info/10",
    },
    {
      label: "Avg Latency",
      value: `${m?.avgLatencyMs ?? 0}ms`,
      icon: AlertTriangle,
      color: "text-warning",
      bg: "bg-warning/10",
    },
    {
      label: "Error Rate",
      value: `${(m?.errorRate ?? 0).toFixed(2)}%`,
      icon: Shield,
      color: m && m.errorRate > 1 ? "text-error" : "text-success",
      bg: m && m.errorRate > 1 ? "bg-error/10" : "bg-success/10",
    },
  ];

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
      {cards.map((card) => (
        <div key={card.label} className="glass-card p-6 space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-xs font-bold uppercase tracking-widest text-text-muted">
              {card.label}
            </span>
            <div className={`w-10 h-10 rounded-xl ${card.bg} flex items-center justify-center`}>
              <card.icon className={`w-5 h-5 ${card.color}`} />
            </div>
          </div>
          <p className="text-3xl font-bold text-text-primary">{card.value}</p>
        </div>
      ))}
    </div>
  );
}

function RecentExecutions() {
  const { data, isLoading } = useTraces({ limit: 10 });

  if (isLoading) return <SkeletonTable rows={5} />;

  const executions = data?.data?.items ?? [];

  return (
    <div className="glass-card overflow-hidden">
      <div className="p-6 border-b border-white/5 flex items-center justify-between">
        <h3 className="text-lg font-bold text-text-primary">Recent Executions</h3>
        <a
          href="/observability"
          className="text-xs font-semibold text-brand-primary hover:text-brand-primary/80 flex items-center gap-1"
        >
          View All <ArrowUpRight className="w-3 h-3" />
        </a>
      </div>
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
                Cost
              </th>
            </tr>
          </thead>
          <tbody>
            {executions.map((exec) => (
              <tr
                key={exec.id}
                className="border-b border-white/5 hover:bg-white/[0.02] transition-colors"
              >
                <td className="px-6 py-4 text-sm font-mono text-text-secondary">{exec.id}</td>
                <td className="px-6 py-4 text-sm text-text-primary">{exec.agentName}</td>
                <td className="px-6 py-4">
                  <StatusBadge status={exec.status} />
                </td>
                <td className="px-6 py-4 text-sm text-text-secondary">
                  {exec.durationMs != null ? `${exec.durationMs}ms` : "—"}
                </td>
                <td className="px-6 py-4 text-sm text-text-secondary">
                  {exec.costUsd != null ? `$${exec.costUsd.toFixed(4)}` : "—"}
                </td>
              </tr>
            ))}
            {executions.length === 0 && (
              <tr>
                <td colSpan={5} className="px-6 py-12 text-center text-sm text-text-muted">
                  No executions yet
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const styles: Record<string, string> = {
    running: "bg-info/10 text-info border-info/20",
    succeeded: "bg-success/10 text-success border-success/20",
    failed: "bg-error/10 text-error border-error/20",
    cancelled: "bg-warning/10 text-warning border-warning/20",
  };
  const icons: Record<string, typeof CheckCircle> = {
    running: Clock,
    succeeded: CheckCircle,
    failed: XCircle,
    cancelled: AlertTriangle,
  };
  const Icon = icons[status] ?? Clock;

  return (
    <span
      className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-bold uppercase tracking-wider border ${
        styles[status] ?? "bg-white/5 text-text-muted border-white/10"
      }`}
    >
      <Icon className="w-3 h-3" />
      {status}
    </span>
  );
}

function SystemHealth() {
  const { data, isLoading } = useHealth();

  if (isLoading) {
    return (
      <div className="glass-card p-6 animate-pulse">
        <div className="h-4 bg-white/5 rounded w-1/3 mb-4" />
        <div className="h-3 bg-white/5 rounded w-1/2" />
      </div>
    );
  }

  const isOnline = data?.data?.status === "healthy";

  return (
    <div className="glass-card p-6 space-y-4">
      <h3 className="text-lg font-bold text-text-primary">System Health</h3>
      <div className="flex items-center gap-3">
        <div
          className={`w-3 h-3 rounded-full ${
            isOnline ? "bg-success animate-pulse" : "bg-error"
          }`}
        />
        <span className="text-sm font-semibold text-text-primary">
          {isOnline ? "All systems operational" : "System degraded"}
        </span>
      </div>
      <div className="flex items-center gap-2 text-xs text-text-muted">
        <span>Last checked: {new Date().toLocaleTimeString()}</span>
        <span>•</span>
        <span>Polls every 30s</span>
      </div>
    </div>
  );
}

export default function DashboardPage() {
  useSSE();

  return (
    <ApiErrorBoundary>
      <div className="space-y-8 animate-in fade-in slide-in-from-bottom-5 duration-700">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold text-text-primary">Dashboard</h1>
            <p className="text-sm text-text-secondary mt-1">
              Platform overview and real-time metrics
            </p>
          </div>
        </div>

        <Suspense fallback={<SkeletonDashboard />}>
          <MetricCards />
        </Suspense>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className="lg:col-span-2">
            <Suspense fallback={<SkeletonTable rows={5} />}>
              <RecentExecutions />
            </Suspense>
          </div>
          <div>
            <Suspense
              fallback={
                <div className="glass-card p-6 animate-pulse">
                  <div className="h-4 bg-white/5 rounded w-1/3 mb-4" />
                  <div className="h-3 bg-white/5 rounded w-1/2" />
                </div>
              }
            >
              <SystemHealth />
            </Suspense>
          </div>
        </div>
      </div>
      <HealthPoller />
    </ApiErrorBoundary>
  );
}

function HealthPoller() {
  const { data } = useHealth();
  const isOnline = data?.data?.status === "healthy";
  return <OfflineBanner isOnline={isOnline} />;
}
