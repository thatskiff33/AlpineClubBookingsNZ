#!/usr/bin/env bash
# Refresh the canonical base consumed by the census and migration gates.
# Sekreton checkouts may expose the repository as `origin`, as `gh`, or with no
# remote at all and the base supplied as the local `main` branch. A configured
# remote is always fetched, and a failed fetch fails: a stale ref is never kept.
set -euo pipefail

if git remote get-url origin >/dev/null 2>&1; then
  base_remote=origin
elif git remote get-url gh >/dev/null 2>&1; then
  base_remote=gh
elif git rev-parse --verify -q refs/heads/main >/dev/null; then
  # No remote: the local `main` the sandbox was cut from is the only base.
  git update-ref refs/remotes/origin/main refs/heads/main
  exit 0
else
  echo "Cannot refresh origin/main: no origin or gh remote and no local main branch." >&2
  exit 1
fi

git fetch --no-tags "$base_remote" main:refs/remotes/origin/main
