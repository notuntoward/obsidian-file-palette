# Enable branch protection rules on the default branch for this plugin.
# Run this after: gh auth login
#
# Requires: gh (GitHub CLI) with write access to the repo.
#
# Before running, edit $OWNER, $REPO, and $BRANCH below to match this repo.
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
#   pwsh .github/enable-branch-protection.ps1
#

$ErrorActionPreference = "Stop"

$OWNER  = "notuntoward"
$REPO   = "obsidian-file-palette"
$BRANCH = "main"

# GitHub REST API endpoint for branch protection (legacy)
# https://docs.github.com/rest/branches/branch-protection
$endpoint = "repos/$OWNER/$REPO/branches/$BRANCH/protection"

# Payload
$payload = @"
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
"@

# Write payload to a temp file; avoids encoding issues with pipes in PowerShell.
$tempFile = [System.IO.Path]::GetTempFileName()
Set-Content -Path $tempFile -Value $payload -Encoding utf8 -NoNewline

Write-Host "Applying branch protection to $BRANCH on $OWNER/$REPO ..."
Write-Host "(Admins are NOT restricted: you can still direct-push or force-push.)"
Write-Host

try {
  gh api --method PUT $endpoint --input $tempFile | Out-Host
  Write-Host
  Write-Host "Branch protection rules updated successfully."
} catch {
  Write-Host
  Write-Error "Branch protection update failed."
  Write-Host "Verify gh is authenticated: gh auth status"
  write-Host "If your org enforces rules differently, you may need to use:"
  Write-Host "  https://github.com/$OWNER/$REPO/settings/branch_protection_rules"
  exit 1
} finally {
  Remove-Item -LiteralPath $tempFile -ErrorAction SilentlyContinue
}

Write-Host
Write-Host "Enabling auto-merge on $OWNER/$REPO ..."
gh repo edit "$OWNER/$REPO" --enable-auto-merge

Write-Host
Write-Host "Allowing GitHub Actions to approve pull requests on $OWNER/$REPO ..."
gh api --method PUT "repos/$OWNER/$REPO/actions/permissions/workflow" -F can_approve_pull_request_reviews=true

Write-Host
Write-Host "Repository configuration complete."
Write-Host "Verify at: https://github.com/$OWNER/$REPO/settings"

