#!/usr/bin/env bash
# Run from the checkout root before checks that compare against origin/main.
# Sekreton can supply a local main branch without any configured remote.
set -euo pipefail

if git remote get-url origin >/dev/null 2>&1; then
  # An explicit destination also works with narrow or absent fetch refspecs.
  # A broken configured remote must fail, never fall back to a stale baseline.
  git fetch --no-tags origin refs/heads/main:refs/remotes/origin/main
else
  base_sha=$(git rev-parse --verify 'refs/heads/main^{commit}') || {
    echo "Cannot prepare the check baseline: neither origin nor a local main branch exists." >&2
    exit 1
  }
  git merge-base HEAD "$base_sha" >/dev/null
  git update-ref refs/remotes/origin/main "$base_sha"
  echo "No origin remote; using the supplied local main ($base_sha) as origin/main."
fi

git rev-parse --verify 'refs/remotes/origin/main^{commit}' >/dev/null
