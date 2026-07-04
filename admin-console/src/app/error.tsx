"use client";

import { AlertTriangle, RefreshCw } from "lucide-react";

export default function Error({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="flex items-center justify-center min-h-[60vh]">
      <div className="glass-card p-12 text-center space-y-6 max-w-md">
        <div className="w-16 h-16 rounded-2xl bg-error/10 flex items-center justify-center mx-auto">
          <AlertTriangle className="w-8 h-8 text-error" />
        </div>
        <div>
          <h2 className="text-xl font-bold text-text-primary">Something went wrong</h2>
          <p className="text-sm text-text-secondary mt-2">{error.message}</p>
          {error.digest && (
            <p className="text-xs text-text-muted font-mono mt-2">Error: {error.digest}</p>
          )}
        </div>
        <button onClick={reset} className="btn-primary text-sm flex items-center gap-2 mx-auto">
          <RefreshCw className="w-4 h-4" />
          Try Again
        </button>
      </div>
    </div>
  );
}
