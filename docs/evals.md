# E-GAOP Evals

**Category score in readiness assessment: 92% (11/12).**
Full assessment: [`production-readiness-final.md`](production-readiness-final.md).

---

## Framework

The eval suite lives in `evals/` and consists of:

| Component | File | Purpose |
|-----------|------|---------|
| Golden dataset | `evals/golden-dataset.json` | 19 cases across 7 categories with expected tool calls and answer patterns |
| Runner | `evals/run-evals.mjs` (327 lines) | Logs into API, triggers each case via real workflow execution, polls Temporal, scores results |
| Comparison | `evals/compare-evals.mjs` | Side-by-side regression analysis between two runs |
| Baselines | `evals/baselines/RL-*.json` | Timestamped result snapshots |

### Golden Dataset (19 cases)

| Category | Count | Examples |
|----------|-------|----------|
| Q&A | 6 | Simple math, capital city, greetings — expect no tool call |
| code_interpreter | 6 | Python computation, Fibonacci, prime check, CSV average, random number — expect code_interpreter tool |
| file_io | 2 | Write greeting, write number list — expect file_write/file_read |
| database_query | 1 | CREATE TABLE + INSERT — expect database_query |
| tool_selection | 2 | Math vs search, data vs text — tests correct tool choice |
| edge_case | 1 | Empty prompt — should respond without error |
| policy_deny | 1 | Cross-namespace — expect OPA deny |

### Scoring Methods

Three scoring methods applied per case:

- **exact_pattern**: Substring or OR-pipe matching (e.g., "capital of France" | "France's capital")
- **numeric_tolerance**: Epsilon comparison for numeric answers
- **rule_based**: Heuristic judge for edge cases (empty prompt, policy deny)

Tool selection accuracy is computed separately from answer correctness.

---

## Results

### RL-1 (Baseline, Jul 17)

**13/19 passed (68.4% task success, ~94.7% tool selection accuracy)**

| Case | Result | Root Cause |
|------|--------|------------|
| qanda-simple-math | FAIL | Called code_interpreter for 2+2 → stuck in 10-iteration MAX_ITERATIONS loop |
| code_interpreter-sum-1-to-100 | FAIL | Repeated same `sum(range(1,101))` call 10 times → MAX_ITERATIONS |
| code_interpreter-prime-check | FAIL | Answer didn't match expected pattern (output truncated) |
| code_interpreter-csv-average | FAIL | Same as sum-1-to-100 — repeated same call 10 times |
| file_write-read-greeting | FAIL | `LLM call failed: Activity task failed` |
| database_query-create-table | FAIL | Args didn't match pattern + `LLM call failed` |

### RL-2 (Jul 18)

**16/19 passed (84.2% task success, ~100% tool selection accuracy)**

**3 FLIPs (False → True):**
- `qanda-simple-math`: Now answers directly without calling code_interpreter
- `code_interpreter-sum-1-to-100`: Completes in single call (not 10 loops)
- `code_interpreter-csv-average`: Writes CSV file then computes average in 2 calls

**Still failing (3):**
- `code_interpreter-prime-check`: "Execution stopped after 20 iterations" — model re-invokes same prime-check code without varying approach
- `file_write-read-greeting`: `LLM call failed: Activity task failed` — probable infra contamination
- `database_query-create-table`: Same infra contamination + args mismatch

### RL-3 and RL-4 (Jul 18)

| Run | Pass | Notes |
|-----|------|-------|
| RL-3 | 15/19 (78.9%) | Regression from RL-2 — one case flipped back |
| RL-4 | 16/19 (84.2%) | Matches RL-2 |

---

## Caveats

### Infra Contamination

Cases 15-19 in sequential eval runs show increasing `LLM call failed: Activity task failed` errors. This matches the pattern where OpenRouter rate-limits after ~15 sequential calls (`RATE_LIMIT_LLM_RPM=30` / "All models in fallback chain exhausted"). **~2 of the 3 remaining failures may be infrastructure saturation, not agent defects.** The true agent quality pass rate excluding infra failures may be ~94% (16/17) rather than 84.2% (16/19).

### Metric Bug

`tool_selection_accuracy` exceeds 1.0 in every baseline:
- RL-1: 1.636
- RL-2: 1.727
- RL-3: 1.727
- RL-4: 1.727

This is invalid for a ratio metric. Root cause: the scoring code likely credits multiple correct tool selections per case rather than normalizing by case count. This metric should not be reported as accurate until the denominator is fixed.

### Known Agent Defects (not infra)

The `code_interpreter-prime-check` case is a genuine agent quality issue: the model repeatedly re-invokes the same prime-check code (up to 20 iterations in RL-2) without varying its approach. This suggests the system prompt's "do not re-call the same tool with the same arguments" instruction is not being followed reliably for this case.

---

## Running Evals

```bash
# From repo root, with stack running
node evals/run-evals.mjs

# Compare two runs
node evals/compare-evals.mjs evals/baselines/RL-1.json evals/baselines/RL-2.json
```

> Full results and methodology: [`production-readiness-final.md`](production-readiness-final.md) (Eval regression section).
