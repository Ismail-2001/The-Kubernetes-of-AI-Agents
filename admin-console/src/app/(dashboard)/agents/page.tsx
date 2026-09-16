"use client";

import { Suspense, useState, useCallback } from "react";
import Link from "next/link";
import {
  Plus,
  Search,
  Filter,
  Trash2,
  X,
  ChevronLeft,
  ChevronRight,
  Cpu,
  CheckCircle,
  XCircle,
  Clock,
  AlertTriangle,
  ArrowRight,
} from "lucide-react";
import {
  useAgents,
  useNamespaces,
  useCreateAgent,
  useDeleteAgent,
} from "@/lib/api/queries";
import { useSSE } from "@/lib/realtime";
import type { Agent, AgentListFilters } from "@/lib/types";
import {
  ApiErrorBoundary,
  EmptyState,
  SkeletonTable,
} from "@/components/ErrorStates";

function StatusBadge({ status }: { status: Agent["status"] }) {
  const styles: Record<string, string> = {
    running: "bg-info/10 text-info border-info/20",
    succeeded: "bg-success/10 text-success border-success/20",
    failed: "bg-error/10 text-error border-error/20",
    pending: "bg-warning/10 text-warning border-warning/20",
    cancelled: "bg-white/5 text-text-muted border-white/10",
  };
  const icons: Record<string, typeof CheckCircle> = {
    running: Clock,
    succeeded: CheckCircle,
    failed: XCircle,
    pending: AlertTriangle,
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

function AgentFilters({
  filters,
  onChange,
}: {
  filters: AgentListFilters;
  onChange: (f: AgentListFilters) => void;
}) {
  const { data: nsData } = useNamespaces();
  const namespaces = nsData?.data ?? [];

  return (
    <div className="flex flex-wrap items-center gap-3">
      <div className="relative flex-1 min-w-[200px] max-w-md">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-text-muted" />
        <input
          type="text"
          placeholder="Search agents..."
          value={filters.search ?? ""}
          onChange={(e) => onChange({ ...filters, search: e.target.value, page: 1 })}
          className="w-full pl-10 pr-4 py-2.5 bg-white/5 border border-white/10 rounded-xl text-sm text-text-primary placeholder:text-text-muted focus:outline-none focus:border-brand-primary/50 focus:ring-1 focus:ring-brand-primary/20 transition-all"
        />
      </div>

      <select
        value={filters.namespace ?? ""}
        onChange={(e) =>
          onChange({ ...filters, namespace: e.target.value || undefined, page: 1 })
        }
        className="px-4 py-2.5 bg-white/5 border border-white/10 rounded-xl text-sm text-text-primary focus:outline-none focus:border-brand-primary/50 transition-all"
      >
        <option value="">All Namespaces</option>
        {namespaces.map((ns) => (
          <option key={ns.name} value={ns.name}>
            {ns.displayName}
          </option>
        ))}
      </select>

      <select
        value={filters.status ?? ""}
        onChange={(e) =>
          onChange({ ...filters, status: (e.target.value || undefined) as Agent["status"], page: 1 })
        }
        className="px-4 py-2.5 bg-white/5 border border-white/10 rounded-xl text-sm text-text-primary focus:outline-none focus:border-brand-primary/50 transition-all"
      >
        <option value="">All Statuses</option>
        <option value="running">Running</option>
        <option value="pending">Pending</option>
        <option value="succeeded">Succeeded</option>
        <option value="failed">Failed</option>
        <option value="cancelled">Cancelled</option>
      </select>
    </div>
  );
}

function CreateAgentModal({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const createAgent = useCreateAgent();
  const [name, setName] = useState("");
  const [namespace, setNamespace] = useState("default");
  const { data: nsData } = useNamespaces();
  const namespaces = nsData?.data ?? [];

  const handleSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      createAgent.mutate(
        { name, namespace, spec: {} },
        { onSuccess: () => { onClose(); setName(""); } }
      );
    },
    [name, namespace, createAgent, onClose]
  );

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="glass-card w-full max-w-md p-8 space-y-6">
        <div className="flex items-center justify-between">
          <h2 className="text-xl font-bold text-text-primary">Register Agent</h2>
          <button onClick={onClose} className="p-2 rounded-lg hover:bg-white/5 text-text-secondary">
            <X className="w-5 h-5" />
          </button>
        </div>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-xs font-bold uppercase tracking-widest text-text-muted mb-2">
              Agent Name
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              className="w-full px-4 py-3 bg-white/5 border border-white/10 rounded-xl text-sm text-text-primary focus:outline-none focus:border-brand-primary/50 transition-all"
              placeholder="my-agent"
            />
          </div>
          <div>
            <label className="block text-xs font-bold uppercase tracking-widest text-text-muted mb-2">
              Namespace
            </label>
            <select
              value={namespace}
              onChange={(e) => setNamespace(e.target.value)}
              className="w-full px-4 py-3 bg-white/5 border border-white/10 rounded-xl text-sm text-text-primary focus:outline-none focus:border-brand-primary/50 transition-all"
            >
              {namespaces.map((ns) => (
                <option key={ns.name} value={ns.name}>
                  {ns.displayName}
                </option>
              ))}
              {namespaces.length === 0 && <option value="default">default</option>}
            </select>
          </div>
          <div className="flex justify-end gap-3 pt-2">
            <button type="button" onClick={onClose} className="btn-secondary text-sm">
              Cancel
            </button>
            <button
              type="submit"
              disabled={createAgent.isPending}
              className="btn-primary text-sm disabled:opacity-50"
            >
              {createAgent.isPending ? "Creating..." : "Create Agent"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function DeleteConfirmDialog({
  agent,
  onClose,
}: {
  agent: Agent;
  onClose: () => void;
}) {
  const deleteAgent = useDeleteAgent();

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="glass-card w-full max-w-sm p-8 space-y-6">
        <h2 className="text-xl font-bold text-text-primary">Delete Agent</h2>
        <p className="text-sm text-text-secondary">
          Are you sure you want to delete{" "}
          <span className="font-semibold text-text-primary">{agent.name}</span>? This action cannot
          be undone.
        </p>
        <div className="flex justify-end gap-3">
          <button onClick={onClose} className="btn-secondary text-sm">
            Cancel
          </button>
          <button
            onClick={() =>
              deleteAgent.mutate(agent.id, { onSuccess: onClose })
            }
            disabled={deleteAgent.isPending}
            className="px-6 py-3 bg-error text-white font-semibold rounded-xl text-sm transition-all hover:bg-error/90 active:scale-95 disabled:opacity-50"
          >
            {deleteAgent.isPending ? "Deleting..." : "Delete"}
          </button>
        </div>
      </div>
    </div>
  );
}

function AgentList() {
  const [filters, setFilters] = useState<AgentListFilters>({ page: 1, limit: 10 });
  const [createOpen, setCreateOpen] = useState(false);
  const [deleteAgent, setDeleteAgent] = useState<Agent | null>(null);

  const { data, isLoading, isFetching } = useAgents(filters);
  const agents = data?.data?.items ?? [];
  const total = data?.data?.total ?? 0;
  const page = data?.data?.page ?? 1;
  const hasNext = data?.data?.hasNext ?? false;

  useSSE(filters.namespace);

  const runningAgents = agents.filter((a) => a.status === "running");
  const showPollingIndicator = isFetching && !isLoading;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <h1 className="text-3xl font-bold text-text-primary">Agents</h1>
          {showPollingIndicator && (
            <div className="w-2 h-2 rounded-full bg-brand-primary animate-pulse" />
          )}
        </div>
        <button onClick={() => setCreateOpen(true)} className="btn-primary text-sm flex items-center gap-2">
          <Plus className="w-4 h-4" /> Register Agent
        </button>
      </div>

      <AgentFilters filters={filters} onChange={setFilters} />

      {isLoading ? (
        <SkeletonTable rows={5} />
      ) : agents.length === 0 ? (
        <EmptyState
          label="No agents found"
          description={filters.search || filters.namespace || filters.status ? "Try adjusting your filters" : "Register your first agent to get started"}
          action={
            !filters.search && !filters.namespace && !filters.status ? (
              <button onClick={() => setCreateOpen(true)} className="btn-primary text-sm">
                <Plus className="w-4 h-4 inline mr-2" /> Register Agent
              </button>
            ) : undefined
          }
        />
      ) : (
        <div className="glass-card overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-white/5">
                  <th className="px-6 py-3 text-left text-[10px] font-bold uppercase tracking-widest text-text-muted">
                    Name
                  </th>
                  <th className="px-6 py-3 text-left text-[10px] font-bold uppercase tracking-widest text-text-muted">
                    Namespace
                  </th>
                  <th className="px-6 py-3 text-left text-[10px] font-bold uppercase tracking-widest text-text-muted">
                    Status
                  </th>
                  <th className="px-6 py-3 text-left text-[10px] font-bold uppercase tracking-widest text-text-muted">
                    Last Execution
                  </th>
                  <th className="px-6 py-3 text-right text-[10px] font-bold uppercase tracking-widest text-text-muted">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody>
                {agents.map((agent) => (
                  <tr
                    key={agent.id}
                    className="border-b border-white/5 hover:bg-white/[0.02] transition-colors"
                  >
                    <td className="px-6 py-4">
                      <Link href={`/agents/${agent.id}`} className="flex items-center gap-3 group">
                        <div className="w-8 h-8 rounded-lg bg-brand-primary/10 flex items-center justify-center group-hover:bg-brand-primary/20 transition-colors">
                          <Cpu className="w-4 h-4 text-brand-primary" />
                        </div>
                        <div>
                          <p className="text-sm font-semibold text-text-primary group-hover:text-brand-primary transition-colors">{agent.name}</p>
                          <p className="text-xs text-text-muted">v{agent.version}</p>
                        </div>
                      </Link>
                    </td>
                    <td className="px-6 py-4 text-sm text-text-secondary">{agent.namespace}</td>
                    <td className="px-6 py-4">
                      <StatusBadge status={agent.status} />
                    </td>
                    <td className="px-6 py-4 text-sm text-text-secondary">
                      {agent.lastExecution
                        ? new Date(agent.lastExecution).toLocaleString()
                        : "—"}
                    </td>
                    <td className="px-6 py-4 text-right">
                      <div className="flex items-center justify-end gap-1">
                        <Link
                          href={`/agents/${agent.id}`}
                          className="p-2 rounded-lg hover:bg-white/5 text-text-muted hover:text-brand-primary transition-colors"
                          title="View details"
                        >
                          <ArrowRight className="w-4 h-4" />
                        </Link>
                        <button
                          onClick={() => setDeleteAgent(agent)}
                          className="p-2 rounded-lg hover:bg-error/10 text-text-muted hover:text-error transition-colors"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="p-4 border-t border-white/5 flex items-center justify-between">
            <p className="text-xs text-text-muted">
              Showing {(page - 1) * (filters.limit ?? 10) + 1}–
              {Math.min(page * (filters.limit ?? 10), total)} of {total}
            </p>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setFilters((f) => ({ ...f, page: Math.max(1, (f.page ?? 1) - 1) }))}
                disabled={page <= 1}
                className="p-2 rounded-lg hover:bg-white/5 text-text-secondary disabled:opacity-30 transition-colors"
              >
                <ChevronLeft className="w-4 h-4" />
              </button>
              <span className="text-xs font-semibold text-text-secondary px-2">
                Page {page}
              </span>
              <button
                onClick={() => setFilters((f) => ({ ...f, page: (f.page ?? 1) + 1 }))}
                disabled={!hasNext}
                className="p-2 rounded-lg hover:bg-white/5 text-text-secondary disabled:opacity-30 transition-colors"
              >
                <ChevronRight className="w-4 h-4" />
              </button>
            </div>
          </div>
        </div>
      )}

      {runningAgents.length > 0 && (
        <div className="glass-card p-4 flex items-center gap-3">
          <div className="w-2 h-2 rounded-full bg-info animate-pulse" />
          <span className="text-xs text-text-secondary">
            {runningAgents.length} agent{runningAgents.length !== 1 ? "s" : ""} running — status
            updates every 5s
          </span>
        </div>
      )}

      <CreateAgentModal open={createOpen} onClose={() => setCreateOpen(false)} />
      {deleteAgent && (
        <DeleteConfirmDialog agent={deleteAgent} onClose={() => setDeleteAgent(null)} />
      )}
    </div>
  );
}

export default function AgentsPage() {
  return (
    <ApiErrorBoundary>
      <AgentList />
    </ApiErrorBoundary>
  );
}
