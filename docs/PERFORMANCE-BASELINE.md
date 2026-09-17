# E-GAOP Performance Baseline

> Load test results and performance characteristics.

## Test Configuration

| Parameter | Value |
|-----------|-------|
| Tool | k6 v0.52+ |
| Test script | tests/load/load-test.js |
| Environment | Docker Compose (local) |
| Hardware | Developer workstation |
| VUs | 10 / 25 / 50 |
| Duration | 5 minutes per tier |

## Expected Baselines (Target)

| Metric | Target | Acceptable | Critical |
|--------|--------|-----------|----------|
| P50 Latency | < 50ms | < 100ms | > 200ms |
| P95 Latency | < 100ms | < 200ms | > 500ms |
| P99 Latency | < 200ms | < 500ms | > 1000ms |
| Error Rate | < 0.1% | < 1% | > 5% |
| Throughput | > 100 req/s | > 50 req/s | < 20 req/s |
| Saturation | < 70% CPU | < 85% CPU | > 95% CPU |

## Test Scenarios

### 1. Health Check (Baseline)
- **Endpoint**: `GET /healthz`
- **Expected**: P99 < 10ms, 0% errors
- **Purpose**: Establish baseline overhead

### 2. Authentication Flow
- **Endpoints**: `POST /api/auth/register`, `POST /api/auth/login`
- **Expected**: P95 < 200ms, < 1% errors
- **Purpose**: Measure auth latency under load

### 3. Agent CRUD
- **Endpoints**: `GET/POST /api/agents`
- **Expected**: P95 < 150ms, < 0.5% errors
- **Purpose**: Measure database-bound operations

### 4. Concurrent Agent Runs
- **Endpoint**: `POST /api/agents/:id/run`
- **Expected**: P95 < 2000ms (LLM-dependent), < 5% errors
- **Purpose**: Measure LLM integration under load

### 5. Mixed Workload
- **Ratio**: 60% reads, 30% writes, 10% agent runs
- **Expected**: P95 < 500ms, < 2% errors
- **Purpose**: Realistic production simulation

## Resource Consumption

### Per-Service Memory (Expected)

| Service | Min | Typical | Max |
|---------|-----|---------|-----|
| API Server | 128MB | 256MB | 512MB |
| PostgreSQL | 256MB | 512MB | 2GB |
| Redis | 64MB | 128MB | 256MB |
| Grafana | 128MB | 256MB | 512MB |
| Prometheus | 256MB | 512MB | 1GB |

### CPU Utilization (Expected)

| Load Level | API Server | PostgreSQL | Redis |
|-----------|-----------|-----------|-------|
| Idle | 1-5% | 1-3% | < 1% |
| Light (10 VUs) | 10-20% | 5-15% | 2-5% |
| Medium (25 VUs) | 20-40% | 15-30% | 5-10% |
| Heavy (50 VUs) | 40-70% | 30-50% | 10-20% |

## SLO Definitions

| SLO | Target | Measurement |
|-----|--------|------------|
| Availability | 99.9% | Health check success rate |
| Latency (P95) | < 200ms | API response time |
| Error Rate | < 0.1% | 5xx responses / total |
| Throughput | > 50 req/s | Successful requests/second |

## Running the Load Test

```bash
# Quick test (10 VUs, 1 minute)
k6 run tests/load/load-test.js --vus 10 --duration 1m

# Standard test (25 VUs, 5 minutes)
k6 run tests/load/load-test.js --vus 25 --duration 5m

# Stress test (50 VUs, 5 minutes)
k6 run tests/load/load-test.js --vus 50 --duration 5m

# Export results
k6 run tests/load/load-test.js --out json=results.json
```

## Update History

| Date | Author | Changes |
|------|--------|---------|
| $(date +"%Y-%m-%d") | Platform Team | Initial baseline |
