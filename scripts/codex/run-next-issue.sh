#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage:
  scripts/codex/run-next-issue.sh [--repo owner/name] [--execute] [--allow-high-risk]

Defaults to prompt-only. Selects at most one open issue labelled agent-ready,
skipping codex-blocked, codex-in-progress, and codex-pr-opened.
USAGE
}

REPO_ARGS=()
EXECUTE=0
ALLOW_HIGH_RISK=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo)
      REPO_ARGS=(--repo "$2")
      shift 2
      ;;
    --execute)
      EXECUTE=1
      shift
      ;;
    --allow-high-risk)
      ALLOW_HIGH_RISK=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "run-next-issue: unknown argument: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

if ! command -v gh >/dev/null 2>&1; then
  echo "run-next-issue: gh CLI is required. Install gh and authenticate first." >&2
  exit 1
fi

if ! gh auth status >/dev/null 2>&1; then
  echo "run-next-issue: gh CLI is not authenticated. Run 'gh auth login' first." >&2
  exit 1
fi

ISSUES_JSON="$(gh issue list "${REPO_ARGS[@]}" --state open --label agent-ready --limit 50 --json number,title,labels)"

SELECTED_JSON="$(ISSUES_JSON="$ISSUES_JSON" node <<'NODE'
const issues = JSON.parse(process.env.ISSUES_JSON);
const skip = new Set(["codex-blocked", "codex-in-progress", "codex-pr-opened"]);
const selected = issues.find((issue) => !issue.labels.some((label) => skip.has(label.name)));
if (!selected) {
  process.exit(2);
}
process.stdout.write(JSON.stringify(selected));
NODE
)" || {
  echo "run-next-issue: no open agent-ready issue is available after skip labels." >&2
  exit 0
}

ISSUE_NUMBER="$(SELECTED_JSON="$SELECTED_JSON" node -e 'const issue = JSON.parse(process.env.SELECTED_JSON); console.log(issue.number)')"
ISSUE_TITLE="$(SELECTED_JSON="$SELECTED_JSON" node -e 'const issue = JSON.parse(process.env.SELECTED_JSON); console.log(issue.title)')"
LABELS="$(SELECTED_JSON="$SELECTED_JSON" node -e 'const issue = JSON.parse(process.env.SELECTED_JSON); console.log(issue.labels.map((label) => label.name).join(","))')"

if [[ "$ALLOW_HIGH_RISK" -ne 1 ]] && [[ ",$LABELS," == *",risk:high,"* || ",$LABELS," == *",risk:critical,"* ]]; then
  echo "run-next-issue: selected issue #$ISSUE_NUMBER is high or critical risk; stopping before editing." >&2
  echo "Title: $ISSUE_TITLE" >&2
  echo "Use --allow-high-risk only after explicit human approval." >&2
  exit 2
fi

PROMPT="$(node scripts/codex/issue-to-prompt.mjs "$ISSUE_NUMBER" "${REPO_ARGS[@]}")"

if [[ "$EXECUTE" -ne 1 ]]; then
  echo "$PROMPT"
  exit 0
fi

if ! command -v codex >/dev/null 2>&1; then
  echo "run-next-issue: codex CLI is required for --execute. Prompt was not executed." >&2
  exit 1
fi

codex --profile alpine-autonomous-high "$PROMPT"
