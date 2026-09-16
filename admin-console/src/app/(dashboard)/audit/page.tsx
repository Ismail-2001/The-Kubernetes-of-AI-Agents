"use client";

import { useState } from "react";
import { Suspense } from "react";
import {
  ScrollText,
  Search,
  Filter,
  Download,
  CheckCircle,
  XCircle,
  AlertTriangle,
  Info,
  ArrowUpRight,
} from "lucide-react";
import { ApiErrorBoundary, SkeletonTable, EmptyState } from "@/components/ErrorStates";

interface AuditEntry {
  id: string;
  timestamp: string;
  actor: string;
  actorEmail: string;
  action: string;
  resource: string;
  resourceName: string;
  outcome: "success" | "failure" | "warning";
  details: string;
  ipAddress: string;
}

const mockAudit: AuditEntry[] = [
  { id: "aud-001", timestamp: new Date(Date.now() - 300000).toISOString(), actor: "Jane Doe", actorEmail: "jane@egaop.io", action: "agent.create", resource: "Agent", resourceName: "research-agent-v2", outcome: "success", details: "Created agent in namespace 'production'", ipAddress: "192.168.1.100" },
  { id: "aud-002", timestamp: new Date(Date.now() - 600000).toISOString(), actor: "John Smith", actorEmail: "john@egaop.io", action: "namespace.update", resource: "Namespace", resourceName: "staging", outcome: "success", details: "Updated tier from starter to professional", ipAddress: "192.168.1.101" },
  { id: "aud-003", timestamp: new Date(Date.now() - 900000).toISOString(), actor: "Alice Chen", actorEmail: "alice@egaop.io", action: "policy.create", resource: "Policy", resourceName: "rate_limit.rego", outcome: "failure", details: "Rego syntax validation failed: unexpected token", ipAddress: "192.168.1.102" },
  { id: "aud-004", timestamp: new Date(Date.now() - 1800000).toISOString(), actor: "System", actorEmail: "system@egaop.io", action: "agent.scale", resource: "Agent", resourceName: "data-processor", outcome: "warning", details: "Auto-scaled from 2 to 5 replicas (quota: 80%)", ipAddress: "—" },
  { id: "aud-005", timestamp: new Date(Date.now() - 3600000).toISOString(), actor: "Jane Doe", actorEmail: "jane@egaop.io", action: "user.invite", resource: "User", resourceName: "bob@egaop.io", outcome: "success", details: "Invited as operator role", ipAddress: "192.168.1.100" },
  { id: "aud-006", timestamp: new Date(Date.now() - 7200000).toISOString(), actor: "John Smith", actorEmail: "john@egaop.io", action: "secret.rotate", resource: "Secret", resourceName: "OPENAI_API_KEY", outcome: "success", details: "Rotated encryption key for production namespace", ipAddress: "192.168.1.101" },
];

const outcomeConfig: Record<string, { icon: typeof CheckCircle; color: string; bg: string }> = {
  success: { icon: CheckCircle, color: "text-success", bg: "bg-success/10" },
  failure: { icon: XCircle, color: "text-error", bg: "bg-error/10" },
  warning: { icon: AlertTriangle, color: "text-warning", bg: "bg-warning/10" },
};

function AuditRow({ entry }: { entry: AuditEntry }) {
  const cfg = outcomeConfig[entry.outcome];
  const Icon = cfg.icon;

  return (
    <tr className="border-b border-white/5 hover:bg-white/[0.02] transition-colors">
      <td className="px-6 py-4 text-xs text-text-muted whitespace-nowrap">
        {new Date(entry.timestamp).toLocaleString()}
      </td>
      <td className="px-6 py-4">
        <div>
          <p className="text-sm font-semibold text-text-primary">{entry.actor}</p>
          <p className="text-xs text-text-muted">{entry.actorEmail}</p>
        </div>
      </td>
      <td className="px-6 py-4">
        <span className="px-2 py-1 bg-white/5 border border-white/10 rounded-lg text-xs font-mono font-medium text-text-secondary">
          {entry.action}
        </span>
      </td>
      <td className="px-6 py-4">
        <div>
          <p className="text-xs font-medium text-text-primary">{entry.resource}</p>
          <p className="text-xs text-text-muted font-mono">{entry.resourceName}</p>
        </div>
      </td>
      <td className="px-6 py-4">
        <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-bold uppercase tracking-wider border ${cfg.bg} ${cfg.color} border-current/20`}>
          <Icon className="w-3 h-3" />
          {entry.outcome}
        </span>
      </td>
      <td className="px-6 py-4 text-xs text-text-secondary max-w-[200px] truncate" title={entry.details}>
        {entry.details}
      </td>
      <td className="px-6 py-4 text-xs text-text-muted font-mono">{entry.ipAddress}</td>
    </tr>
  );
}

function AuditList() {
  const [search, setSearch] = useState("");
  const [outcomeFilter, setOutcomeFilter] = useState("all");

  const filtered = mockAudit.filter((e) => {
    const matchSearch = !search ||
      e.actor.toLowerCase().includes(search.toLowerCase()) ||
      e.action.toLowerCase().includes(search.toLowerCase()) ||
      e.resourceName.toLowerCase().includes(search.toLowerCase());
    const matchOutcome = outcomeFilter === "all" || e.outcome === outcomeFilter;
    return matchSearch && matchOutcome;
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <div className="relative flex-1 max-w-md">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-text-muted" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search audit log..."
            className="w-full pl-10 pr-4 py-2.5 bg-white/5 border border-white/10 rounded-xl text-sm text-text-primary placeholder:text-text-muted focus:border-brand-primary focus:ring-1 focus:ring-brand-primary transition-colors outline-none"
          />
        </div>
        <select
          value={outcomeFilter}
          onChange={(e) => setOutcomeFilter(e.target.value)}
          className="px-4 py-2.5 bg-white/5 border border-white/10 rounded-xl text-sm text-text-primary focus:border-brand-primary outline-none"
        >
          <option value="all">All Outcomes</option>
          <option value="success">Success</option>
          <option value="failure">Failure</option>
          <option value="warning">Warning</option>
        </select>
        <button className="btn-secondary text-sm flex items-center gap-2">
          <Download className="w-4 h-4" />
          Export CSV
        </button>
      </div>

      <div className="glass-card overflow-hidden">
        <table className="w-full">
          <thead>
            <tr className="border-b border-white/5">
              {["Time", "Actor", "Action", "Resource", "Outcome", "Details", "IP"].map((h) => (
                <th key={h} className="px-6 py-3 text-left text-[10px] font-bold uppercase tracking-widest text-text-muted">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {filtered.map((e) => <AuditRow key={e.id} entry={e} />)}
            {filtered.length === 0 && (
              <tr><td colSpan={7}>
                <EmptyState label="No audit entries found" description="Audit events will appear here as actions are performed" />
              </td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default function AuditPage() {
  return (
    <ApiErrorBoundary>
      <div className="space-y-8 animate-in fade-in slide-in-from-bottom-5 duration-700">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold text-text-primary">Audit Log</h1>
            <p className="text-sm text-text-secondary mt-1">Track all platform actions for compliance and security</p>
          </div>
        </div>
        <Suspense fallback={<SkeletonTable rows={5} />}>
          <AuditList />
        </Suspense>
      </div>
    </ApiErrorBoundary>
  );
}
