#!/usr/bin/env bash
# =============================================================================
# E-GAOP Branch Protection Setup
# =============================================================================
# Requires: gh CLI authenticated with admin access to the repo
# Usage: bash scripts/setup-branch-protection.sh
# =============================================================================

set -euo pipefail

REPO="${1:-$(gh repo view --json nameWithOwner -q .nameWithOwner 2>/dev/null || echo "")}"

if [ -z "$REPO" ]; then
  echo "Usage: $0 <owner/repo>"
  echo "   or: $0 (from within the repo with gh authenticated)"
  exit 1
fi

echo "Configuring branch protection for $REPO/main..."

# Required status checks
REQUIRED_CHECKS=(
  "lint-and-typecheck"
  "unit-tests"
  "integration-tests"
)

# Build the checks JSON array
CHECKS_JSON=$(printf '%s\n' "${REQUIRED_CHECKS[@]}" | jq -R . | jq -s .)

# Apply branch protection
gh api "repos/$REPO/branches/main/protection" \
  --method PUT \
  --field required_status_checks='{"strict": true, "contexts": '"$CHECKS_JSON"' }' \
  --field enforce_admins=true \
  --field required_pull_request_reviews='{"required_approving_review_count": 1, "dismiss_stale_reviews": true, "require_code_owner_reviews": false}' \
  --field restrictions=null \
  --field allow_force_pushes=false \
  --field allow_deletions=false

echo "✓ Branch protection configured for $REPO/main"
echo ""
echo "Required checks:"
for check in "${REQUIRED_CHECKS[@]}"; do
  echo "  - $check"
done
echo ""
echo "Additional rules:"
echo "  - At least 1 approving review required"
echo "  - Stale reviews dismissed on new pushes"
echo "  - Force pushes disabled"
echo "  - Branch deletion disabled"
echo "  - Admins must follow same rules"
