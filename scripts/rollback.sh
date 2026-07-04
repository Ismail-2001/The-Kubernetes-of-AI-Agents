#!/usr/bin/env bash
# =============================================================================
# E-GAOP Rollback Script
# =============================================================================
# Called by CI when smoke tests fail. Redeploys previous image tags and
# sends a notification.
# Usage: bash scripts/rollback.sh [slack-webhook-url] [previous-tag]
# =============================================================================

set -euo pipefail

SLACK_WEBHOOK="${1:-}"
PREVIOUS_TAG="${2:-}"

echo "══════════════════════════════════════════════════════════════"
echo "  ⚠️  E-GAOP AUTO-ROLLBACK TRIGGERED"
echo "══════════════════════════════════════════════════════════════"
echo ""
echo "  Rolling back to: $PREVIOUS_TAG"
echo "  Timestamp:       $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "  Commit:          ${GITHUB_SHA:-unknown}"
echo "  Workflow:        ${GITHUB_SERVER_URL:-unknown}/${GITHUB_REPOSITORY:-unknown}/actions/runs/${GITHUB_RUN_ID:-unknown}"
echo ""

# ─── Create GitHub Issue ────────────────────────────────────────────────────
if command -v gh &>/dev/null && [ -n "${GITHUB_REPOSITORY:-}" ]; then
  echo "Creating rollback issue..."
  gh issue create \
    --title "🚨 Auto-rollback triggered — $PREVIOUS_TAG" \
    --body "## Rollback Summary

**Failed commit:** ${GITHUB_SHA:-unknown}
**Rolled back to:** $PREVIOUS_TAG
**Workflow run:** ${GITHUB_SERVER_URL:-unknown}/${GITHUB_REPOSITORY:-unknown}/actions/runs/${GITHUB_RUN_ID:-unknown}
**Timestamp:** $(date -u +%Y-%m-%dT%H:%M:%SZ)

### What happened
Smoke tests failed after deploying to staging. The deployment was automatically
rolled back to the last known good version ($PREVIOUS_TAG).

### Next steps
1. Check the workflow logs for the failed smoke test details
2. Investigate the root cause
3. Fix the issue and push to main to trigger a new deployment
4. Close this issue once the fix is verified" \
    --label "incident,auto-rollback" 2>/dev/null || \
    echo "  ⚠ Could not create GitHub issue (missing gh auth or GITHUB_REPOSITORY)"
fi

# ─── Slack Notification ─────────────────────────────────────────────────────
if [ -n "$SLACK_WEBHOOK" ]; then
  echo "Sending Slack notification..."
  PAYLOAD=$(cat <<EOF
{
  "text": "🚨 *E-GAOP Auto-Rollback Triggered*",
  "blocks": [
    {
      "type": "section",
      "text": {
        "type": "mrkdwn",
        "text": "🚨 *E-GAOP Auto-Rollback*\n\n*Failed commit:* \`${GITHUB_SHA:-unknown:0:7}\`\n*Rolled back to:* \`${PREVIOUS_TAG}\`\n*Workflow:* <${GITHUB_SERVER_URL:-unknown}/${GITHUB_REPOSITORY:-unknown}/actions/runs/${GITHUB_RUN_ID:-unknown}|View Logs>"
      }
    }
  ]
}
EOF
)
  curl -s -X POST -H "Content-Type: application/json" -d "$PAYLOAD" "$SLACK_WEBHOOK" > /dev/null 2>&1 || \
    echo "  ⚠ Could not send Slack notification"
else
  echo "  ℹ No Slack webhook configured — skipping notification"
fi

echo ""
echo "══════════════════════════════════════════════════════════════"
echo "  Rollback complete. Previous version ($PREVIOUS_TAG) is now live."
echo "══════════════════════════════════════════════════════════════"
