"use client";

import {
  useQuery,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import { apiRequest } from "./client";
import type {
  Agent,
  AgentListFilters,
  Namespace,
  Trace,
  TraceListFilters,
  DashboardMetrics,
  Execution,
  RunAgentResponse,
  PaginatedData,
  ApiResponse,
} from "@/lib/types";

function qk(...parts: unknown[]): unknown[] {
  return parts.filter((p) => p !== undefined && p !== null);
}

// ── Queries ──

export function useAgents(filters: AgentListFilters = {}) {
  const params = new URLSearchParams();
  if (filters.namespace) params.set("namespace", filters.namespace);
  if (filters.status) params.set("status", filters.status);
  if (filters.search) params.set("search", filters.search);
  if (filters.page) params.set("page", String(filters.page));
  if (filters.limit) params.set("limit", String(filters.limit));
  const qs = params.toString();
  const endpoint = `/api/agents${qs ? `?${qs}` : ""}`;

  return useQuery<ApiResponse<PaginatedData<Agent>>>({
    queryKey: qk("agents", filters.namespace, filters.status, filters.search, filters.page, filters.limit),
    queryFn: () => apiRequest<PaginatedData<Agent>>(endpoint),
    staleTime: 30_000,
    gcTime: 5 * 60_000,
    retry: false,
  });
}

export function useAgent(agentId: string | null) {
  return useQuery<ApiResponse<Agent>>({
    queryKey: qk("agent", agentId),
    queryFn: () => apiRequest<Agent>(`/api/agents/${agentId}`),
    staleTime: 30_000,
    gcTime: 5 * 60_000,
    retry: false,
    enabled: !!agentId,
  });
}

export function useNamespaces() {
  return useQuery<ApiResponse<Namespace[]>>({
    queryKey: ["namespaces"],
    queryFn: () => apiRequest<Namespace[]>("/api/namespaces"),
    staleTime: 30_000,
    gcTime: 5 * 60_000,
    retry: false,
  });
}

export function useTraces(filters: TraceListFilters = {}) {
  const params = new URLSearchParams();
  if (filters.namespace) params.set("namespace", filters.namespace);
  if (filters.from) params.set("from", filters.from);
  if (filters.to) params.set("to", filters.to);
  if (filters.page) params.set("page", String(filters.page));
  if (filters.limit) params.set("limit", String(filters.limit));
  const qs = params.toString();
  const endpoint = `/api/traces${qs ? `?${qs}` : ""}`;

  return useQuery<ApiResponse<PaginatedData<Execution>>>({
    queryKey: qk("traces", filters.namespace, filters.from, filters.to, filters.page, filters.limit),
    queryFn: () => apiRequest<PaginatedData<Execution>>(endpoint),
    staleTime: 30_000,
    gcTime: 5 * 60_000,
    retry: false,
  });
}

export function useTrace(traceId: string | null) {
  return useQuery<ApiResponse<Trace>>({
    queryKey: qk("trace", traceId),
    queryFn: () => apiRequest<Trace>(`/api/traces/${traceId}`),
    staleTime: 30_000,
    gcTime: 5 * 60_000,
    retry: false,
    enabled: !!traceId,
  });
}

export function useMetrics(namespace?: string, window?: string) {
  const params = new URLSearchParams();
  if (namespace) params.set("namespace", namespace);
  if (window) params.set("window", window);
  const qs = params.toString();

  return useQuery<ApiResponse<DashboardMetrics>>({
    queryKey: qk("metrics", namespace, window),
    queryFn: () => apiRequest<DashboardMetrics>(`/api/metrics${qs ? `?${qs}` : ""}`),
    staleTime: 30_000,
    gcTime: 5 * 60_000,
    retry: false,
  });
}

export function useHealth() {
  return useQuery<ApiResponse<{ status: string }>>({
    queryKey: ["health"],
    queryFn: () => apiRequest<{ status: string }>("/health"),
    staleTime: 10_000,
    gcTime: 30_000,
    retry: false,
    refetchInterval: 30_000,
  });
}

// ── Mutations ──

export function useCreateAgent() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: { name: string; namespace: string; spec: Record<string, unknown> }) =>
      apiRequest<Agent>("/api/agents", {
        method: "POST",
        body: JSON.stringify(data),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["agents"] });
      qc.invalidateQueries({ queryKey: ["metrics"] });
    },
  });
}

export function useDeleteAgent() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (agentId: string) =>
      apiRequest<void>(`/api/agents/${agentId}`, { method: "DELETE" }),
    onMutate: async (agentId) => {
      await qc.cancelQueries({ queryKey: ["agents"] });
      const previous = qc.getQueriesData({ queryKey: ["agents"] });
      qc.setQueriesData(
        { queryKey: ["agents"] },
        (old: ApiResponse<PaginatedData<Agent>> | undefined) => {
          if (!old) return old;
          return {
            ...old,
            data: {
              ...old.data,
              items: old.data.items.filter((a) => a.id !== agentId),
              total: old.data.total - 1,
            },
          };
        }
      );
      return { previous };
    },
    onError: (_err, _vars, context) => {
      if (context?.previous) {
        for (const [key, data] of context.previous) {
          qc.setQueryData(key, data);
        }
      }
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ["agents"] });
      qc.invalidateQueries({ queryKey: ["metrics"] });
    },
  });
}

export function useCancelExecution() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (executionId: string) =>
      apiRequest<void>(`/api/executions/${executionId}/cancel`, { method: "POST" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["traces"] });
    },
  });
}

// ── Agent Detail Queries ──

export function useAgentExecutions(agentId: string | null, page: number = 1, limit: number = 10) {
  return useQuery<ApiResponse<PaginatedData<Execution>>>({
    queryKey: qk("agentExecutions", agentId, page, limit),
    queryFn: () =>
      apiRequest<PaginatedData<Execution>>(`/api/agents/${agentId}/executions?page=${page}&limit=${limit}`),
    staleTime: 30_000,
    gcTime: 5 * 60_000,
    retry: false,
    enabled: !!agentId,
  });
}

export function useRunAgent() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ agentId, input }: { agentId: string; input?: Record<string, unknown> }) =>
      apiRequest<RunAgentResponse>(`/api/agents/${agentId}/run`, {
        method: "POST",
        body: JSON.stringify({ input }),
      }),
    onSuccess: (_data, variables) => {
      qc.invalidateQueries({ queryKey: ["agentExecutions", variables.agentId] });
      qc.invalidateQueries({ queryKey: ["agent", variables.agentId] });
      qc.invalidateQueries({ queryKey: ["traces"] });
    },
  });
}
