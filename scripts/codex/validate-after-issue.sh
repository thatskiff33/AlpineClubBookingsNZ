#!/usr/bin/env bash
set -euo pipefail

INCLUDE_LINT=0

usage() {
  cat <<'USAGE'
Usage:
  scripts/codex/validate-after-issue.sh [--include-lint]

Runs safe local checks only. Does not contact live providers, production
databases, production backups, or live webhooks.
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --include-lint)
      INCLUDE_LINT=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "validate-after-issue: unknown argument: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

echo "== git diff --check =="
git diff --check

echo "== node --check .mjs scripts =="
for file in scripts/codex/*.mjs; do
  node --check "$file"
done

if command -v shellcheck >/dev/null 2>&1; then
  echo "== shellcheck scripts/codex/*.sh =="
  shellcheck scripts/codex/*.sh
else
  echo "== shellcheck skipped: command not found =="
fi

if python3 - <<'PY' >/dev/null 2>&1
import yaml
PY
then
  echo "== YAML syntax check =="
  python3 - <<'PY'
from pathlib import Path
import yaml

paths = [
    *Path(".github/ISSUE_TEMPLATE").glob("*.yml"),
    *Path(".github/labels").glob("*.yml"),
    *Path(".github/workflows").glob("*.yml"),
    *Path("docs/agents/examples").glob("**/*.yml"),
]

for path in paths:
    with path.open("r", encoding="utf-8") as handle:
        yaml.safe_load(handle)
    print(f"ok {path}")
PY
else
  echo "== YAML syntax check skipped: python yaml module not available =="
fi

if [[ "$INCLUDE_LINT" -eq 1 ]]; then
  echo "== pnpm run lint =="
  pnpm run lint
fi
