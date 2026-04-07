#!/bin/bash
# ===========================================================================
# TACBookings Codebase Review — Automated Fix Runner
# ===========================================================================
#
# Runs Claude Code headlessly for each review phase in dependency order.
# Each phase: creates a branch, applies fixes, runs tests, merges to main.
#
# Usage:
#   chmod +x run-review-fixes.sh
#   nohup ./run-review-fixes.sh > review-fixes.log 2>&1 &
#   tail -f review-fixes.log
#
# To resume from a specific phase:
#   ./run-review-fixes.sh --start-from 3
#
# Prerequisites:
#   - claude CLI installed and authenticated
#   - Node.js, npm, npx available
#   - Git configured with push access
# ===========================================================================

set -euo pipefail

REPO_DIR="/home/ubuntu/TACBookings"
PROMPTS_DIR="$REPO_DIR/docs/github-issues/prompts"
LOG_DIR="$REPO_DIR/logs/review-fixes"
MAIN_BRANCH="main"
# No budget cap — running on Claude subscription, not API

# Parse args
START_FROM=${1:-1}
if [[ "$START_FROM" == "--start-from" ]]; then
  START_FROM=${2:-1}
fi

# ── Helpers ──────────────────────────────────────────────────────────────────

mkdir -p "$LOG_DIR"

timestamp() { date "+%Y-%m-%d %H:%M:%S"; }

log() {
  echo "[$(timestamp)] $1"
}

log_phase() {
  echo ""
  echo "========================================================================"
  echo " PHASE $1: $2"
  echo " Model: $3 | Branch: $4"
  echo " Started: $(timestamp)"
  echo "========================================================================"
  echo ""
}

# Run a single phase
# Args: phase_number, phase_name, model, branch_name, prompt_file
run_phase() {
  local num="$1"
  local name="$2"
  local model="$3"
  local branch="$4"
  local prompt_file="$5"
  local phase_log="$LOG_DIR/phase-${num}.log"

  log_phase "$num" "$name" "$model" "$branch"

  # Check prompt file exists
  if [[ ! -f "$prompt_file" ]]; then
    log "ERROR: Prompt file not found: $prompt_file"
    return 1
  fi

  cd "$REPO_DIR"

  # Ensure we're on main and up to date
  git checkout "$MAIN_BRANCH" 2>/dev/null
  git pull origin "$MAIN_BRANCH" 2>/dev/null || true

  # Delete branch if it already exists (re-run scenario)
  git branch -D "$branch" 2>/dev/null || true

  # Read the prompt file
  local prompt
  prompt=$(<"$prompt_file")

  # Prepend context instructions for the agent
  local full_prompt="You are running headlessly in an automated pipeline. Do NOT ask questions — make your best judgment on any ambiguity. Do NOT create pull requests. Do NOT push to remote. Just make the changes, run tests, and commit locally.

IMPORTANT RULES:
- Read each file BEFORE editing it
- After ALL changes are made, run: npm test
- If tests fail, read the error, fix it, and re-run tests (up to 3 attempts)
- After tests pass, run: npm run build
- If build fails, read the error, fix it, and re-run build
- Only commit once everything passes
- Use the branch name and commit message specified in the prompt
- If a specific change conflicts with the current code (e.g. line numbers shifted), adapt — read the file, find the equivalent code, and make the change

Here is your task:

$prompt"

  log "Running Claude ($model) for phase $num..."
  log "Logging to: $phase_log"

  # Run claude headlessly
  if claude -p "$full_prompt" \
    --model "$model" \
    --dangerously-skip-permissions \
    --effort max \
    > "$phase_log" 2>&1; then
    log "Claude completed phase $num"
  else
    log "WARNING: Claude exited non-zero for phase $num (may still have succeeded)"
  fi

  # Check results
  cd "$REPO_DIR"
  local current_branch
  current_branch=$(git branch --show-current)

  if [[ "$current_branch" == "$branch" ]]; then
    # Claude created and stayed on the branch — check if there are commits
    local commits_ahead
    commits_ahead=$(git rev-list "$MAIN_BRANCH".."$branch" --count 2>/dev/null || echo "0")

    if [[ "$commits_ahead" -gt 0 ]]; then
      log "Phase $num: $commits_ahead commit(s) on branch $branch"

      # Verify tests pass on this branch
      log "Verifying tests pass..."
      if npm test > "$LOG_DIR/phase-${num}-test.log" 2>&1; then
        log "Tests PASSED for phase $num"

        # Merge to main
        git checkout "$MAIN_BRANCH"
        if git merge "$branch" --no-edit; then
          log "Phase $num MERGED to $MAIN_BRANCH"
          git push origin "$MAIN_BRANCH" 2>/dev/null || log "WARNING: Push failed (will retry later)"
          return 0
        else
          log "ERROR: Merge conflict on phase $num"
          git merge --abort
          return 1
        fi
      else
        log "ERROR: Tests FAILED for phase $num after Claude's changes"
        log "See $LOG_DIR/phase-${num}-test.log for details"
        # Don't merge — leave branch for manual inspection
        git checkout "$MAIN_BRANCH"
        return 1
      fi
    else
      log "WARNING: No commits found on branch $branch"
      git checkout "$MAIN_BRANCH"
      return 1
    fi
  else
    # Claude may have committed directly to main, or stayed on main
    # Check if there are uncommitted changes
    if [[ -n $(git status --porcelain) ]]; then
      log "WARNING: Claude left uncommitted changes. Attempting to commit..."
      git checkout -b "$branch" 2>/dev/null || true
      git add -A
      git commit -m "Phase $num: $name (auto-committed by runner)" || true

      if npm test > "$LOG_DIR/phase-${num}-test.log" 2>&1; then
        git checkout "$MAIN_BRANCH"
        git merge "$branch" --no-edit
        git push origin "$MAIN_BRANCH" 2>/dev/null || true
        log "Phase $num MERGED (auto-committed)"
        return 0
      else
        log "ERROR: Tests failed on auto-committed changes"
        git checkout "$MAIN_BRANCH"
        return 1
      fi
    fi

    # Check if Claude committed directly to main
    local main_commits_since
    main_commits_since=$(git log --oneline -5 | head -1)
    log "Current main HEAD: $main_commits_since"
    log "Phase $num may have committed directly to main. Pushing..."
    git push origin "$MAIN_BRANCH" 2>/dev/null || true
    return 0
  fi
}

# ── Phase Definitions ────────────────────────────────────────────────────────
#
# Order matters:
#   Phase 1  → must go first (schema changes block Phase 4)
#   Phase 2  → independent
#   Phase 3  → independent
#   Phase 5a → independent
#   Phase 5b → independent
#   Phase 6  → independent
#   Phase 4  → depends on Phase 1 (@unique on email)
#   Phase 7  → last (security hardening, touches Docker/Caddy)

declare -A PHASES
declare -a PHASE_ORDER

# Phase number | Name | Model | Branch | Prompt file
PHASES[1]="Database Schema Safety|sonnet|fix/phase-1-schema-safety|$PROMPTS_DIR/phase-1-schema-safety.md"
PHASES[2]="UI/UX Bugs|sonnet|fix/phase-2-ui-ux|$PROMPTS_DIR/phase-2-ui-ux.md"
PHASES[3]="Booking & Payment Fixes|sonnet|fix/phase-3-booking-payment|$PROMPTS_DIR/phase-3-booking-payment.md"
PHASES[5]="Cron High Priority|sonnet|fix/phase-5a-cron-high|$PROMPTS_DIR/phase-5a-cron-high.md"
PHASES[51]="Cron Medium Priority|sonnet|fix/phase-5b-cron-medium|$PROMPTS_DIR/phase-5b-cron-medium.md"
PHASES[6]="Xero Edge Cases|sonnet|fix/phase-6-xero-edge-cases|$PROMPTS_DIR/phase-6-xero.md"
PHASES[4]="Concurrency Fixes|opus|fix/phase-4-concurrency|$PROMPTS_DIR/phase-4-concurrency.md"
PHASES[7]="Security Hardening|sonnet|fix/phase-7-security-hardening|$PROMPTS_DIR/phase-7-security.md"

# Execution order (dependency-safe)
PHASE_ORDER=(1 2 3 5 51 6 4 7)

# Map display numbers for skip logic
declare -A PHASE_DISPLAY_NUM
PHASE_DISPLAY_NUM[1]=1
PHASE_DISPLAY_NUM[2]=2
PHASE_DISPLAY_NUM[3]=3
PHASE_DISPLAY_NUM[5]=5
PHASE_DISPLAY_NUM[51]=5  # 5b counts as phase 5 continuation
PHASE_DISPLAY_NUM[6]=6
PHASE_DISPLAY_NUM[4]=4
PHASE_DISPLAY_NUM[7]=7

# ── Main ─────────────────────────────────────────────────────────────────────

log "========================================================================"
log " TACBookings Review Fix Runner"
log " Starting from phase: $START_FROM"
log " Working directory: $REPO_DIR"
log " Log directory: $LOG_DIR"
log "========================================================================"

cd "$REPO_DIR"

# Ensure clean state
if [[ -n $(git status --porcelain) ]]; then
  log "WARNING: Working directory not clean. Stashing changes..."
  git stash push -m "review-fix-runner-stash-$(date +%s)"
fi

git checkout "$MAIN_BRANCH"

SUCCEEDED=0
FAILED=0
SKIPPED=0

for phase_key in "${PHASE_ORDER[@]}"; do
  IFS='|' read -r name model branch prompt_file <<< "${PHASES[$phase_key]}"

  # Skip phases before start_from
  # Phase 51 (5b) runs if start_from <= 5
  local_num=$phase_key
  if [[ $phase_key -eq 51 ]]; then
    local_num=5
  fi

  if [[ $local_num -lt $START_FROM && $phase_key -ne 51 ]]; then
    log "Skipping phase $phase_key ($name) — before start_from=$START_FROM"
    ((SKIPPED++))
    continue
  fi
  if [[ $phase_key -eq 51 && $START_FROM -gt 5 ]]; then
    log "Skipping phase 5b ($name) — before start_from=$START_FROM"
    ((SKIPPED++))
    continue
  fi

  # Phase 4 depends on Phase 1
  if [[ $phase_key -eq 4 ]]; then
    # Verify Phase 1 was applied (check for @unique on Member.email)
    if ! grep -q 'email.*@unique' prisma/schema.prisma 2>/dev/null; then
      log "WARNING: Phase 1 may not have been applied. Phase 4 depends on it."
      log "Proceeding anyway — Phase 4 will handle missing constraint gracefully."
    fi
  fi

  if run_phase "$phase_key" "$name" "$model" "$branch" "$prompt_file"; then
    ((SUCCEEDED++))
    log "Phase $phase_key: SUCCESS"
  else
    ((FAILED++))
    log "Phase $phase_key: FAILED — see $LOG_DIR/phase-${phase_key}.log"
    log "Continuing to next phase..."
  fi

  # Brief pause between phases to avoid rate limits
  sleep 5
done

# ── Summary ──────────────────────────────────────────────────────────────────

echo ""
log "========================================================================"
log " COMPLETE"
log " Succeeded: $SUCCEEDED"
log " Failed:    $FAILED"
log " Skipped:   $SKIPPED"
log "========================================================================"

# Final push
cd "$REPO_DIR"
git checkout "$MAIN_BRANCH"
git push origin "$MAIN_BRANCH" 2>/dev/null || log "Final push failed"

if [[ $FAILED -gt 0 ]]; then
  log ""
  log "Failed phases left on their branches for manual inspection:"
  git branch --list 'fix/phase-*' 2>/dev/null
  log ""
  log "To inspect a failed phase:"
  log "  git checkout fix/phase-X-name"
  log "  cat $LOG_DIR/phase-X.log"
  exit 1
fi

exit 0
