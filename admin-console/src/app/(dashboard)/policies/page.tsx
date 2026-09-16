"use client";

import { useState } from "react";
import { Suspense } from "react";
import {
  Shield,
  Plus,
  Search,
  FileCode,
  CheckCircle,
  XCircle,
  Edit3,
  Trash2,
  MoreVertical,
  Eye,
} from "lucide-react";
import { ApiErrorBoundary, SkeletonTable, EmptyState } from "@/components/ErrorStates";

interface Policy {
  id: string;
  name: string;
  description: string;
  type: "admission" | "runtime" | "rate-limit";
  enabled: boolean;
  lastUpdated: string;
  author: string;
  version: string;
}

const mockPolicies: Policy[] = [
  { id: "pol-001", name: "agent_creation.rego", description: "Validates agent creation requests against tier quotas", type: "admission", enabled: true, lastUpdated: new Date(Date.now() - 86400000).toISOString(), author: "admin@egaop.io", version: "v1.2.0" },
  { id: "pol-002", name: "tool_call.rego", description: "Enforces tool execution permissions and sandbox isolation", type: "runtime", enabled: true, lastUpdated: new Date(Date.now() - 172800000).toISOString(), author: "admin@egaop.io", version: "v1.0.3" },
  { id: "pol-003", name: "rate_limit.rego", description: "Global rate limiting policy for LLM API calls", type: "rate-limit", enabled: false, lastUpdated: new Date(Date.now() - 604800000).toISOString(), author: "dev@egaop.io", version: "v0.9.1" },
  { id: "pol-004", name: "cross_namespace.rego", description: "Prevents cross-namespace resource access", type: "admission", enabled: true, lastUpdated: new Date(Date.now() - 259200000).toISOString(), author: "admin@egaop.io", version: "v1.1.0" },
];

const typeConfig: Record<string, { label: string; color: string; bg: string }> = {
  admission: { label: "Admission", color: "text-brand-primary", bg: "bg-brand-primary/10" },
  runtime: { label: "Runtime", color: "text-info", bg: "bg-info/10" },
  "rate-limit": { label: "Rate Limit", color: "text-warning", bg: "bg-warning/10" },
};

function PolicyRow({ policy }: { policy: Policy }) {
  const typeCfg = typeConfig[policy.type];

  return (
    <tr className="border-b border-white/5 hover:bg-white/[0.02] transition-colors">
      <td className="px-6 py-4">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-white/5 flex items-center justify-center">
            <FileCode className="w-4 h-4 text-brand-primary" />
          </div>
          <div>
            <p className="text-sm font-semibold text-text-primary font-mono">{policy.name}</p>
            <p className="text-xs text-text-muted">{policy.description}</p>
          </div>
        </div>
      </td>
      <td className="px-6 py-4">
        <span className={`px-2.5 py-1 rounded-lg text-xs font-bold ${typeCfg.bg} ${typeCfg.color}`}>
          {typeCfg.label}
        </span>
      </td>
      <td className="px-6 py-4">
        {policy.enabled ? (
          <span className="inline-flex items-center gap-1.5 text-xs font-bold text-success">
            <CheckCircle className="w-3 h-3" /> Enabled
          </span>
        ) : (
          <span className="inline-flex items-center gap-1.5 text-xs font-bold text-text-muted">
            <XCircle className="w-3 h-3" /> Disabled
          </span>
        )}
      </td>
      <td className="px-6 py-4 text-xs text-text-muted font-mono">{policy.version}</td>
      <td className="px-6 py-4 text-xs text-text-muted">{new Date(policy.lastUpdated).toLocaleDateString()}</td>
      <td className="px-6 py-4">
        <div className="flex items-center gap-1">
          <button className="p-1.5 rounded-lg hover:bg-white/5 transition-colors text-text-muted" title="View">
            <Eye className="w-4 h-4" />
          </button>
          <button className="p-1.5 rounded-lg hover:bg-white/5 transition-colors text-text-muted" title="Edit">
            <Edit3 className="w-4 h-4" />
          </button>
          <button className="p-1.5 rounded-lg hover:bg-white/5 transition-colors text-text-muted" title="Delete">
            <Trash2 className="w-4 h-4" />
          </button>
        </div>
      </td>
    </tr>
  );
}

function PolicyList() {
  const [search, setSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState("all");

  const filtered = mockPolicies.filter((p) => {
    const matchSearch = !search || p.name.toLowerCase().includes(search.toLowerCase()) || p.description.toLowerCase().includes(search.toLowerCase());
    const matchType = typeFilter === "all" || p.type === typeFilter;
    return matchSearch && matchType;
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
            placeholder="Search policies..."
            className="w-full pl-10 pr-4 py-2.5 bg-white/5 border border-white/10 rounded-xl text-sm text-text-primary placeholder:text-text-muted focus:border-brand-primary focus:ring-1 focus:ring-brand-primary transition-colors outline-none"
          />
        </div>
        <select
          value={typeFilter}
          onChange={(e) => setTypeFilter(e.target.value)}
          className="px-4 py-2.5 bg-white/5 border border-white/10 rounded-xl text-sm text-text-primary focus:border-brand-primary outline-none"
        >
          <option value="all">All Types</option>
          <option value="admission">Admission</option>
          <option value="runtime">Runtime</option>
          <option value="rate-limit">Rate Limit</option>
        </select>
        <button className="btn-primary text-sm flex items-center gap-2">
          <Plus className="w-4 h-4" />
          New Policy
        </button>
      </div>

      <div className="glass-card overflow-hidden">
        <table className="w-full">
          <thead>
            <tr className="border-b border-white/5">
              {["Policy", "Type", "Status", "Version", "Updated", "Actions"].map((h) => (
                <th key={h} className="px-6 py-3 text-left text-[10px] font-bold uppercase tracking-widest text-text-muted">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {filtered.map((p) => <PolicyRow key={p.id} policy={p} />)}
            {filtered.length === 0 && (
              <tr><td colSpan={6}>
                <EmptyState label="No policies found" description="Create your first OPA policy to enforce governance rules" />
              </td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default function PoliciesPage() {
  return (
    <ApiErrorBoundary>
      <div className="space-y-8 animate-in fade-in slide-in-from-bottom-5 duration-700">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold text-text-primary">Policies</h1>
            <p className="text-sm text-text-secondary mt-1">OPA Rego policies for admission control and runtime enforcement</p>
          </div>
        </div>
        <Suspense fallback={<SkeletonTable rows={5} />}>
          <PolicyList />
        </Suspense>
      </div>
    </ApiErrorBoundary>
  );
}
