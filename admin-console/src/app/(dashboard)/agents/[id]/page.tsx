"use client";

import { useState, use } from "react";
import Link from "next/link";
import {
  ArrowLeft,
  Play,
  Clock,
  CheckCircle,
  XCircle,
  AlertTriangle,
  Cpu,
  Activity,
  Settings,
  History,
  Copy,
  ExternalLink,
} from "lucide-react";
import { useAgent, useAgentExecutions, useRunAgent } from "@/lib/api/queries";
import type { Execution, Agent } from "@/lib/types";
import {
  ApiErrorBoundary,
  SkeletonCard,
  EmptyState,
} from "@/components/ErrorStates";

function StatusBadge({ status }: { status: string }) {
  const styles: Record<string, string> = {
    running: "bg-info/10 text-info border-info/20",
    succeeded: "bg-success/10 text-success border-success/20",
    failed: "bg-error/10 text-error border-error/20",
    pending: "bg-warning/10 text-warning border-warning/20",
    queued: "bg-white/5 text-text-muted border-white/10",
    cancelled: "bg-white/5 text-text-muted border-white/10",
  };
  const icons: Record<string, typeof CheckCircle> = {
    running: Clock,
    succeeded: CheckCircle,
    failed: XCircle,
    pending: AlertTriangle,
    queued: Clock,
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

function OverviewTab({ agent }: { agent: Agent }) {
  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
      <div className="glass-card p-6 space-y-4">
        <h3 className="text-sm font-bold uppercase tracking-widest text-text-muted">Details</h3>
        <div className="space-y-3">
          <div className="flex justify-between">
            <span className="text-sm text-text-secondary">Name</span>
            <span className="text-sm font-semibold text-text-primary">{agent.name}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-sm text-text-secondary">Namespace</span>
            <span className="text-sm font-semibold text-text-primary">{agent.namespace}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-sm text-text-secondary">Version</span>
            <span className="text-sm font-semibold text-text-primary">{agent.version}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-sm text-text-secondary">API Version</span>
            <span className="text-sm font-semibold text-text-primary">{agent.apiVersion ?? "egaop.io/v1"}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-sm text-text-secondary">Kind</span>
            <span className="text-sm font-semibold text-text-primary">{agent.kind ?? "Agent"}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-sm text-text-secondary">Owner</span>
            <span className="text-sm font-semibold text-text-primary">{agent.owner || "—"}</span>
          </div>
        </div>
      </div>

      <div className="glass-card p-6 space-y-4">
        <h3 className="text-sm font-bold uppercase tracking-widest text-text-muted">Status</h3>
        <div className="space-y-3">
          <div className="flex justify-between items-center">
            <span className="text-sm text-text-secondary">Phase</span>
          <StatusBadge status={agent.status} />
          </div>
          <div className="flex justify-between items-center">
            <span className="text-sm text-text-secondary">Health</span>
            <span className={`text-sm font-semibold ${
              agent.health === "Healthy" ? "text-success" :
              agent.health === "Degraded" ? "text-warning" : "text-error"
            }`}>
              {agent.health}
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-sm text-text-secondary">Created</span>
            <span className="text-sm text-text-primary">{new Date(agent.createdAt).toLocaleString()}</span>
          </div>
          {agent.updatedAt && (
            <div className="flex justify-between">
              <span className="text-sm text-text-secondary">Updated</span>
              <span className="text-sm text-text-primary">{new Date(agent.updatedAt).toLocaleString()}</span>
            </div>
          )}
          {agent.lastExecution && (
            <div className="flex justify-between">
              <span className="text-sm text-text-secondary">Last Execution</span>
              <span className="text-sm text-text-primary">{new Date(agent.lastExecution).toLocaleString()}</span>
            </div>
          )}
        </div>
      </div>

      {Object.keys(agent.labels ?? {}).length > 0 && (
        <div className="glass-card p-6 space-y-4 lg:col-span-2">
          <h3 className="text-sm font-bold uppercase tracking-widest text-text-muted">Labels</h3>
          <div className="flex flex-wrap gap-2">
            {Object.entries(agent.labels ?? {}).map(([key, value]) => (
              <span
                key={key}
                className="inline-flex items-center gap-1 px-3 py-1.5 bg-white/5 border border-white/10 rounded-lg text-xs"
              >
                <span className="font-semibold text-text-primary">{key}</span>
                <span className="text-text-muted">=</span>
                <span className="text-text-secondary">{value}</span>
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function ExecutionsTab({ agentId }: { agentId: string }) {
  const [page, setPage] = useState(1);
  const { data, isLoading } = useAgentExecutions(agentId, page, 10);
  const executions = data?.data?.items ?? [];
  const total = data?.data?.total ?? 0;
  const hasNext = data?.data?.hasNext ?? false;

  if (isLoading) {
    return (
      <div className="glass-card p-8 animate-pulse">
        <div className="h-4 bg-white/5 rounded w-1/4 mb-4" />
        <div className="space-y-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="h-12 bg-white/5 rounded" />
          ))}
        </div>
      </div>
    );
  }

  if (executions.length === 0) {
    return (
      <EmptyState
        label="No executions yet"
        description="Run this agent to see execution history"
      />
    );
  }

  return (
    <div className="glass-card overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full">
          <thead>
            <tr className="border-b border-white/5">
              <th className="px-6 py-3 text-left text-[10px] font-bold uppercase tracking-widest text-text-muted">
                Execution ID
              </th>
              <th className="px-6 py-3 text-left text-[10px] font-bold uppercase tracking-widest text-text-muted">
                Status
              </th>
              <th className="px-6 py-3 text-left text-[10px] font-bold uppercase tracking-widest text-text-muted">
                Started
              </th>
              <th className="px-6 py-3 text-left text-[10px] font-bold uppercase tracking-widest text-text-muted">
                Duration
              </th>
              <th className="px-6 py-3 text-left text-[10px] font-bold uppercase tracking-widest text-text-muted">
                Cost
              </th>
              <th className="px-6 py-3 text-right text-[10px] font-bold uppercase tracking-widest text-text-muted">
                Trace
              </th>
            </tr>
          </thead>
          <tbody>
            {executions.map((exec) => (
              <tr
                key={exec.id}
                className="border-b border-white/5 hover:bg-white/[0.02] transition-colors"
              >
                <td className="px-6 py-4">
                  <span className="text-sm font-mono text-text-primary">{exec.id}</span>
                </td>
                <td className="px-6 py-4">
                  <StatusBadge status={exec.status} />
                </td>
                <td className="px-6 py-4 text-sm text-text-secondary">
                  {new Date(exec.startTime).toLocaleString()}
                </td>
                <td className="px-6 py-4 text-sm text-text-secondary">
                  {exec.durationMs ? `${(exec.durationMs / 1000).toFixed(1)}s` : "—"}
                </td>
                <td className="px-6 py-4 text-sm text-text-secondary">
                  {exec.costUsd ? `$${exec.costUsd.toFixed(4)}` : "—"}
                </td>
                <td className="px-6 py-4 text-right">
                  <Link
                    href={`/observability?trace=${exec.traceId}`}
                    className="inline-flex items-center gap-1 text-xs text-brand-primary hover:text-brand-primary/80 transition-colors"
                  >
                    <ExternalLink className="w-3 h-3" />
                    View
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="p-4 border-t border-white/5 flex items-center justify-between">
        <p className="text-xs text-text-muted">
          Showing {(page - 1) * 10 + 1}–{Math.min(page * 10, total)} of {total}
        </p>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            disabled={page <= 1}
            className="px-3 py-1.5 text-xs rounded-lg hover:bg-white/5 text-text-secondary disabled:opacity-30 transition-colors"
          >
            Previous
          </button>
          <span className="text-xs font-semibold text-text-secondary px-2">Page {page}</span>
          <button
            onClick={() => setPage((p) => p + 1)}
            disabled={!hasNext}
            className="px-3 py-1.5 text-xs rounded-lg hover:bg-white/5 text-text-secondary disabled:opacity-30 transition-colors"
          >
            Next
          </button>
        </div>
      </div>
    </div>
  );
}

function ConfigTab({ agent }: { agent: Agent }) {
  const specJson = JSON.stringify(agent.spec, null, 2);

  return (
    <div className="glass-card p-6 space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-bold uppercase tracking-widest text-text-muted">Agent Spec</h3>
        <button
          onClick={() => navigator.clipboard.writeText(specJson)}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg bg-white/5 hover:bg-white/10 text-text-secondary transition-colors"
        >
          <Copy className="w-3 h-3" />
          Copy
        </button>
      </div>
      <pre className="p-4 bg-black/20 rounded-xl text-sm font-mono text-text-secondary overflow-x-auto whitespace-pre-wrap">
        {specJson}
      </pre>
    </div>
  );
}

function AgentDetail({ agentId }: { agentId: string }) {
  const [tab, setTab] = useState<"overview" | "executions" | "config">("overview");
  const { data, isLoading, error } = useAgent(agentId);
  const runAgent = useRunAgent();
  const agent = data?.data ?? null;

  if (isLoading) {
    return (
      <div className="space-y-6">
        <div className="flex items-center gap-4">
          <SkeletonCard />
        </div>
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <SkeletonCard />
          <SkeletonCard />
        </div>
      </div>
    );
  }

  if (error || !agent) {
    return (
      <div className="glass-card p-12 text-center space-y-4">
        <AlertTriangle className="w-12 h-12 text-error mx-auto" />
        <h3 className="text-lg font-bold text-text-primary">Agent not found</h3>
        <p className="text-sm text-text-secondary">
          The agent you&apos;re looking for doesn&apos;t exist or has been deleted.
        </p>
        <Link href="/agents" className="btn-primary text-sm inline-flex items-center gap-2">
          <ArrowLeft className="w-4 h-4" />
          Back to Agents
        </Link>
      </div>
    );
  }

  const agentData = agent;

  const handleRun = () => {
    runAgent.mutate(
      { agentId: agentData.id, input: {} },
      {
        onSuccess: (resp) => {
          alert(`Workflow queued! ID: ${resp.data.workflowId}`);
        },
        onError: (err) => {
          alert(`Failed to run agent: ${err.message}`);
        },
      }
    );
  };

  const tabs = [
    { id: "overview" as const, label: "Overview", icon: Activity },
    { id: "executions" as const, label: "Executions", icon: History },
    { id: "config" as const, label: "Config", icon: Settings },
  ];

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <Link
            href="/agents"
            className="p-2 rounded-lg hover:bg-white/5 text-text-secondary transition-colors"
          >
            <ArrowLeft className="w-5 h-5" />
          </Link>
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-brand-primary/10 flex items-center justify-center">
              <Cpu className="w-5 h-5 text-brand-primary" />
            </div>
            <div>
              <h1 className="text-2xl font-bold text-text-primary">{agentData.name}</h1>
              <p className="text-xs text-text-muted">
                {agentData.namespace} / {agentData.version}
              </p>
            </div>
          </div>
          <StatusBadge status={agent.status} />
        </div>

        <button
          onClick={handleRun}
          disabled={runAgent.isPending}
          className="btn-primary text-sm flex items-center gap-2 disabled:opacity-50"
        >
          {runAgent.isPending ? (
            <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
          ) : (
            <Play className="w-4 h-4" />
          )}
          Run Agent
        </button>
      </div>

      {/* Tabs */}
      <div className="flex items-center gap-1 border-b border-white/5">
        {tabs.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`flex items-center gap-2 px-4 py-3 text-sm font-medium transition-colors border-b-2 -mb-px ${
              tab === t.id
                ? "text-brand-primary border-brand-primary"
                : "text-text-muted border-transparent hover:text-text-secondary"
            }`}
          >
            <t.icon className="w-4 h-4" />
            {t.label}
          </button>
        ))}
      </div>

      {/* Tab Content */}
      {tab === "overview" && <OverviewTab agent={agentData} />}
      {tab === "executions" && <ExecutionsTab agentId={agentData.id} />}
      {tab === "config" && <ConfigTab agent={agentData} />}
    </div>
  );
}

export default function AgentDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return (
    <ApiErrorBoundary>
      <AgentDetail agentId={id} />
    </ApiErrorBoundary>
  );
}
