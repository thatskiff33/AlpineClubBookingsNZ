#!/usr/bin/env bash
# Failure injection for the required `Secret scan (gitleaks)` gate (#2686).
#
# A secret scanner has one failure mode that matters and it is silent: a scanner
# that cannot fail looks exactly like a repository with nothing to find. This
# repository has now hit that failure three separate ways —
#
#   * `.gitleaks.toml` did not carry `[extend] useDefault = true`, which REPLACES
#     the built-in rules with the (empty) set the file declares, so every
#     gitleaks job in CI passed unconditionally for months;
#   * a global allowlist written as a SHAPE (`^(?:pk|sk)_test_…$`, a bare UUID)
#     applies to every rule, not the one its description names, and silently
#     swallowed whole default rules;
#   * `git log -p` emits no patch for a merge commit, so the history scan never
#     looked at a third of this repository's commits, and a secret written while
#     resolving a conflict was invisible.
#
# Each of those turned the gate green. So the gate now proves it can go red
# before it is allowed to go green. Everything below is generated at run time and
# deleted at exit: nothing here is committed, and this file deliberately contains
# no literal that any rule matches — the samples are assembled from a prefix and
# fresh randomness so the script itself is not a finding.
#
# Run it yourself exactly as CI does:
#
#   bash scripts/ci/gitleaks-selftest.sh
#
# It needs Docker and the pinned gitleaks image, nothing else.
set -Eeuo pipefail

# The pinned scanner comes from the one file that names it (#2852), so the
# injection proves the gate can fail using the SAME binary the gate runs. A
# self-test on a different version proves nothing about the gate.
# shellcheck source=scripts/ci/gitleaks-image.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/gitleaks-image.sh"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CONFIG="${REPO_ROOT}/.gitleaks.toml"

if [ ! -f "$CONFIG" ]; then
  echo "FAIL: ${CONFIG} does not exist. The gate cannot be self-tested." >&2
  exit 1
fi

# Docker takes host paths in the host's own spelling. On a Linux runner that is
# what the shell already has; under Git Bash on Windows — where an agent
# reproducing a CI failure actually sits — the shell reports `/c/Users/…`, which
# the daemon cannot resolve, so a run there fails with "0 findings" and looks
# like the scanner is broken rather than the mount. `cygpath -m` is what turns it
# back into `C:/Users/…`; on Linux the command does not exist and the path passes
# through unchanged.
host_path() {
  if command -v cygpath >/dev/null 2>&1; then cygpath -m "$1"; else printf '%s' "$1"; fi
}

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "${WORK}/reports"
CONFIG_MOUNT="$(host_path "$CONFIG")"
REPORTS_MOUNT="$(host_path "${WORK}/reports")"

failures=0
fail() {
  echo "FAIL: $*" >&2
  failures=$((failures + 1))
}
pass() { echo "  ok: $*"; }

# Random material, from the kernel rather than from a literal in this file.
rand() {
  # $1 = length, $2 = character class for `tr -dc`
  LC_ALL=C tr -dc "$2" </dev/urandom | head -c "$1"
}

scan_dir() {
  # $1 = directory to scan, $2 = report name. Prints the JSON report to stdout.
  # The report goes to a mounted FILE, never to `/dev/stdout`: gitleaks opens
  # the report path with create-and-truncate, which silently produces nothing on
  # a character device, and an empty report reads as "no findings" — the exact
  # false green this whole script exists to prevent.
  docker run --rm \
    -v "${CONFIG_MOUNT}:/cfg.toml:ro" \
    -v "$(host_path "$1"):/probe:ro" \
    -v "${REPORTS_MOUNT}:/out" \
    "${GITLEAKS_IMAGE}" \
    dir /probe -c /cfg.toml \
    --exit-code=0 --no-banner --redact \
    --report-format=json --report-path="/out/$2.json" >/dev/null 2>&1
  cat "${WORK}/reports/$2.json"
}

# ---------------------------------------------------------------------------
# 1. A planted credential must be REPORTED.
# ---------------------------------------------------------------------------
# One sample per class this repository could plausibly leak. Each is asserted by
# RULE ID, not by count, so a rule going quiet is named in the failure rather
# than hidden in an arithmetic mismatch.
echo "1. planted credentials must be reported"
mkdir -p "${WORK}/planted"
{
  printf 'AWS_ACCESS_KEY_ID=AKIA%s\n' "$(rand 16 'A-Z0-9')"
  printf 'aws_secret_access_key = "%s"\n' "$(rand 40 'A-Za-z0-9+/')"
  printf 'STRIPE_SECRET_KEY=sk_%s_%s\n' 'live' "$(rand 24 'A-Za-z0-9')"
  printf 'GITHUB_TOKEN=ghp_%s\n' "$(rand 36 'A-Za-z0-9')"
  printf 'DATABASE_URL=postgresql://appuser:%s@db.example.com:5432/app\n' "$(rand 32 'a-f0-9')"
  printf 'REDIS_URL=redis://default:%s@cache.example.net:6379\n' "$(rand 28 'A-Za-z0-9')"
} >"${WORK}/planted/planted.env"

planted_report="$(scan_dir "${WORK}/planted" planted)"
for rule in stripe-access-token github-pat acb-connection-string-password; do
  if printf '%s' "$planted_report" | grep -q "\"RuleID\": *\"${rule}\""; then
    pass "${rule} fired on its planted sample"
  else
    fail "${rule} did not fire on a planted sample. The rule set is not enforcing what it claims."
  fi
done
# The AWS pair and any high-entropy generic value are covered together: at least
# one finding beyond the three named rules must come back, or the entropy-based
# half of the default rule set has stopped working.
planted_count="$(printf '%s' "$planted_report" | grep -c '"RuleID"' || true)"
if [ "${planted_count:-0}" -ge 4 ]; then
  pass "planted sample produced ${planted_count} findings"
else
  fail "planted sample produced only ${planted_count:-0} findings; expected at least 4"
fi

# ---------------------------------------------------------------------------
# 2. This repository's development connection strings must NOT be reported.
# ---------------------------------------------------------------------------
# `acb-connection-string-password` is the one rule this repository owns, and the
# way it fails is by becoming noise: there are hundreds of local development
# connection strings in docs, Compose files and CI env blocks, and a rule that
# reports those trains everyone to suppress it. These are the real shapes.
echo "2. development connection strings must not be reported"
mkdir -p "${WORK}/quiet"
{
  echo 'DATABASE_URL=postgresql://postgres:postgres@localhost:5432/tacbookings'
  echo 'DATABASE_URL=postgresql://tac:password@localhost:5432/tacbookings'
  echo 'DATABASE_URL=postgresql://codex:codex@127.0.0.1:5432/codex_local'
  echo 'SHADOW_DATABASE_URL=postgresql://user:pass@localhost:5432/drift_shadow'
  echo 'STAGING_URL=postgresql://tac:staging-password-change-me@localhost:5433/tacbookings'
  echo 'TEMPLATED=postgresql://tac:${DB_PASSWORD}@postgres:5432/tacbookings'
  echo 'DOCUMENTED=postgresql://ai_diagnostics_ro:<password>@postgres:5432/tacbookings'
  echo 'REDIS_URL=redis://default:pw@localhost:6379'
} >"${WORK}/quiet/dev.env"

quiet_report="$(scan_dir "${WORK}/quiet" quiet)"
quiet_count="$(printf '%s' "$quiet_report" | grep -c '"RuleID"' || true)"
if [ "${quiet_count:-0}" -eq 0 ]; then
  pass "development connection strings produced no findings"
else
  fail "development connection strings produced ${quiet_count} findings; the rule is noise"
  printf '%s\n' "$quiet_report" >&2
fi

# ---------------------------------------------------------------------------
# 3. A secret introduced by a MERGE COMMIT must be reported.
# ---------------------------------------------------------------------------
# This repository merges with merge commits by house rule, and `git log -p`
# emits no patch for a merge commit — so without `--diff-merges=first-parent`,
# gitleaks skips every one of them, and a secret written into a file while
# RESOLVING A CONFLICT exists nowhere else. This builds exactly that repository
# and asserts the flag the workflow uses catches it.
echo "3. a secret in a merge resolution must be reported"
mkdir -p "${WORK}/merge"
(
  cd "${WORK}/merge"
  git init --quiet -b main .
  git config user.email "selftest@invalid"
  git config user.name "gitleaks selftest"
  git config commit.gpgsign false
  echo 'value = placeholder' >conf.env
  git add -A && git commit --quiet -m "base"
  git checkout --quiet -b side
  echo 'value = side' >conf.env
  git add -A && git commit --quiet -m "side"
  git checkout --quiet main
  echo 'value = main' >conf.env
  git add -A && git commit --quiet -m "main"
  git merge --no-commit side >/dev/null 2>&1 || true
  # The conflict resolution — and the ONLY place this value ever appears.
  printf 'STRIPE_SECRET_KEY=sk_%s_%s\n' 'live' "$(rand 24 'A-Za-z0-9')" >conf.env
  git add -A && git commit --quiet --no-edit
)

merge_exit=0
docker run --rm -v "$(host_path "${WORK}/merge"):/repo:ro" -v "${CONFIG_MOUNT}:/cfg.toml:ro" \
  "${GITLEAKS_IMAGE}" git /repo -c /cfg.toml \
  --log-opts="--diff-merges=first-parent main" \
  --exit-code=1 --redact --no-banner >/dev/null 2>&1 || merge_exit=$?
if [ "$merge_exit" -eq 1 ]; then
  pass "--diff-merges=first-parent caught the secret in the merge resolution"
else
  fail "the merge-resolution secret was NOT caught (exit ${merge_exit}). A third of this repository's commits are merges."
fi

# Informational only, deliberately not asserted: this is the behaviour the flag
# exists to work around. If gitleaks ever starts reporting it without the flag,
# this line changes and nothing breaks.
plain_exit=0
docker run --rm -v "$(host_path "${WORK}/merge"):/repo:ro" -v "${CONFIG_MOUNT}:/cfg.toml:ro" \
  "${GITLEAKS_IMAGE}" git /repo -c /cfg.toml \
  --log-opts="main" \
  --exit-code=1 --redact --no-banner >/dev/null 2>&1 || plain_exit=$?
echo "  note: the same scan without --diff-merges=first-parent exits ${plain_exit} (0 means the merge commit is still invisible to a plain scan)"

echo
if [ "$failures" -ne 0 ]; then
  echo "gitleaks self-test FAILED with ${failures} problem(s). The required secret-scanning gate is not enforcing what it claims." >&2
  exit 1
fi
echo "gitleaks self-test passed: the gate can fail, it is not noise, and it can see merge commits."
