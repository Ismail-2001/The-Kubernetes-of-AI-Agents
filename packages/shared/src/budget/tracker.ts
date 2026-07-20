import pino from "pino";

const logger = pino({
  level: process.env.NODE_ENV === "test" ? "silent" : (process.env.LOG_LEVEL || "info"),
  ...(process.env.NODE_ENV !== "production" && process.env.NODE_ENV !== "test" ? {
    transport: { target: "pino-pretty", options: { colorize: true } }
  } : {}),
});

interface BudgetAllocation {
  maxTokensPerDay: number;
  maxCostPerDay: number; // USD cents
  maxRequestsPerMinute: number;
}

interface BudgetState {
  tokensUsed: number;
  costUsed: number; // USD cents
  requestCount: number;
  windowStart: number;
  dayStart: number;
}

const DEFAULT_BUDGET: BudgetAllocation = {
  maxTokensPerDay: parseInt(process.env.LLM_BUDGET_TOKENS_PER_DAY || "1_000_000", 10),
  maxCostPerDay: parseInt(process.env.LLM_BUDGET_COST_CENTS_PER_DAY || "5000", 10),
  maxRequestsPerMinute: parseInt(process.env.LLM_BUDGET_RPM || "30", 10),
};

const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;

export function extractNamespace(agentId: string): string {
  const parts = agentId.split("/");
  return parts.length >= 2 ? parts[0]! : "default";
}

export class TokenBudget {
  private allocations = new Map<string, BudgetAllocation>();
  private states = new Map<string, BudgetState>();
  private defaultAllocation: BudgetAllocation;

  constructor(customDefaults?: Partial<BudgetAllocation>) {
    this.defaultAllocation = { ...DEFAULT_BUDGET, ...customDefaults };
  }

  setAllocation(namespace: string, alloc: Partial<BudgetAllocation>): void {
    const existing = this.allocations.get(namespace) ?? this.defaultAllocation;
    this.allocations.set(namespace, { ...existing, ...alloc });
    logger.info({ namespace, ...this.allocations.get(namespace) }, "Budget allocation updated");
  }

  private getState(namespace: string): BudgetState {
    let state = this.states.get(namespace);
    const now = Date.now();
    if (!state) {
      state = { tokensUsed: 0, costUsed: 0, requestCount: 0, windowStart: now, dayStart: now };
      this.states.set(namespace, state);
    }
    // Reset daily counters
    if (now - state.dayStart >= DAY_MS) {
      state.tokensUsed = 0;
      state.costUsed = 0;
      state.dayStart = now;
    }
    // Reset minute counters
    if (now - state.windowStart >= MINUTE_MS) {
      state.requestCount = 0;
      state.windowStart = now;
    }
    return state;
  }

  tryConsume(namespace: string, tokens: number, costCents: number): { allowed: boolean; reason?: string } {
    const allocation = this.allocations.get(namespace) ?? this.defaultAllocation;
    const state = this.getState(namespace);

    if (state.requestCount >= allocation.maxRequestsPerMinute) {
      return { allowed: false, reason: "RPM_EXCEEDED" };
    }
    if (state.tokensUsed + tokens > allocation.maxTokensPerDay) {
      return { allowed: false, reason: "DAILY_TOKEN_BUDGET_EXCEEDED" };
    }
    if (state.costUsed + costCents > allocation.maxCostPerDay) {
      return { allowed: false, reason: "DAILY_COST_BUDGET_EXCEEDED" };
    }

    state.requestCount++;
    state.tokensUsed += tokens;
    state.costUsed += costCents;
    return { allowed: true };
  }

  getUsage(namespace: string): { tokensUsed: number; costUsed: number; requestCount: number } {
    const state = this.getState(namespace);
    return {
      tokensUsed: state.tokensUsed,
      costUsed: state.costUsed,
      requestCount: state.requestCount,
    };
  }

  getAllocations(): Map<string, BudgetAllocation> {
    return new Map(this.allocations);
  }

  reset(namespace: string): void {
    this.states.delete(namespace);
    logger.info({ namespace }, "Budget state reset");
  }

  resetAll(): void {
    this.states.clear();
    logger.info("All budget states reset");
  }

  isExhausted(namespace: string): boolean {
    const allocation = this.allocations.get(namespace) ?? this.defaultAllocation;
    const state = this.getState(namespace);
    return (
      state.tokensUsed >= allocation.maxTokensPerDay ||
      state.costUsed >= allocation.maxCostPerDay
    );
  }
}
