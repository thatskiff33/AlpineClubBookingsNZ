#!/usr/bin/env bash
# One invocation of the pinned gitleaks scanner, shared by the required gate and
# the advisory sweep (#2852).
#
# WHY THIS FILE EXISTS. Two workflows scan this repository for secrets:
#
#   * `.github/workflows/ci.yml` -> `secret-scan`, the REQUIRED
#     `Secret scan (gitleaks)` gate, over three scopes (this pull request's own
#     commits, the history of `main`, the checked-out tree);
#   * `.github/workflows/gitleaks-scheduled.yml`, the advisory weekly sweep, over
#     EVERY branch's history plus the tree.
#
# They must agree about the scanner version, the repository config and the
# allowlist policy, and #2686 is the proof that they will not agree on their own:
# the two jobs that used to sit in `ci.yml` ran 8.24.3 and 8.28.0 over the same
# commits for months. The version lives in `gitleaks-image.sh`; the invocation
# lives here; the config and allowlists are `.gitleaks.toml` and `.gitleaksignore`
# at the repository root, which gitleaks discovers from the scan root, so both
# callers get them without either naming them.
#
# WHY THE EXIT CODE IS 2. gitleaks exits 1 both when it finds a leak and when it
# fails to run at all, and a required security gate cannot afford those to look
# alike — "scanner failure cannot masquerade as a clean result" is #2852's
# acceptance criterion. `--exit-code=2` moves FINDINGS to 2 and leaves every
# other non-zero meaning "the scan did not complete". Both still fail the caller,
# so nothing about what blocks a merge changes; what changes is that the log now
# says which of the two happened. Note the discrimination is fail-CLOSED in both
# directions: if gitleaks ever reported a finding as 1, this script would call it
# a scanner failure and still exit non-zero. The only path to exit 0 is gitleaks
# exiting 0.
#
# Usage — every knob is an environment variable, never an argument spliced into a
# shell program, because these workflows interpolate `${{ }}` values and the
# GitHub Actions script-injection class is what that habit prevents:
#
#   GITLEAKS_SCAN_LABEL="the history of main" \
#   GITLEAKS_LOG_OPTS="--diff-merges=first-parent origin/main" \
#     bash scripts/ci/gitleaks-scan.sh git
#
#   GITLEAKS_SCAN_LABEL="the checked-out tree" \
#     bash scripts/ci/gitleaks-scan.sh dir
#
# Set `GITLEAKS_REPORT_PATH` to a host path to also write a JSON report. The
# report is written by the same `--redact`ed run, so it carries the file, the
# commit, the line and the rule id and NOT the matched value.
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/ci/gitleaks-image.sh
. "${SCRIPT_DIR}/gitleaks-image.sh"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

MODE="${1:-}"
LABEL="${GITLEAKS_SCAN_LABEL:-${MODE}}"

# Docker takes host paths in the host's own spelling. Under Git Bash on Windows —
# where somebody reproducing a CI failure actually sits — the shell reports
# `/c/Users/...`, which the daemon cannot resolve, so the run comes back with
# "0 findings" and looks like a clean repository rather than a broken mount.
# Same helper, same reason, as `gitleaks-selftest.sh`.
host_path() {
  if command -v cygpath >/dev/null 2>&1; then cygpath -m "$1"; else printf '%s' "$1"; fi
}

# The other half of the same Windows problem, and it fails the same silent way.
# Git Bash rewrites an argument that LOOKS like a POSIX path before the child
# process sees it, so the container-side `/repo` arrives as
# `C:/Program Files/Git/repo` and gitleaks exits with a fatal "no such file or
# directory" that reads like a broken scanner. Measured here, not assumed. The
# variable is MSYS-only and is ignored everywhere CI runs.
export MSYS_NO_PATHCONV=1

# `--exit-code` is the whole point of this script; see the header.
LEAK_EXIT=2

args=(--exit-code="${LEAK_EXIT}" --redact)
mounts=(-v "$(host_path "${REPO_ROOT}"):/repo:ro")

if [ -n "${GITLEAKS_REPORT_PATH:-}" ]; then
  report_dir="$(cd "$(dirname "${GITLEAKS_REPORT_PATH}")" && pwd)"
  report_name="$(basename "${GITLEAKS_REPORT_PATH}")"
  # A mounted FILE, never `/dev/stdout`: gitleaks opens the report path with
  # create-and-truncate, which silently produces nothing on a character device,
  # and an empty report reads as "no findings".
  mounts+=(-v "$(host_path "${report_dir}"):/out")
  args+=(--report-format=json --report-path="/out/${report_name}")
fi

case "${MODE}" in
  git)
    if [ -z "${GITLEAKS_LOG_OPTS:-}" ]; then
      echo "::error::gitleaks-scan.sh git needs GITLEAKS_LOG_OPTS. A history scan with no scope is the empty-range false green #2686 exists to close." >&2
      exit 1
    fi
    scan=(git /repo --log-opts="${GITLEAKS_LOG_OPTS}")
    ;;
  dir)
    if [ -n "${GITLEAKS_LOG_OPTS:-}" ]; then
      echo "::error::gitleaks-scan.sh dir takes no GITLEAKS_LOG_OPTS; a directory scan would ignore it and the caller would think it had scoped something." >&2
      exit 1
    fi
    scan=(dir /repo)
    ;;
  *)
    echo "::error::gitleaks-scan.sh takes one argument, 'git' or 'dir'; got '${MODE}'." >&2
    exit 1
    ;;
esac

echo "gitleaks ${GITLEAKS_IMAGE} scanning ${LABEL}"

status=0
docker run --rm "${mounts[@]}" "${GITLEAKS_IMAGE}" "${scan[@]}" "${args[@]}" || status=$?

if [ "${status}" -eq 0 ]; then
  echo "gitleaks found nothing in ${LABEL}."
  exit 0
fi

if [ "${status}" -eq "${LEAK_EXIT}" ]; then
  echo "::error::gitleaks reported findings in ${LABEL}. The values above are redacted; the file, commit and rule id are not." >&2
  exit 1
fi

echo "::error::gitleaks did NOT complete over ${LABEL} (exit ${status}). This is a SCANNER FAILURE, not a clean scan — nothing has been checked." >&2
exit 1
