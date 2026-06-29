"use client";

import React, { type ReactNode } from "react";
import { AlertTriangle, WifiOff } from "lucide-react";
import { ApiError } from "@/lib/api/client";

// ── ApiErrorBoundary ──

interface ErrorBoundaryProps {
  children: ReactNode;
  fallback?: (error: ApiError) => ReactNode;
}

interface ErrorBoundaryState {
  error: ApiError | null;
}

export class ApiErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    if (error instanceof ApiError) {
      return { error };
    }
    return { error: new ApiError(error.message, 500, "", "UNKNOWN") };
  }

  render(): ReactNode {
    if (this.state.error) {
      const err = this.state.error;
      if (this.props.fallback) return this.props.fallback(err);
      return (
        <div className="glass-card p-8 text-center space-y-4">
          <AlertTriangle className="w-12 h-12 text-error mx-auto" />
          <h3 className="text-lg font-bold text-text-primary">Something went wrong</h3>
          <p className="text-sm text-text-secondary max-w-md mx-auto">{err.message}</p>
          {err.traceId && (
            <p className="text-xs text-text-muted font-mono">
              Trace ID: <span className="text-brand-primary">{err.traceId}</span>
            </p>
          )}
          <button
            onClick={() => this.setState({ error: null })}
            className="btn-primary text-sm"
          >
            Try Again
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

// ── EmptyState ──

interface EmptyStateProps {
  label: string;
  description?: string;
  action?: ReactNode;
}

export function EmptyState({ label, description, action }: EmptyStateProps): ReactNode {
  return (
    <div className="glass-card p-12 text-center space-y-4">
      <div className="w-16 h-16 rounded-2xl bg-white/5 flex items-center justify-center mx-auto">
        <AlertTriangle className="w-8 h-8 text-text-muted" />
      </div>
      <h3 className="text-lg font-bold text-text-primary">{label}</h3>
      {description && <p className="text-sm text-text-secondary max-w-md mx-auto">{description}</p>}
      {action && <div className="pt-2">{action}</div>}
    </div>
  );
}

// ── OfflineBanner ──

interface OfflineBannerProps {
  isOnline: boolean;
}

export function OfflineBanner({ isOnline }: OfflineBannerProps): ReactNode | null {
  if (isOnline) return null;
  return (
    <div className="fixed bottom-0 left-0 right-0 z-50 bg-error/90 backdrop-blur-sm border-t border-error/30 px-6 py-3 flex items-center gap-3">
      <WifiOff className="w-5 h-5 text-white" />
      <span className="text-sm font-semibold text-white">
        Platform unreachable — some features may be unavailable
      </span>
    </div>
  );
}

// ── Skeleton components ──

export function SkeletonCard(): ReactNode {
  return (
    <div className="glass-card p-6 animate-pulse">
      <div className="h-4 bg-white/5 rounded w-1/3 mb-4" />
      <div className="h-8 bg-white/5 rounded w-1/2 mb-2" />
      <div className="h-3 bg-white/5 rounded w-2/3" />
    </div>
  );
}

export function SkeletonTable({ rows = 5 }: { rows?: number }): ReactNode {
  return (
    <div className="glass-card overflow-hidden">
      <div className="p-4 border-b border-white/5">
        <div className="h-4 bg-white/5 rounded w-1/4 animate-pulse" />
      </div>
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="p-4 border-b border-white/5 flex items-center gap-4 animate-pulse">
          <div className="h-3 bg-white/5 rounded w-1/4" />
          <div className="h-3 bg-white/5 rounded w-1/6" />
          <div className="h-3 bg-white/5 rounded w-1/6" />
          <div className="h-3 bg-white/5 rounded w-1/8" />
        </div>
      ))}
    </div>
  );
}

export function SkeletonDashboard(): ReactNode {
  return (
    <div className="space-y-8">
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
        {Array.from({ length: 4 }).map((_, i) => (
          <SkeletonCard key={i} />
        ))}
      </div>
      <SkeletonTable rows={5} />
    </div>
  );
}
