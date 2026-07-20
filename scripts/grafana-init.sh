#!/bin/sh
# Grafana alerting init — idempotent setup of alert rules, contact points,
# and notification policies via the Grafana HTTP API.
#
# Usage: GRAFANA_PASSWORD="..." SLACK_ALERT_WEBHOOK="https://..." ./grafana-init.sh

set -eu

: "${GRAFANA_URL:=http://localhost:3000}"
: "${GRAFANA_USER:=admin}"
: "${GRAFANA_PASSWORD:?Set GRAFANA_PASSWORD}"

AUTH="${GRAFANA_USER}:${GRAFANA_PASSWORD}"
API="${GRAFANA_URL}/api/v1/provisioning"

wait_for_grafana() {
  echo "Waiting for Grafana to be ready..."
  for i in $(seq 1 30); do
    if curl -sf "${GRAFANA_URL}/api/health" >/dev/null 2>&1; then
      echo "Grafana is ready"
      return 0
    fi
    sleep 2
  done
  echo "ERROR: Grafana did not become ready within 60s"
  exit 1
}

_curl() {
  curl -sS -u "$AUTH" -H "Content-Type: application/json" "$@"
}

_curl_check() {
  _curl -w "\n%{http_code}" "$@" | tail -1
}

_escape_json() {
  echo "$1" | sed 's/\\/\\\\/g; s/"/\\"/g; s/\t/\\t/g; s/\r//g; s/\n/\\n/g'
}

ensure_slack_contact_point() {
  CONTACT_NAME="K8s AI Agents Slack"
  if [ -z "${SLACK_ALERT_WEBHOOK:-}" ]; then
    echo "Contact point: ${CONTACT_NAME} — SKIPPED (SLACK_ALERT_WEBHOOK not set)"
    return
  fi
  echo "Contact point: ${CONTACT_NAME}"
  PAYLOAD=$(cat <<ENDJSON
{"name":"${CONTACT_NAME}","type":"slack","settings":{"url":"${SLACK_ALERT_WEBHOOK}","text":"{{ range .Alerts }}\n*{{ .Labels.severity }}:* {{ .Annotations.summary }}\n{{ .Annotations.description }}\n{{ end }}"},"disableResolveMessage":false}
ENDJSON
)
  if _curl -X GET "${API}/contact-points/${CONTACT_NAME}" >/dev/null 2>&1; then
    _curl -X PUT "${API}/contact-points/${CONTACT_NAME}" -d "$PAYLOAD" >/dev/null && echo "  ✓ updated"
  else
    _curl -X POST "${API}/contact-points" -d "$PAYLOAD" >/dev/null && echo "  ✓ created"
  fi
}

ensure_notification_policy() {
  if [ -n "${SLACK_ALERT_WEBHOOK:-}" ]; then
    RECEIVER="K8s AI Agents Slack"
  else
    RECEIVER="K8s AI Agents Log"
    echo "Contact point: ${RECEIVER} (no-op webhook sink)"
    SINK_PAYLOAD='{"name":"K8s AI Agents Log","type":"webhook","settings":{"url":"http://localhost:3000/api/health","sendReminder":false,"autoResolve":true},"disableResolveMessage":true}'
    if _curl -X GET "${API}/contact-points/${RECEIVER}" >/dev/null 2>&1; then
      _curl -X PUT "${API}/contact-points/${RECEIVER}" -d "$SINK_PAYLOAD" >/dev/null
    else
      _curl -X POST "${API}/contact-points" -d "$SINK_PAYLOAD" >/dev/null
    fi
    echo "  ✓ created"
  fi
  echo "Notification policy → receiver: ${RECEIVER}"
  POLICY_PAYLOAD=$(cat <<ENDJSON
{"receiver":"${RECEIVER}","group_by":["severity","alertname"],"group_wait":"30s","group_interval":"5m","repeat_interval":"4h","routes":[]}
ENDJSON
)
  _curl -X PUT "${API}/policies" -d "$POLICY_PAYLOAD" >/dev/null && echo "  ✓ set"
}

ensure_rules() {
  echo "Ensuring alert rules..."

  _upsert_rule \
    "k8s_ai_service_down" \
    "K8s AI Agents Service Down" \
    "critical" \
    "5m" \
    "One or more core services are unreachable" \
    "Service is down" \
    'min(up{job="egaop-services"}) == 0' \
    "30s"

  _upsert_rule \
    "k8s_ai_high_error_rate" \
    "High Error Rate (>5% 5xx)" \
    "critical" \
    "Error rate exceeds 5% over 5 minutes" \
    "High 5xx rate detected" \
    '(sum(rate(http_server_duration_count{status_code=~"5..",job="egaop-services"}[5m])) or vector(0)) / (sum(rate(http_server_duration_count{job="egaop-services"}[5m])) or vector(1)) > 0.05' \
    "5m"

  _upsert_rule \
    "k8s_ai_high_latency_p95" \
    "High Latency P95 (>3s)" \
    "warning" \
    "P95 latency exceeds 3s over 5 minutes" \
    "High P95 latency" \
    'histogram_quantile(0.95, sum(rate(http_server_duration_bucket{job="egaop-services"}[5m])) by (le)) > 3000' \
    "5m"

  _upsert_rule \
    "k8s_ai_high_latency_p99" \
    "Critical Latency P99 (>10s)" \
    "critical" \
    "P99 latency exceeds 10s over 5 minutes" \
    "Critical P99 latency" \
    'histogram_quantile(0.99, sum(rate(http_server_duration_bucket{job="egaop-services"}[5m])) by (le)) > 10000' \
    "5m"

  _upsert_rule \
    "k8s_ai_collector_dropping" \
    "Metrics Pipeline Dropping" \
    "warning" \
    "OTel collector is dropping metric points" \
    "Collector dropping metrics" \
    'rate(otelcol_exporter_send_failed_metric_points{exporter="prometheus"}[5m]) > 100' \
    "5m"
}

_upsert_rule() {
  RULE_UID="$1"
  TITLE="$2"
  SEVERITY="$3"
  SUMMARY="$4"
  DESCRIPTION="$5"
  EXPR="$6"
  FOR="$7"

  EXPR_ESC=$(_escape_json "$EXPR")
  SUMMARY_ESC=$(_escape_json "$SUMMARY")
  DESC_ESC=$(_escape_json "$DESCRIPTION")

  printf "  %s... " "$TITLE"

  PAYLOAD=$(cat <<ENDJSON
{"uid":"${RULE_UID}","title":"${TITLE}","ruleGroup":"k8s-ai-critical","folderUID":"__default__","noDataState":"Alerting","execErrState":"Alerting","for":"${FOR}","annotations":{"summary":"${SUMMARY_ESC}","description":"${DESC_ESC}"},"labels":{"severity":"${SEVERITY}","team":"k8s-ai","rule_type":"grafana_alert"},"data":[{"refId":"A","queryType":"","relativeTimeRange":{"from":0,"to":600},"datasourceUid":"prometheus","model":{"expr":"${EXPR_ESC}","intervalMs":10000,"maxDataPoints":100,"refId":"A"}}],"condition":"A"}
ENDJSON
)

  HTTP_CODE=$(echo "$PAYLOAD" | _curl -X POST "${API}/alert-rules" -d @- -w "\n%{http_code}" 2>&1 | tail -1)
  if [ "$HTTP_CODE" = "200" ] || [ "$HTTP_CODE" = "201" ]; then
    echo "created"
  elif [ "$HTTP_CODE" = "409" ]; then
    HTTP_CODE=$(echo "$PAYLOAD" | _curl -X PUT "${API}/alert-rules/${RULE_UID}" -d @- -w "\n%{http_code}" 2>&1 | tail -1)
    if [ "$HTTP_CODE" = "200" ]; then
      echo "updated"
    else
      echo "FAILED (HTTP $HTTP_CODE on update)"
    fi
  else
    echo "FAILED (HTTP $HTTP_CODE)"
  fi
}

wait_for_grafana
ensure_slack_contact_point
ensure_notification_policy
ensure_rules

echo ""
echo "Grafana alerting init complete"
