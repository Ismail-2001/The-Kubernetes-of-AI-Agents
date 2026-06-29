"use client";

import { useEffect, useRef, useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { SSEEvent } from "@/lib/types";

const MAX_RECONNECT_DELAY = 30_000;
const INITIAL_RECONNECT_DELAY = 1_000;

export function useSSE(namespace?: string): void {
  const qc = useQueryClient();
  const retryDelay = useRef(INITIAL_RECONNECT_DELAY);
  const eventSourceRef = useRef<EventSource | null>(null);

  const handleEvent = useCallback(
    (event: MessageEvent) => {
      try {
        const parsed = JSON.parse(event.data) as SSEEvent;
        switch (parsed.type) {
          case "agent.status_changed": {
            const agentId = parsed.data.agentId as string;
            qc.invalidateQueries({ queryKey: ["agent", agentId] });
            qc.invalidateQueries({ queryKey: ["agents"] });
            break;
          }
          case "execution.completed": {
            qc.invalidateQueries({ queryKey: ["traces"] });
            qc.invalidateQueries({ queryKey: ["metrics"] });
            break;
          }
          case "execution.started": {
            qc.invalidateQueries({ queryKey: ["traces"] });
            break;
          }
        }
        retryDelay.current = INITIAL_RECONNECT_DELAY;
      } catch {
        // ignore malformed events
      }
    },
    [qc]
  );

  useEffect(() => {
    const params = new URLSearchParams();
    if (namespace) params.set("namespace", namespace);
    const qs = params.toString();
    const url = `/api/events${qs ? `?${qs}` : ""}`;

    let cancelled = false;
    let es: EventSource | null = null;

    function connect(): void {
      if (cancelled) return;
      es = new EventSource(url);
      eventSourceRef.current = es;
      es.onmessage = handleEvent;
      es.onerror = () => {
        es?.close();
        eventSourceRef.current = null;
        if (!cancelled) {
          setTimeout(() => {
            retryDelay.current = Math.min(retryDelay.current * 2, MAX_RECONNECT_DELAY);
            connect();
          }, retryDelay.current);
        }
      };
    }

    connect();

    return () => {
      cancelled = true;
      es?.close();
      eventSourceRef.current = null;
    };
  }, [namespace, handleEvent]);
}
