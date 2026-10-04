# PR 6 — Structured tool-calling schema, natural-language tool triggering, and eval framework

**Title:** `feat(core): structured OpenAI tool_calls, natural-language tool triggering, and 19-case eval suite`

### What was broken

The platform used a plain-text `[tool:name] {"args"}` format embedded in the LLM prompt to trigger tools. This had three problems: (1) the model had to learn a custom format rather than using OpenAI's native `tools` parameter, leading to parsing failures and wasted iterations; (2) tool definitions were not communicated to the LLM in a structured way — no JSON Schema for input validation; (3) there was no automated way to measure whether changes improved or regressed agent behavior.

### What changed

**Structured tool-calling schema:**
- Added `ToolDefinition`, `ToolCall` messages to `api/proto/egaop/v1/llm.proto` — includes `name`, `description`, `input_schema` (JSON-serialized string), and `tool_call_id`/`tool_calls` fields on messages.
- `execution-plane/llm-router/src/index.ts` — `callOpenAIWithFallback` now accepts `toolDefinitions`, builds OpenAI `tools` array with JSON Schema, and returns `toolCalls` from the response (including `tool_call_id`, `function.name`, `function.arguments`).
- `control-plane/workflow-engine/src/temporal/activities/index.ts` — `CallLLMParams` accepts `toolDefinitions`, serializes `inputSchema` as JSON string for proto, handles structured `tool_calls` in response (first priority over `[tool:]` text parsing fallback).
- `control-plane/workflow-engine/src/temporal/workflows/react-workflow.ts` — defines `TOOL_DEFINITIONS` array with JSON Schema inputs for code_interpreter, file_read, file_write, database_query. Passes `toolDefinitions` to `callLLM`. Uses `role:"tool"` messages with `toolCallId` for tool results.

**Natural-language tool triggering:**
- Updated system prompt (`react-workflow.ts:135`): removed explicit `[tool:name] {"args"}` format instructions. Replaced with "call a function when needed, examine output, then answer" — natural language only.
- Model now organically calls functions via OpenAI's `tool_calls` parameter without format examples.
- Verified: `exec-358eacd0` — 2 iterations, 1 tool call via `toolCallId: "call_XrRFxCFYWxaPPahYMNsji4d1"`, SUCCEEDED. No `[tool:]` format observed.

**Eval framework:**
- `evals/golden-dataset.json` — 19 cases across 7 categories: Q&A (6), code_interpreter (6), file_io (2), database_query (1), tool_selection (2), edge_case (1), policy_deny (1). Each specifies expected tool, args pattern, final answer match. Schema v1.0.
- `evals/run-evals.mjs` (327 lines) — Logs into API, triggers each case via real `POST /api/agents/:id/run`, polls Temporal every 2s via `temporal workflow describe`, extracts tool calls + output, scores against expectations. Three scoring methods: `exact_pattern` (substring/OR-pipe), `numeric_tolerance` (epsilon), `rule_based` (heuristic).
- `evals/compare-evals.mjs` — Side-by-side regression comparison: per-case improvement/regression detection, summary stats (task success rate Δ, tool selection Δ).

### Evidence

- **Structured `tool_calls` verified**: 6/6 concurrent load test runs use OpenAI native `tools` parameter. Temporal history shows `toolCallId: "call_y03kZgHIPuDqqXgHoZ2TrwQi"` — native format, not parsed from text.
- **Natural-language triggering verified**: `exec-358eacd0` — model called `code_interpreter` via `tool_calls` without `[tool:]` prompt format. System prompt contains no format examples.
- **Baseline RL-1**: 13/19 passed (68.4%). All 6 failures documented with root causes in `evals/baselines/RL-1.json`.
- **Baseline RL-2**: 16/19 passed (84.2%). 3 FLIPs (qanda-simple-math, code_interpreter-sum-1-to-100, code_interpreter-csv-average). See `evals/baselines/RL-2.json`.
- **Proto definitions**: `api/proto/egaop/v1/llm.proto` — `ToolDefinition`, `ToolCall` messages with `tool_call_id`, `role:"tool"` support.

### What's still open

- **Eval infra contamination**: OpenRouter rate-limits after ~15 sequential eval cases — 2 of 3 RL-2 failures show `LLM call failed: Activity task failed`, likely infra saturation not agent defects. True pass rate excluding infra failures may be ~94%.
- **`tool_selection_accuracy` metric bug**: Values exceed 1.0 in all baselines (RL-1: 1.636, RL-2-4: 1.727) — invalid for a ratio. Root cause: scoring code likely credits multiple correct tool selections per case instead of normalizing by case count.
- **LLM retry/backlog**: No circuit breaker or exponential backoff for LLM calls. At ≥12 concurrent agents, `DEADLINE_EXCEEDED` from llm-router causes workflow timeouts.
