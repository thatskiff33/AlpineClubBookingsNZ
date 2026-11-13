#!/usr/bin/env bash
# Refresh the canonical base consumed by the census and migration gates.
# Sekreton checkouts may expose the repository as `gh` rather than `origin`.
# Never accept a stale local base when the selected remote cannot be fetched.
set -euo pipefail

if git remote get-url origin >/dev/null 2>&1; then
  base_remote=origin
elif git remote get-url gh >/dev/null 2>&1; then
  base_remote=gh
else
  echo "Cannot refresh origin/main: neither origin nor gh is configured." >&2
  exit 1
fi

git fetch --no-tags "$base_remote" main:refs/remotes/origin/main
