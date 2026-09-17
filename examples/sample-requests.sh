#!/usr/bin/env bash
# Sample API requests for E-GAOP
# Usage: ./examples/sample-requests.sh [base_url]

set -euo pipefail

BASE="${1:-http://localhost:3001}"
TOKEN=""

echo "E-GAOP API Examples"
echo "==================="
echo ""

# Register
echo "1. Registering user..."
REGISTER_RESPONSE=$(curl -s -X POST "$BASE/api/auth/register" \
  -H "Content-Type: application/json" \
  -d '{"name":"Demo","email":"demo@example.com","password":"DemoPassword123!"}')
echo "   Response: $REGISTER_RESPONSE" | head -c 200
echo ""

# Login
echo "2. Logging in..."
LOGIN_RESPONSE=$(curl -s -X POST "$BASE/api/auth/login" \
  -H "Content-Type: application/json" \
  -d '{"email":"demo@example.com","password":"DemoPassword123!"}')
TOKEN=$(echo "$LOGIN_RESPONSE" | node -e "process.stdin.on('data',d=>{try{console.log(JSON.parse(d).data.token)}catch{console.log('')}})")
echo "   Token: ${TOKEN:0:20}..."
echo ""

# Health check
echo "3. Health check..."
curl -s "$BASE/healthz" | node -e "process.stdin.on('data',d=>console.log('   ' + JSON.stringify(JSON.parse(d),null,2)))"
echo ""

# List agents
echo "4. Listing agents..."
curl -s "$BASE/api/agents" -H "Authorization: Bearer $TOKEN" | node -e "process.stdin.on('data',d=>console.log('   Agents:', JSON.parse(d).data?.length || 0))"
echo ""

# Create agent from demo config
echo "5. Creating demo agent..."
AGENT_RESPONSE=$(curl -s -X POST "$BASE/api/agents" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d @ "$(dirname "$0")/demo-agent.json")
AGENT_ID=$(echo "$AGENT_RESPONSE" | node -e "process.stdin.on('data',d=>{try{console.log(JSON.parse(d).data.id)}catch{console.log('')}}")
echo "   Agent ID: $AGENT_ID"
echo ""

# Run agent
if [ -n "$AGENT_ID" ]; then
  echo "6. Running agent..."
  RUN_RESPONSE=$(curl -s -X POST "$BASE/api/agents/$AGENT_ID/run" \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" \
    -d '{"input": "How do I get started with E-GAOP?"}')
  echo "   Response: $RUN_RESPONSE" | head -c 300
  echo ""
fi

# List namespaces
echo "7. Listing namespaces..."
curl -s "$BASE/api/namespaces" -H "Authorization: Bearer $TOKEN" | node -e "process.stdin.on('data',d=>console.log('   Namespaces:', JSON.parse(d).data?.length || 0))"
echo ""

# Metrics
echo "8. Getting metrics..."
curl -s "$BASE/api/metrics" -H "Authorization: Bearer $TOKEN" | node -e "process.stdin.on('data',d=>console.log('   Metrics:', JSON.stringify(JSON.parse(d).data,null,2).slice(0,200)))"
echo ""

echo "Done! Explore more at $BASE/api/docs"
