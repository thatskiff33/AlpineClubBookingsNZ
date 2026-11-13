#!/usr/bin/env bash
# Point refs/remotes/origin/main at the base the Sekreton gate compares
# against, for the `fast-censuses` and `migrations` jobs (ALP-651).
#
# Those jobs judge the change against origin/main (docs:indexcheck, the
# file-size ratchet, migration drift). A checkout with an `origin` remote
# fetches it. Sekreton's verify sandbox has no `origin`, only a local `main`
# snapshot, so there the snapshot becomes origin/main. It may be older than
# GitHub's main; PR CI remains the authority.
#
# Local main is NOT required to be an ancestor of HEAD: a branch behind main is
# normal and must still be checked against it. HEAD is never used as the base.
#
# Run from the checkout root.
set -euo pipefail

TARGET=refs/remotes/origin/main

fail() {
  echo "sekreton-prepare-base: $*" >&2
  exit 1
}

# The `+` lets the ref move to whatever the source says main is now, even when
# a stale origin/main from an earlier snapshot is not its ancestor.
if git remote get-url origin >/dev/null 2>&1; then
  git fetch --no-tags origin "+refs/heads/main:$TARGET" \
    || fail "could not fetch main from the origin remote"
elif git rev-parse --verify --quiet 'refs/heads/main^{commit}' >/dev/null; then
  echo "sekreton-prepare-base: no origin remote; using the sandbox's local main snapshot as origin/main"
  git fetch --no-tags . "+refs/heads/main:$TARGET" \
    || fail "could not copy local refs/heads/main to $TARGET"
else
  fail "no base to compare against: there is no 'origin' remote and no local 'refs/heads/main' commit"
fi

git rev-parse --verify "$TARGET^{commit}" \
  || fail "$TARGET does not point at a commit after preparing the base"
