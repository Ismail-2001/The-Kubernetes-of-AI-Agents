import { getMeter } from "./index.js";

let _meter: ReturnType<typeof getMeter> | null = null;

function getCostMeter() {
  if (!_meter) _meter = getMeter("egaop-llm-cost");
  return _meter;
}

export const llmCostCounter = {
  add(value: number, attrs?: Record<string, string | number>) {
    getCostMeter().createCounter("egaop_llm_cost_usd", {
      description: "Total LLM cost in USD",
      unit: "USD",
    }).add(value, attrs);
  },
};

export const llmTokensByModel = {
  add(value: number, attrs?: Record<string, string | number>) {
    getCostMeter().createCounter("egaop_llm_tokens_by_model_total", {
      description: "LLM tokens consumed by model",
      unit: "{tokens}",
    }).add(value, attrs);
  },
};

export const llmCostByModel = {
  add(value: number, attrs?: Record<string, string | number>) {
    getCostMeter().createCounter("egaop_llm_cost_by_model_usd", {
      description: "LLM cost by model in USD",
      unit: "USD",
    }).add(value, attrs);
  },
};

export const llmCostByNamespace = {
  add(value: number, attrs?: Record<string, string | number>) {
    getCostMeter().createCounter("egaop_llm_cost_by_namespace_usd", {
      description: "LLM cost by namespace in USD",
      unit: "USD",
    }).add(value, attrs);
  },
};

export const llmCostByAgent = {
  add(value: number, attrs?: Record<string, string | number>) {
    getCostMeter().createCounter("egaop_llm_cost_by_agent_usd", {
      description: "LLM cost by agent in USD",
      unit: "USD",
    }).add(value, attrs);
  },
};

export function recordLLMCost(params: {
  model: string;
  namespace: string;
  agentId: string;
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
}) {
  const labels = { model: params.model, namespace: params.namespace, agent_id: params.agentId };
  llmCostCounter.add(params.costUsd, labels);
  llmCostByModel.add(params.costUsd, { model: params.model });
  llmCostByNamespace.add(params.costUsd, { namespace: params.namespace });
  llmCostByAgent.add(params.costUsd, { agent_id: params.agentId });
  llmTokensByModel.add(params.promptTokens + params.completionTokens, { model: params.model });
}
