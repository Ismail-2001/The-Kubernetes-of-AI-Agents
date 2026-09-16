"use client";

import { useState } from "react";
import { Suspense } from "react";
import {
  Layers,
  Plus,
  Search,
  CheckCircle,
  XCircle,
  Edit3,
  Trash2,
} from "lucide-react";
import { ApiErrorBoundary, SkeletonTable, EmptyState } from "@/components/ErrorStates";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/api/client";
import type { ApiResponse } from "@/lib/types";

interface NamespaceItem {
  name: string;
  displayName: string;
  tier: string;
  agentCount: number;
  status: "active" | "inactive";
  createdAt: string;
  quotas: { maxAgents: number; concurrentExecutions: number; toolCallsPerMinute: number };
}

function useNamespaceList() {
  return useQuery<ApiResponse<NamespaceItem[]>>({
    queryKey: ["namespaces"],
    queryFn: () => apiRequest<NamespaceItem[]>("/api/namespaces"),
    staleTime: 30_000,
    retry: false,
  });
}

const tierConfig: Record<string, { color: string; bg: string }> = {
  sandbox: { color: "text-text-muted", bg: "bg-white/5" },
  starter: { color: "text-info", bg: "bg-info/10" },
  standard: { color: "text-info", bg: "bg-info/10" },
  professional: { color: "text-brand-primary", bg: "bg-brand-primary/10" },
  enterprise: { color: "text-success", bg: "bg-success/10" },
};

function NamespaceRow({ ns }: { ns: NamespaceItem }) {
  const tier = tierConfig[ns.tier] ?? tierConfig.sandbox;

  return (
    <tr className="border-b border-white/5 hover:bg-white/[0.02] transition-colors">
      <td className="px-6 py-4">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-white/5 flex items-center justify-center">
            <Layers className="w-4 h-4 text-brand-primary" />
          </div>
          <div>
            <p className="text-sm font-semibold text-text-primary">{ns.displayName}</p>
            <p className="text-xs text-text-muted font-mono">{ns.name}</p>
          </div>
        </div>
      </td>
      <td className="px-6 py-4">
        <span className={`px-2.5 py-1 rounded-lg text-xs font-bold ${tier.bg} ${tier.color} capitalize`}>
          {ns.tier}
        </span>
      </td>
      <td className="px-6 py-4 text-xs text-text-secondary">{ns.agentCount}</td>
      <td className="px-6 py-4 text-xs text-text-secondary">{ns.quotas?.concurrentExecutions ?? 5}</td>
      <td className="px-6 py-4 text-xs text-text-secondary">{ns.quotas?.toolCallsPerMinute ?? 20}/min</td>
      <td className="px-6 py-4">
        <span className={`inline-flex items-center gap-1.5 text-xs font-bold ${ns.status === "active" ? "text-success" : "text-text-muted"}`}>
          <div className={`w-1.5 h-1.5 rounded-full ${ns.status === "active" ? "bg-success" : "bg-text-muted"}`} />
          {ns.status}
        </span>
      </td>
      <td className="px-6 py-4">
        <div className="flex items-center gap-1">
          <button className="p-1.5 rounded-lg hover:bg-white/5 transition-colors text-text-muted"><Edit3 className="w-4 h-4" /></button>
          <button className="p-1.5 rounded-lg hover:bg-white/5 transition-colors text-text-muted"><Trash2 className="w-4 h-4" /></button>
        </div>
      </td>
    </tr>
  );
}

function NamespaceList() {
  const [search, setSearch] = useState("");
  const { data, isLoading } = useNamespaceList();
  const namespaces = data?.data ?? [];

  const filtered = namespaces.filter((ns) =>
    !search || ns.name.toLowerCase().includes(search.toLowerCase()) || ns.displayName.toLowerCase().includes(search.toLowerCase())
  );

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
            placeholder="Search namespaces..."
            className="w-full pl-10 pr-4 py-2.5 bg-white/5 border border-white/10 rounded-xl text-sm text-text-primary placeholder:text-text-muted focus:border-brand-primary focus:ring-1 focus:ring-brand-primary transition-colors outline-none"
          />
        </div>
        <button className="btn-primary text-sm flex items-center gap-2">
          <Plus className="w-4 h-4" />
          New Namespace
        </button>
      </div>

      <div className="glass-card overflow-hidden">
        <table className="w-full">
          <thead>
            <tr className="border-b border-white/5">
              {["Namespace", "Tier", "Agents", "Concurrent", "Rate Limit", "Status", ""].map((h) => (
                <th key={h} className="px-6 py-3 text-left text-[10px] font-bold uppercase tracking-widest text-text-muted">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {filtered.map((ns) => <NamespaceRow key={ns.name} ns={ns} />)}
            {filtered.length === 0 && (
              <tr><td colSpan={7}>
                <EmptyState label="No namespaces found" description="Create your first namespace to isolate agent workloads" />
              </td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default function NamespacesPage() {
  return (
    <ApiErrorBoundary>
      <div className="space-y-8 animate-in fade-in slide-in-from-bottom-5 duration-700">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold text-text-primary">Namespaces</h1>
            <p className="text-sm text-text-secondary mt-1">Multi-tenant isolation and quota management</p>
          </div>
        </div>
        <Suspense fallback={<SkeletonTable rows={5} />}>
          <NamespaceList />
        </Suspense>
      </div>
    </ApiErrorBoundary>
  );
}
