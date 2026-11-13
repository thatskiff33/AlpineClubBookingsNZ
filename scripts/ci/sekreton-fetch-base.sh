#!/usr/bin/env bash
# Populate the base ref the census and migration checks share. Sekreton can
# provide a checkout with a local main snapshot and no configured remotes.
# Run from the checkout root; never substitute HEAD or skip base comparisons.
set -euo pipefail

if git remote get-url origin >/dev/null 2>&1; then
  git fetch --no-tags origin refs/heads/main:refs/remotes/origin/main
else
  git rev-parse --verify 'refs/heads/main^{commit}' >/dev/null
  git merge-base --is-ancestor refs/heads/main HEAD
  echo "No origin remote: checking against the sandbox's local main snapshot."
  # A local fetch installs the same remote-tracking ref as the network fetch,
  # without adding a remote or changing either branch.
  git fetch --no-tags . refs/heads/main:refs/remotes/origin/main
fi

git rev-parse --verify 'refs/remotes/origin/main^{commit}'
