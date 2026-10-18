#!/usr/bin/env bash
# Enable branch protection rules on the default branch for this plugin.
# Run this after: gh auth login
#
# Requires: gh (GitHub CLI) with write access to the repo.
#
# Before running, edit OWNER, REPO, and BRANCH below to match this repo.
#
# Scoring impact (OpenSSF Scorecard v5):
#   Tier 1 (3/10): prevent force pushes, prevent branch deletion  -- INCLUDED
#   Tier 2 (6/10): require PR, require 1 approval                 -- INCLUDED
#   Tier 3 (8/10): require status checks to pass                  -- INCLUDED
#
# Admin bypass: administrators are NOT required to use PRs, so
# you can still direct-push or force-push when needed.
#
# Usage:
#   gh auth login   (if not already done)
#   bash .github/enable-branch-protection.sh
#

set -euo pipefail

OWNER="notuntoward"
REPO="obsidian-file-palette"
BRANCH="main"

# GitHub REST API endpoint for branch protection (legacy)
# https://docs.github.com/rest/branches/branch-protection
ENDPOINT="repos/${OWNER}/${REPO}/branches/${BRANCH}/protection"

# Payload (note: "restrictions" is required by the API even when null)
read -r -d '' PAYLOAD <<EOF
{
  "enforce_admins": false,
  "allow_force_pushes": false,
  "allow_deletions": false,
  "restrictions": null,
  "required_pull_request_reviews": {
    "required_approving_review_count": 1,
    "dismiss_stale_reviews": false,
    "require_code_owner_reviews": false
  },
  "required_status_checks": {
    "strict": true,
    "contexts": ["ESLint and build"]
  }
}
EOF

TMPFILE="$(mktemp)"
cleanup() { rm -f "$TMPFILE"; }
trap cleanup EXIT

printf '%s' "$PAYLOAD" > "$TMPFILE"

echo "Applying branch protection to ${BRANCH} on ${OWNER}/${REPO} ..."
echo "(Admins are NOT restricted: you can still direct-push or force-push.)"
echo

if gh api --method PUT "$ENDPOINT" --input "$TMPFILE"; then
  echo
  echo "Branch protection rules updated successfully."
else
  echo
  echo "Branch protection update failed."
  echo "Verify gh is authenticated: gh auth status"
  echo "If your org enforces rules differently, you may need to use:"
  echo "  https://github.com/${OWNER}/${REPO}/settings/branch_protection_rules"
  exit 1
fi

echo
echo "Enabling auto-merge on ${OWNER}/${REPO} ..."
gh repo edit "${OWNER}/${REPO}" --enable-auto-merge

echo
echo "Allowing GitHub Actions to approve pull requests on ${OWNER}/${REPO} ..."
gh api --method PUT "repos/${OWNER}/${REPO}/actions/permissions/workflow" -F can_approve_pull_request_reviews=true

echo
echo "Repository configuration complete."
echo "Verify at: https://github.com/${OWNER}/${REPO}/settings"

