#!/bin/bash
# ===========================================================================
# TACBookings Triage Issues - GitHub Issue Creator
# ===========================================================================
# Prerequisites:
#   1. gh CLI installed and authenticated
#   2. PAT must have "Issues: Read and write" permission
#
# Usage:
#   chmod +x docs/github-issues/create-triage-issues.sh
#   ./docs/github-issues/create-triage-issues.sh
# ===========================================================================

set -euo pipefail
REPO="thatskiff33/TACBookings"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "=== Creating labels ==="

create_label() {
  gh label create "$1" --repo "$REPO" --color "$2" --description "$3" --force 2>/dev/null && echo "  ✓ $1" || echo "  ✗ $1 (may already exist)"
}

create_label "quick-fix"        "0E8A16" "Bundled quick fixes"
create_label "feature"          "1D76DB" "New feature build"
create_label "bug"              "B60205" "Bug fix"
create_label "enhancement"      "A2EEEF" "Enhancement to existing feature"
create_label "xero"             "5F9EA0" "Xero integration"
create_label "cancellation"     "D4C5F9" "Cancellation flow"
create_label "booking-policy"   "F9D0C4" "Booking policies"
create_label "admin"            "FBCA04" "Admin tooling"

echo ""
echo "=== Creating issues ==="

create_issue() {
  local title="$1"
  local body_file="$2"
  local labels="$3"
  local body
  body=$(<"$SCRIPT_DIR/$body_file")

  gh issue create --repo "$REPO" --title "$title" --body "$body" --label "$labels" 2>/dev/null && echo "  ✓ $title" || echo "  ✗ Failed: $title"
}

create_issue \
  "Fix: Cancellation UX, double Xero credit note, cash refund reconciliation, audit log links" \
  "quick-fixes-cancellation-xero-audit.md" \
  "quick-fix,bug,enhancement,xero,cancellation,admin"

create_issue \
  "Feature: Account credit system — hold cancellation refunds as credit & apply to future bookings" \
  "feature-account-credit-system.md" \
  "feature,enhancement,xero,cancellation"

create_issue \
  "Feature: Configurable minimum night stay policies" \
  "feature-minimum-night-stay-policy.md" \
  "feature,enhancement,booking-policy"

echo ""
echo "=== Done ==="
echo "View issues: https://github.com/$REPO/issues"
