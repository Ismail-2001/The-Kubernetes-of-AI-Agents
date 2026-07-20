# Metrics Pipeline Dropping

| Field | Value |
|-------|-------|
| **Alert rule** | `k8s_ai_collector_dropping` |
| **Severity** | `warning` |
| **Condition** | `rate(otelcol_exporter_send_failed_metric_points{exporter="prometheus"}[5m]) > 100` |
| **Response time** | 1 hour |

## Symptoms

- Slack: "Metrics Pipeline Dropping"
- Grafana dashboards show gaps or stale data
- Prometheus queries return partial results
- Tempo traces may also be affected

## Automated actions

- Alert fires after **5 minutes** of sustained metric drops
- No auto-remediation
- OpenTelemetry collector may be buffering data internally

## Diagnosis

### 1. Check OTel collector health

```bash
# Collector health endpoint
curl -s http://localhost:13133 | jq .

# Check collector logs
docker compose logs otel-collector --tail=50
```

### 2. Check collector pipeline metrics

```bash
# Metrics received vs exported
curl -s 'http://localhost:9091/api/v1/query?query=rate(otelcol_receiver_accepted_spans[5m])' | jq .
curl -s 'http://localhost:9091/api/v1/query?query=rate(otelcol_exporter_sent_spans[5m])' | jq .

# Dropped metrics
curl -s 'http://localhost:9091/api/v1/query?query=rate(otelcol_exporter_send_failed_metric_points[5m])' | jq .
```

### 3. Check Prometheus targets

```bash
# Prometheus targets page (web UI)
# Open http://localhost:9091/targets in browser
# or use API:
curl -s 'http://localhost:9091/api/v1/targets' | jq '.data.activeTargets[] | {job: .labels.job, health: .health}'
```

### 4. Check if Prometheus is overloaded

```bash
# Prometheus memory usage
curl -s 'http://localhost:9091/api/v1/query?query=process_resident_memory_bytes{job="prometheus"}' | jq .

# Active queries
curl -s 'http://localhost:9091/api/v1/query?query=prometheus_engine_queries' | jq .
```

## Remediation

### OTel collector overloaded

```bash
# 1. Increase batch processor limits in otel-collector-config.yaml
#    batch:
#      timeout: 5s     (instead of 2s)
#      send_batch_size: 10000  (instead of 8192)

# 2. Add queued retry with more capacity
#    queued_retry:
#      num_workers: 8
#      queue_size: 5000

# 3. Restart collector
docker compose up -d otel-collector
```

### Prometheus scraping too frequently

```bash
# 1. Increase scrape interval in prometheus.yml
#    scrape_interval: 30s  (instead of 15s)

# 2. Reload Prometheus config
curl -X POST http://localhost:9091/-/reload

# 3. Or restart
docker compose up -d prometheus
```

### OTel collector misconfigured

```bash
# 1. Validate config syntax
docker compose exec otel-collector otelcol --config=/etc/otelcol-contrib/config.yaml --verify-only

# 2. Check exporter endpoint is reachable
#    Prometheus exporter should be on localhost:8889
curl -s http://localhost:8889/metrics | head -20
```

### Resource exhaustion on collector

```bash
# Increase memory limit
# Edit docker-compose.yml for otel-collector:
#   memory: 512M  (up from default)
docker compose up -d otel-collector
```

## Verification

```bash
# Dropped metric points should be near zero
curl -s 'http://localhost:9091/api/v1/query?query=rate(otelcol_exporter_send_failed_metric_points{exporter="prometheus"}[5m])' | jq '.data.result[0].value[1]'
# → should be < 100 (ideally near 0)

# Prometheus targets should all be UP
curl -s 'http://localhost:9091/api/v1/targets' | jq '[.data.activeTargets[].health] | unique'
# → ["up"]

# Grafana dashboards should show current data
# Alert auto-resolves after 5 minutes below threshold
```

## Escalation

| Criteria | Contact |
|----------|---------|
| Collector needs config change | DevOps / platform team |
| Collector resource exhaustion | Infrastructure team |
| Prometheus data loss | Engineering lead |
| Metrics gap > 30 minutes | Engineering lead + alerting team |

## Post-mortem data

```bash
# Export OTel collector metrics before fixing
curl -s http://localhost:8889/metrics > /tmp/collector-metrics-$(date +%Y%m%d-%H%M%S).txt

# Prometheus target state
curl -s 'http://localhost:9091/api/v1/targets' > /tmp/prom-targets-$(date +%Y%m%d-%H%M%S).json
```
