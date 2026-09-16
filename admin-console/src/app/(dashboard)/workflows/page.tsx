"use client";

import { useState } from "react";
import { Suspense } from "react";
import {
  GitBranch,
  Play,
  Pause,
  CheckCircle,
  XCircle,
  Clock,
  Search,
  MoreVertical,
  RefreshCw,
} from "lucide-react";
import { ApiErrorBoundary, SkeletonTable, EmptyState } from "@/components/ErrorStates";
import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/api/client";
import type { ApiResponse, PaginatedData, Execution } from "@/lib/types";

function useWorkflowList() {
  return useQuery<ApiResponse<PaginatedData<Execution>>>({
    queryKey: ["workflows"],
    queryFn: () => apiRequest<PaginatedData<Execution>>("/api/traces?limit=50"),
    staleTime: 30_000,
    retry: false,
  });
}

const statusConfig: Record<string, { icon: typeof CheckCircle; color: string; bg: string }> = {
  running: { icon: Play, color: "text-info", bg: "bg-info/10" },
  succeeded: { icon: CheckCircle, color: "text-success", bg: "bg-success/10" },
  failed: { icon: XCircle, color: "text-error", bg: "bg-error/10" },
  cancelled: { icon: Pause, color: "text-warning", bg: "bg-warning/10" },
};

function WorkflowRow({ exec }: { exec: Execution }) {
  const cfg = statusConfig[exec.status] ?? statusConfig.running;
  const Icon = cfg.icon;

  return (
    <tr className="border-b border-white/5 hover:bg-white/[0.02] transition-colors">
      <td className="px-6 py-4">
        <div className="flex items-center gap-3">
          <div className={`w-8 h-8 rounded-lg ${cfg.bg} flex items-center justify-center`}>
            <Icon className={`w-4 h-4 ${cfg.color}`} />
          </div>
          <div>
            <p className="text-sm font-semibold text-text-primary">{exec.agentName}</p>
            <p className="text-xs text-text-muted font-mono">{exec.id}</p>
          </div>
        </div>
      </td>
      <td className="px-6 py-4">
        <span className="px-2 py-1 bg-white/5 border border-white/10 rounded-lg text-xs font-medium text-text-secondary">
          {exec.namespace}
        </span>
      </td>
      <td className="px-6 py-4 text-xs text-text-muted">
        {new Date(exec.startTime).toLocaleString()}
      </td>
      <td className="px-6 py-4 text-xs text-text-secondary">
        {exec.durationMs != null ? `${exec.durationMs}ms` : "—"}
      </td>
      <td className="px-6 py-4 text-xs text-text-secondary">
        {exec.costUsd != null ? `$${exec.costUsd.toFixed(4)}` : "—"}
      </td>
      <td className="px-6 py-4">
        <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-bold uppercase tracking-wider border ${
          exec.status === "running" ? "bg-info/10 text-info border-info/20" :
          exec.status === "succeeded" ? "bg-success/10 text-success border-success/20" :
          exec.status === "failed" ? "bg-error/10 text-error border-error/20" :
          "bg-warning/10 text-warning border-warning/20"
        }`}>
          {exec.status}
        </span>
      </td>
      <td className="px-6 py-4">
        <button className="p-1.5 rounded-lg hover:bg-white/5 transition-colors text-text-muted">
          <MoreVertical className="w-4 h-4" />
        </button>
      </td>
    </tr>
  );
}

function WorkflowList() {
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const { data, isLoading } = useWorkflowList();
  const executions = data?.data?.items ?? [];

  const filtered = executions.filter((e) => {
    const matchSearch = !search || e.agentName.toLowerCase().includes(search.toLowerCase()) || e.id.toLowerCase().includes(search.toLowerCase());
    const matchStatus = statusFilter === "all" || e.status === statusFilter;
    return matchSearch && matchStatus;
  });

  if (isLoading) return <SkeletonTable rows={5} />;

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <div className="relative flex-1 max-w-md">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-text-muted" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search workflows..."
            className="w-full pl-10 pr-4 py-2.5 bg-white/5 border border-white/10 rounded-xl text-sm text-text-primary placeholder:text-text-muted focus:border-brand-primary focus:ring-1 focus:ring-brand-primary transition-colors outline-none"
          />
        </div>
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className="px-4 py-2.5 bg-white/5 border border-white/10 rounded-xl text-sm text-text-primary focus:border-brand-primary outline-none"
        >
          <option value="all">All Status</option>
          <option value="running">Running</option>
          <option value="succeeded">Succeeded</option>
          <option value="failed">Failed</option>
          <option value="cancelled">Cancelled</option>
        </select>
        <button className="btn-secondary text-sm flex items-center gap-2">
          <RefreshCw className="w-4 h-4" />
          Refresh
        </button>
      </div>

      <div className="glass-card overflow-hidden">
        <table className="w-full">
          <thead>
            <tr className="border-b border-white/5">
              {["Workflow", "Namespace", "Started", "Duration", "Cost", "Status", ""].map((h) => (
                <th key={h} className="px-6 py-3 text-left text-[10px] font-bold uppercase tracking-widest text-text-muted">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {filtered.map((e) => <WorkflowRow key={e.id} exec={e} />)}
            {filtered.length === 0 && (
              <tr><td colSpan={7}>
                <EmptyState label="No workflows found" description="Workflows will appear here when agents are executed" />
              </td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default function WorkflowsPage() {
  return (
    <ApiErrorBoundary>
      <div className="space-y-8 animate-in fade-in slide-in-from-bottom-5 duration-700">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold text-text-primary">Workflows</h1>
            <p className="text-sm text-text-secondary mt-1">Monitor and manage agent execution workflows</p>
          </div>
        </div>
        <Suspense fallback={<SkeletonTable rows={5} />}>
          <WorkflowList />
        </Suspense>
      </div>
    </ApiErrorBoundary>
  );
}
