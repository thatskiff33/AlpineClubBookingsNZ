#!/bin/bash
# ===========================================================================
# TACBookings Codebase Review - GitHub Issue Creator
# ===========================================================================
# Prerequisites:
#   1. gh CLI installed and authenticated
#   2. PAT must have "Issues: Read and write" permission
#
# Usage:
#   chmod +x docs/github-issues/create-issues.sh
#   ./docs/github-issues/create-issues.sh
# ===========================================================================

set -euo pipefail
REPO="thatskiff33/TACBookings"

echo "=== Creating labels ==="

create_label() {
  gh label create "$1" --repo "$REPO" --color "$2" --description "$3" --force 2>/dev/null && echo "  ✓ $1" || echo "  ✗ $1 (may already exist)"
}

# Severity labels
create_label "critical"         "B60205" "Must fix before production"
create_label "high"             "D93F0B" "Must fix before UAT"
create_label "medium"           "FBCA04" "Should fix before go-live"
create_label "low"              "0E8A16" "Nice to have improvement"

# Phase labels
create_label "phase-1"          "1D76DB" "Database Schema Safety"
create_label "phase-2"          "5F9EA0" "UI/UX Bugs"
create_label "phase-3"          "0075CA" "Booking & Payment Flow Fixes"
create_label "phase-4"          "D4C5F9" "Concurrency & Race Conditions"
create_label "phase-5"          "F9D0C4" "Notification & Cron Reliability"
create_label "phase-6"          "C2E0C6" "Xero & Modification Edge Cases"
create_label "phase-7"          "E4E669" "Security Hardening"

# Type label
create_label "codebase-review"  "5319E7" "From 2026-04-07 codebase review"

echo ""
echo "=== Creating milestone ==="
gh api repos/"$REPO"/milestones --method POST \
  -f title="Codebase Review Remediation" \
  -f description="Fix all issues identified in the 2026-04-07 comprehensive codebase review. See docs/CODEBASE_REVIEW_2026-04-07.md" \
  -f state="open" \
  --jq '.number' 2>/dev/null && echo "  ✓ Milestone created" || echo "  ✗ Milestone may already exist"

# Get milestone number
MILESTONE=$(gh api repos/"$REPO"/milestones --jq '.[0].number' 2>/dev/null || echo "")

echo ""
echo "=== Creating issues ==="

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

create_issue() {
  local title="$1"
  local body_file="$2"
  local labels="$3"
  local body
  body=$(<"$SCRIPT_DIR/$body_file")

  if [ -n "$MILESTONE" ]; then
    gh issue create --repo "$REPO" --title "$title" --body "$body" --label "$labels" --milestone "Codebase Review Remediation" 2>/dev/null && echo "  ✓ $title" || echo "  ✗ Failed: $title"
  else
    gh issue create --repo "$REPO" --title "$title" --body "$body" --label "$labels" 2>/dev/null && echo "  ✓ $title" || echo "  ✗ Failed: $title"
  fi
}

create_issue "Phase 1: Database Schema Safety"            "phase-1.md" "critical,phase-1,codebase-review"
create_issue "Phase 2: UI/UX Bugs"                        "phase-2.md" "critical,high,phase-2,codebase-review"
create_issue "Phase 3: Booking & Payment Flow Fixes"      "phase-3.md" "high,phase-3,codebase-review"
create_issue "Phase 4: Concurrency & Race Conditions"     "phase-4.md" "critical,high,phase-4,codebase-review"
create_issue "Phase 5: Notification & Cron Reliability"   "phase-5.md" "high,medium,phase-5,codebase-review"
create_issue "Phase 6: Xero & Modification Edge Cases"    "phase-6.md" "high,medium,phase-6,codebase-review"
create_issue "Phase 7: Security Hardening"                "phase-7.md" "medium,low,phase-7,codebase-review"

echo ""
echo "=== Done ==="
echo "View issues: https://github.com/$REPO/issues"
