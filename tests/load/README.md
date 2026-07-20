# Load Tests (k6)

## Prerequisites

Install k6: https://k6.io/docs/getting-started/installation/

```bash
# Windows (Chocolatey)
choco install k6

# macOS
brew install k6

# Linux
apt install k6  # or download from releases
```

## Usage

### Smoke test (1 VU, verify everything works)

```bash
k6 run tests/load/k6-script.js --scenario smoke -e BASE_URL=http://localhost:3001
```

### Load test (ramp to 50 VUs, sustain, ramp down)

```bash
k6 run tests/load/k6-script.js --scenario load -e BASE_URL=http://localhost:3001
```

### Stress test (find breaking point — ramp to 200 VUs)

```bash
k6 run tests/load/k6-script.js --scenario stress -e BASE_URL=http://localhost:3001
```

### Soak test (30 VUs for 60 min, detect degradation)

```bash
k6 run tests/load/k6-script.js --scenario soak -e BASE_URL=http://localhost:3001
```

### Run from CI

```yaml
- name: Run k6 load test
  run: k6 run tests/load/k6-script.js --scenario load -e BASE_URL=${{ env.BASE_URL }}
```

## Target SLOs

| Metric | SLO |
|--------|-----|
| Health check p95 | < 100ms |
| Auth endpoints p95 | < 500ms |
| Agent CRUD p95 | < 1000ms |
| Execution trigger p95 | < 3000ms |
| Error rate | < 1% |
| Any endpoint p99 | < 2000ms |
| Any endpoint max | < 5000ms |

## Scenarios

| Scenario | VUs | Duration | Purpose |
|----------|-----|----------|---------|
| `smoke` | 1 | ~10s | Quick sanity check after deploy |
| `load` | 20→50→0 | 9min | Baseline SLO verification |
| `stress` | 20→200→0 | 11min | Find breaking point |
| `soak` | 30 | 70min | Detect long-term degradation |
