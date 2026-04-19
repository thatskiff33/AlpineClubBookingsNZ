#!/usr/bin/env bash
set -Eeuo pipefail

###############################################################################
# TACBookings — Finance Codex Autoloop
#
# Runs one Codex session at a time against the finance handoff "Next Prompt"
# block, always prefixing the session prompt with `$github` so the GitHub
# plugin workflow is explicitly requested in non-interactive mode.
#
# Important:
# - This uses `codex exec`, not the interactive TUI. There is no reliable
#   unattended "press Tab to select plugin" path, so `$github` is the stable
#   automation trigger instead.
# - Each loop starts a brand-new Codex session.
# - The loop stops when there are no open finance task issues,
#   when there is no Next Prompt block, or when a cycle makes no observable
#   progress (to avoid infinite retries).
#
# Usage:
#   ./scripts/run-finance-codex-autoloop.sh
#   ./scripts/run-finance-codex-autoloop.sh --once
#   ./scripts/run-finance-codex-autoloop.sh --dry-run
###############################################################################

PROJECT_DIR="${PROJECT_DIR:-$(cd "$(dirname "$0")/.." && pwd)}"
HANDOFF_FILE="${HANDOFF_FILE:-$PROJECT_DIR/docs/finance-dashboard/handoff.md}"
CODEX_BIN="${CODEX_BIN:-codex}"
MAIN_BRANCH="${MAIN_BRANCH:-main}"
MAX_CYCLES="${MAX_CYCLES:-25}"
ISSUE_QUERY="${ISSUE_QUERY:-label:\"area: finance\" label:\"type: task\" state:open}"
READY_QUERY="${READY_QUERY:-label:\"area: finance\" label:\"status: ready\" state:open}"
RUN_ONCE=0
DRY_RUN=0

RUN_STAMP="$(date +%Y%m%d-%H%M%S)"
LOG_DIR="${LOG_DIR:-$PROJECT_DIR/logs/codex-finance-autoloop-$RUN_STAMP}"
mkdir -p "$LOG_DIR"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

info() {
  printf "${CYAN}[%s]${NC} %s\n" "$(date +%H:%M:%S)" "$1"
}

ok() {
  printf "${GREEN}[%s] DONE${NC} %s\n" "$(date +%H:%M:%S)" "$1"
}

warn() {
  printf "${YELLOW}[%s] WARN${NC} %s\n" "$(date +%H:%M:%S)" "$1"
}

fail() {
  printf "${RED}[%s] FAIL${NC} %s\n" "$(date +%H:%M:%S)" "$1" >&2
}

usage() {
  cat <<EOF
Usage: $(basename "$0") [--once] [--dry-run] [--max-cycles N]

Options:
  --once           Run exactly one Codex session, then stop.
  --dry-run        Print the extracted Next Prompt and exit.
  --max-cycles N   Override the default session limit ($MAX_CYCLES).
  -h, --help       Show this help.

Environment overrides:
  PROJECT_DIR      Repo root (default: auto-detected)
  HANDOFF_FILE     Finance handoff file
  CODEX_BIN        Codex binary name/path
  MAIN_BRANCH      Main branch name (default: main)
  MAX_CYCLES       Max loop count before forcing a stop
  LOG_DIR          Session log directory
  ISSUE_QUERY      GitHub issue search used to decide when to stop
  READY_QUERY      GitHub issue search used for visibility only
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --once)
      RUN_ONCE=1
      shift
      ;;
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    --max-cycles)
      MAX_CYCLES="${2:?--max-cycles requires a value}"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      fail "Unknown argument: $1"
      usage
      exit 1
      ;;
  esac
done

require_command() {
  local name="$1"
  command -v "$name" >/dev/null 2>&1 || {
    fail "Required command not found on PATH: $name"
    exit 1
  }
}

get_repo_slug() {
  gh repo view --json nameWithOwner --jq '.nameWithOwner'
}

ensure_repo_root() {
  [[ -d "$PROJECT_DIR/.git" ]] || {
    fail "PROJECT_DIR is not a git repository: $PROJECT_DIR"
    exit 1
  }
  [[ -f "$HANDOFF_FILE" ]] || {
    fail "Handoff file not found: $HANDOFF_FILE"
    exit 1
  }
}

filter_allowed_status_lines() {
  local line=""
  local path=""

  while IFS= read -r line; do
    [[ -z "$line" ]] && continue
    path="${line:3}"

    case "$path" in
      scripts/run-finance-codex-autoloop.sh|logs/codex-finance-autoloop-*|*.zip)
        continue
        ;;
    esac

    printf '%s\n' "$line"
  done
}

ensure_clean_worktree() {
  local remaining_changes=""
  remaining_changes="$(
    git -C "$PROJECT_DIR" status --porcelain=1 --untracked-files=all | filter_allowed_status_lines || true
  )"

  if [[ -n "$remaining_changes" ]]; then
    fail "Working tree is not clean. Commit/stash existing changes before running this autoloop."
    printf '%s\n' "$remaining_changes"
    exit 1
  fi
}

count_issues() {
  local repo="$1"
  local query="$2"
  gh issue list \
    --repo "$repo" \
    --search "$query" \
    --limit 200 \
    --json number \
    --jq 'length'
}

extract_next_prompt() {
  awk '
    /^## Next Prompt$/ { in_section=1; next }
    in_section && /^```text$/ { in_block=1; next }
    in_section && in_block && /^```$/ { exit }
    in_block { print }
  ' "$HANDOFF_FILE"
}

hash_text() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum | awk '{print $1}'
  else
    shasum -a 256 | awk '{print $1}'
  fi
}

build_prompt_file() {
  local output_file="$1"
  local next_prompt="$2"

  cat >"$output_file" <<'EOF'
$github

Use the GitHub plugin workflow for every GitHub-related action in this session.
This run is non-interactive, so do not rely on TUI plugin selection or ask for a
Tab keypress; the `$github` prefix above is the explicit plugin trigger.

Follow the handoff prompt exactly. Work one prompt/session at a time. If the
prompt says to land work, safely push, merge when safe, return the checkout to
main, and clean up merged `codex/*` branches when you can do so without
bypassing branch protections or ignoring failing checks.

If CI, branch protection, merge conflicts, missing permissions, or any other
blocker prevents landing, stop after updating the handoff with the precise
blocker. Do not silently broaden scope or start a second task in the same
session.

The exact task prompt follows:

EOF

  printf '%s\n' "$next_prompt" >>"$output_file"
}

run_codex_cycle() {
  local cycle="$1"
  local prompt_text="$2"
  local prompt_file="$LOG_DIR/cycle-$(printf '%03d' "$cycle")-prompt.txt"
  local last_message_file="$LOG_DIR/cycle-$(printf '%03d' "$cycle")-last-message.txt"
  local log_file="$LOG_DIR/cycle-$(printf '%03d' "$cycle")-codex.log"

  build_prompt_file "$prompt_file" "$prompt_text"

  info "Starting Codex session $cycle"
  if ! "$CODEX_BIN" exec \
      -C "$PROJECT_DIR" \
      -s danger-full-access \
      -a never \
      --color never \
      -o "$last_message_file" \
      - <"$prompt_file" 2>&1 | tee "$log_file"; then
    fail "Codex session $cycle failed. See $log_file"
    exit 1
  fi
  ok "Codex session $cycle completed"
}

sync_main_and_cleanup() {
  info "Syncing local $MAIN_BRANCH and pruning merged codex branches"
  git -C "$PROJECT_DIR" fetch origin --prune
  git -C "$PROJECT_DIR" checkout "$MAIN_BRANCH" >/dev/null 2>&1
  git -C "$PROJECT_DIR" pull --ff-only origin "$MAIN_BRANCH"

  mapfile -t merged_branches < <(
    git -C "$PROJECT_DIR" for-each-ref \
      --format='%(refname:short)' \
      "refs/heads/codex/*" \
      --merged "origin/$MAIN_BRANCH"
  )

  for branch in "${merged_branches[@]}"; do
    [[ -z "$branch" ]] && continue
    [[ "$branch" == "$MAIN_BRANCH" ]] && continue

    git -C "$PROJECT_DIR" branch -d "$branch" >/dev/null 2>&1 || true
    if git -C "$PROJECT_DIR" ls-remote --exit-code --heads origin "$branch" >/dev/null 2>&1; then
      git -C "$PROJECT_DIR" push origin --delete "$branch" >/dev/null 2>&1 || true
    fi
  done

  ensure_clean_worktree
  ok "Local repo normalized back to $MAIN_BRANCH"
}

require_command "$CODEX_BIN"
require_command gh
require_command git

ensure_repo_root
cd "$PROJECT_DIR"

if ! gh auth status >/dev/null 2>&1; then
  fail "gh is not authenticated. Run 'gh auth login' first."
  exit 1
fi

REPO_SLUG="$(get_repo_slug)"
OPEN_ISSUES_BEFORE="$(count_issues "$REPO_SLUG" "$ISSUE_QUERY")"
READY_ISSUES_BEFORE="$(count_issues "$REPO_SLUG" "$READY_QUERY")"

info "Repo: $REPO_SLUG"
info "Open finance task issues: $OPEN_ISSUES_BEFORE"
info "Open finance ready issues: $READY_ISSUES_BEFORE"

if [[ "$OPEN_ISSUES_BEFORE" == "0" ]]; then
  ok "No open finance task issues found. Nothing to do."
  exit 0
fi

NEXT_PROMPT="$(extract_next_prompt)"
if [[ -z "$NEXT_PROMPT" ]]; then
  fail "No Next Prompt block found in $HANDOFF_FILE"
  exit 1
fi

if [[ "$DRY_RUN" == "1" ]]; then
  printf '%s\n' "$NEXT_PROMPT"
  exit 0
fi

ensure_clean_worktree

LAST_PROMPT_HASH=""
cycle=1

while (( cycle <= MAX_CYCLES )); do
  NEXT_PROMPT="$(extract_next_prompt)"
  if [[ -z "$NEXT_PROMPT" ]]; then
    warn "No Next Prompt block found after cycle $((cycle - 1)). Stopping."
    break
  fi

  PROMPT_HASH="$(printf '%s' "$NEXT_PROMPT" | hash_text)"
  OPEN_ISSUES_BEFORE="$(count_issues "$REPO_SLUG" "$ISSUE_QUERY")"

  if [[ "$OPEN_ISSUES_BEFORE" == "0" ]]; then
    ok "No open finance task issues remain. Stopping."
    break
  fi

  info "Cycle $cycle/$MAX_CYCLES"
  info "Open finance task issues before run: $OPEN_ISSUES_BEFORE"

  run_codex_cycle "$cycle" "$NEXT_PROMPT"
  sync_main_and_cleanup

  OPEN_ISSUES_AFTER="$(count_issues "$REPO_SLUG" "$ISSUE_QUERY")"
  READY_ISSUES_AFTER="$(count_issues "$REPO_SLUG" "$READY_QUERY")"
  NEXT_PROMPT_AFTER="$(extract_next_prompt)"
  NEXT_PROMPT_AFTER_HASH=""
  if [[ -n "$NEXT_PROMPT_AFTER" ]]; then
    NEXT_PROMPT_AFTER_HASH="$(printf '%s' "$NEXT_PROMPT_AFTER" | hash_text)"
  fi

  info "Open finance task issues after run: $OPEN_ISSUES_AFTER"
  info "Open finance ready issues after run: $READY_ISSUES_AFTER"

  if [[ "$OPEN_ISSUES_AFTER" == "0" ]]; then
    ok "All open finance task issues are cleared."
    break
  fi

  if [[ "$RUN_ONCE" == "1" ]]; then
    info "--once requested; stopping after one session."
    break
  fi

  if [[ -n "$LAST_PROMPT_HASH" ]] && [[ "$PROMPT_HASH" == "$LAST_PROMPT_HASH" ]] && [[ "$OPEN_ISSUES_AFTER" -ge "$OPEN_ISSUES_BEFORE" ]]; then
    warn "Prompt and issue count did not progress across consecutive cycles. Stopping to avoid an infinite loop."
    break
  fi

  if [[ "$PROMPT_HASH" == "$NEXT_PROMPT_AFTER_HASH" ]] && [[ "$OPEN_ISSUES_AFTER" -ge "$OPEN_ISSUES_BEFORE" ]]; then
    warn "The handoff Next Prompt did not change and the open issue count did not drop. Stopping to avoid a tight retry loop."
    break
  fi

  LAST_PROMPT_HASH="$PROMPT_HASH"
  ((cycle++))
done

if (( cycle > MAX_CYCLES )); then
  warn "Reached MAX_CYCLES=$MAX_CYCLES and stopped."
fi

ok "Autoloop finished. Logs: $LOG_DIR"
