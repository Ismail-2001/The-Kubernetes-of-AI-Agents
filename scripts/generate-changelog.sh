#!/usr/bin/env bash
#
# generate-changelog.sh — Generate changelog entries from git log since last tag.
#
# Usage:
#   ./scripts/generate-changelog.sh
#
# Outputs formatted markdown for a new [Unreleased] section.
# Does NOT write to CHANGELOG.md automatically — review before committing.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CHANGELOG="${REPO_ROOT}/CHANGELOG.md"

# --- Determine the last released tag ---
LAST_TAG=$(git -C "$REPO_ROOT" tag --sort=-v:refname | head -n1)
if [ -z "$LAST_TAG" ]; then
  echo "No tags found. Generating changelog from beginning of history."
  LOG_RANGE="HEAD"
else
  echo "Generating changelog since ${LAST_TAG}"
  LOG_RANGE="${LAST_TAG}..HEAD"
fi

# --- Collect commits grouped by conventional type ---
declare -A SECTIONS
SECTIONS=(
  [feat]="Added"
  [fix]="Fixed"
  [security]="Security"
  [perf]="Performance"
  [refactor]="Changed"
  [docs]="Documentation"
  [test]="Tests"
  [ci]="CI/CD"
  [chore]="Maintenance"
  [breaking]="Breaking Changes"
)

OUTPUT=""
HAS_CONTENT=false

for type in feat fix security perf refactor docs test ci chore breaking; do
  SECTION_TITLE="${SECTIONS[$type]}"
  # Match commits like "feat: ..." or "feat(scope): ..."
  COMMITS=$(git -C "$REPO_ROOT" log "$LOG_RANGE" --pretty=format:"- %s (%h)" --no-merges --grep="^${type}" --grep="^${type}(" | head -50 || true)
  # Also grep for "!" prefix indicating breaking changes (feat!: ...)
  if [ "$type" != "breaking" ]; then
    EXTRA=$(git -C "$REPO_ROOT" log "$LOG_RANGE" --pretty=format:"- %s (%h)" --no-merges --grep="^${type}!" | head -50 || true)
    COMMITS="${COMMITS}${EXTRA:+$'\n'$EXTRA}"
  fi

  if [ -n "$COMMITS" ]; then
    OUTPUT+="### ${SECTION_TITLE}"$'\n\n'
    OUTPUT+="${COMMITS}"$'\n\n'
    HAS_CONTENT=true
  fi
done

if [ "$HAS_CONTENT" = false ]; then
  echo "No conventional commits found since ${LAST_TAG:-initial commit}."
  echo "Make sure commit messages follow Conventional Commits (e.g. feat:, fix:, security:)."
  exit 0
fi

# --- Print the formatted markdown ---
cat <<EOF
## [Unreleased]

${OUTPUT}
EOF

echo "---"
echo "Copy the above into CHANGELOG.md under the ## [Unreleased] section."
echo "Review, edit, and commit when ready."
