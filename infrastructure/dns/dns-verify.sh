#!/usr/bin/env bash
# Verify DNS failover configuration
# Usage: ./scripts/dns-verify.sh [domain]

set -euo pipefail

DOMAIN="${1:-api.egaop.io}"
EXPECTED_PRIMARY="api-primary.egaop.io"
EXPECTED_SECONDARY="api-secondary.egaop.io"

echo "Verifying DNS for ${DOMAIN}..."

# Check DNS resolution
echo "Resolving ${DOMAIN}..."
RESOLVED=$(dig +short "${DOMAIN}" A 2>/dev/null || nslookup "${DOMAIN}" 2>/dev/null | grep "Address:" | tail -1 | awk '{print $2}')

if [ -z "$RESOLVED" ]; then
  echo "❌ FAIL: Cannot resolve ${DOMAIN}"
  exit 1
fi
echo "✅ Resolved to: ${RESOLVED}"

# Check if resolved to expected primary or secondary
if [ "$RESOLVED" = "$EXPECTED_PRIMARY" ] || [ "$RESOLVED" = "$EXPECTED_SECONDARY" ]; then
  echo "✅ Resolves to expected origin"
else
  echo "⚠️  WARNING: Resolves to unexpected address: $RESOLVED"
fi

# Check health endpoints
echo ""
echo "Checking health endpoints..."

check_health() {
  local url="$1"
  local name="$2"
  if curl -sf --max-time 5 "$url" > /dev/null 2>&1; then
    echo "✅ $name: healthy ($url)"
  else
    echo "❌ $name: unhealthy ($url)"
  fi
}

check_health "https://${DOMAIN}/healthz" "Primary DNS"
check_health "http://api-primary.egaop.io:15051/healthz" "Primary direct"
check_health "http://api-secondary.egaop.io:15051/healthz" "Secondary direct"

# Check TLS certificate
echo ""
echo "Checking TLS certificate..."
CERT_INFO=$(echo | openssl s_client -connect "${DOMAIN}:443" -servername "${DOMAIN}" 2>/dev/null | openssl x509 -noout -dates -subject 2>/dev/null || echo "unable to check")
echo "Certificate: $CERT_INFO"
