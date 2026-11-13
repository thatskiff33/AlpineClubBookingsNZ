#!/usr/bin/env bash
# Prepare the origin/main baseline required by Sekreton's read-only checks.
# Relay sandboxes may provide only a local main and no remote. Never hide a
# fetch failure when a remote is configured, or substitute HEAD for the base.
set -euo pipefail

if git remote get-url origin >/dev/null 2>&1; then
  git fetch --no-tags origin +refs/heads/main:refs/remotes/origin/main
else
  base_commit=$(git rev-parse --verify 'refs/heads/main^{commit}') || {
    echo 'No origin remote or local main baseline; cannot run baseline checks.' >&2
    exit 1
  }
  git merge-base HEAD "$base_commit" >/dev/null
  git update-ref refs/remotes/origin/main "$base_commit"
  echo "No origin remote; using local main ($base_commit) as the check baseline."
fi
