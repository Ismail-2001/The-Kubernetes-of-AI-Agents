#!/usr/bin/env bash
#
# bump-version.sh — Bump the project version across CHANGELOG.md and all workspaces.
#
# Usage:
#   ./scripts/bump-version.sh <major|minor|patch>
#
# Steps performed:
#   1. Reads current version from CHANGELOG.md (first version after [Unreleased])
#   2. Calculates new version based on bump type
#   3. Updates CHANGELOG.md (renames [Unreleased], adds new empty [Unreleased], updates links)
#   4. Updates package.json version in root and all workspaces
#   5. Creates a git commit "chore: release v{version}"
#   6. Creates a git tag v{version}
#   7. Prints next-step instructions

set -euo pipefail

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

usage() {
  echo "Usage: $0 <major|minor|patch>"
  echo ""
  echo "Examples:"
  echo "  $0 patch   # 1.0.0 -> 1.0.1"
  echo "  $0 minor   # 1.0.0 -> 1.1.0"
  echo "  $0 major   # 1.0.0 -> 2.0.0"
  exit 1
}

bump_semver() {
  local ver="$1" type="$2"
  IFS='.' read -r major minor patch <<< "$ver"
  case "$type" in
    major) echo "$((major + 1)).0.0" ;;
    minor) echo "${major}.$((minor + 1)).0" ;;
    patch) echo "${major}.${minor}.$((patch + 1))" ;;
    *) usage ;;
  esac
}

# ---------------------------------------------------------------------------
# Validate arguments
# ---------------------------------------------------------------------------

if [ $# -ne 1 ]; then
  usage
fi

BUMP_TYPE="$1"
if [[ ! "$BUMP_TYPE" =~ ^(major|minor|patch)$ ]]; then
  echo "❌ Invalid bump type: $BUMP_TYPE (expected major, minor, or patch)"
  exit 1
fi

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CHANGELOG="${REPO_ROOT}/CHANGELOG.md"
TODAY=$(date +%Y-%m-%d)

# ---------------------------------------------------------------------------
# 1. Read current version from CHANGELOG.md
# ---------------------------------------------------------------------------
# Find the first version line like ## [1.2.3] or ## [1.2.3] - 2026-01-15

CURRENT_VERSION=$(grep -oP '## \[\K[0-9]+\.[0-9]+\.[0-9]+' "$CHANGELOG" | head -n1)
if [ -z "$CURRENT_VERSION" ]; then
  echo "❌ Could not find a version in CHANGELOG.md"
  echo "   Expected a line like: ## [1.0.0] or ## [1.0.0] - 2026-01-15"
  exit 1
fi

echo "📌 Current version: ${CURRENT_VERSION}"

# ---------------------------------------------------------------------------
# 2. Calculate new version
# ---------------------------------------------------------------------------

NEW_VERSION=$(bump_semver "$CURRENT_VERSION" "$BUMP_TYPE")
echo "🔖 New version:     ${NEW_VERSION}"

# ---------------------------------------------------------------------------
# 3. Update CHANGELOG.md
# ---------------------------------------------------------------------------

# a) Rename [Unreleased] to [NEW_VERSION] - DATE
# b) Add new empty [Unreleased] section above it
# c) Update comparison links at bottom

REPO_URL=$(git -C "$REPO_ROOT" remote get-url origin 2>/dev/null | sed 's/\.git$//' || echo "https://github.com/Ismail-2001/The-Kubernetes-of-AI-Agents")

# Build the new content with a temp file
TMPFILE=$(mktemp)
trap 'rm -f "$TMPFILE"' EXIT

awk -v new_ver="$NEW_VERSION" -v today="$TODAY" -v prev_ver="$CURRENT_VERSION" -v repo_url="$REPO_URL" '
BEGIN { updated_unreleased = 0; links_done = 0; in_unreleased = 0; unreleased_content = "" }

# Replace the first [Unreleased] header with the versioned header
/^## \[Unreleased\]/ && !updated_unreleased {
    print "## [" new_ver "] - " today
    updated_unreleased = 1
    next
}

# After the version header, insert a new empty [Unreleased] section
# right before the next ## or end-of-section
updated_unreleased && !in_unreleased && /^## / {
    print "## [Unreleased]"
    print ""
    in_unreleased = 1
}

# Update comparison links at bottom
/^\[Unreleased\]:/ {
    print "[" new_ver "]: " repo_url "/compare/v" prev_ver "...v" new_ver
    print "[Unreleased]: " repo_url "/compare/v" new_ver "...HEAD"
    links_done = 1
    next
}

{ print }
' "$CHANGELOG" > "$TMPFILE"

mv "$TMPFILE" "$CHANGELOG"
echo "✅ Updated CHANGELOG.md"

# ---------------------------------------------------------------------------
# 4. Update package.json files (root + all workspaces)
# ---------------------------------------------------------------------------

update_package_version() {
  local pkg_json="$1"
  if [ -f "$pkg_json" ]; then
    # Use node for reliable JSON manipulation if available, otherwise sed
    if command -v node &>/dev/null; then
      node -e "
        const fs = require('fs');
        const pkg = JSON.parse(fs.readFileSync('$pkg_json', 'utf8'));
        pkg.version = '$NEW_VERSION';
        fs.writeFileSync('$pkg_json', JSON.stringify(pkg, null, 2) + '\n');
      "
    else
      sed -i "s/\"version\": \"${CURRENT_VERSION}\"/\"version\": \"${NEW_VERSION}\"/" "$pkg_json"
    fi
    echo "  ✅ $(basename "$(dirname "$pkg_json")")/package.json"
  fi
}

echo "📦 Updating package.json files..."
update_package_version "${REPO_ROOT}/package.json"

# Update workspace package.json files
while IFS= read -r workspace; do
  [ -z "$workspace" ] && continue
  update_package_version "${REPO_ROOT}/${workspace}/package.json"
done < <(node -e "
  const pkg = require('${REPO_ROOT}/package.json');
  (pkg.workspaces || []).forEach(w => console.log(w));
" 2>/dev/null || grep -oP '"workspaces":\s*\[\s*"\K[^"]+' "${REPO_ROOT}/package.json" | tr ',' '\n')

# ---------------------------------------------------------------------------
# 5. Git commit
# ---------------------------------------------------------------------------

echo ""
echo "📝 Creating git commit..."
git -C "$REPO_ROOT" add -A
git -C "$REPO_ROOT" commit -m "chore: release v${NEW_VERSION}"

# ---------------------------------------------------------------------------
# 6. Git tag
# ---------------------------------------------------------------------------

echo "🏷️  Creating git tag v${NEW_VERSION}..."
git -C "$REPO_ROOT" tag -a "v${NEW_VERSION}" -m "Release v${NEW_VERSION}"

# ---------------------------------------------------------------------------
# 7. Print next steps
# ---------------------------------------------------------------------------

echo ""
echo "============================================"
echo "  ✅ Version bumped to ${NEW_VERSION}"
echo "============================================"
echo ""
echo "Next steps:"
echo "  1. Review the changes:  git log --oneline -3"
echo "  2. Push the commit:     git push origin main"
echo "  3. Push the tag:        git push origin v${NEW_VERSION}"
echo ""
echo "Pushing the tag will trigger the Release workflow,"
echo "which builds Docker images and creates a GitHub Release."
echo ""
