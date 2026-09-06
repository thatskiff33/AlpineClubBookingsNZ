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
# says which of the two happened. The discrimination is fail-CLOSED in both
# directions: if gitleaks ever reported a finding as 1, this script would call it
# a scanner failure and still exit non-zero.
#
# The exit MATRIX, measured against v8.28.0 rather than read off the manual:
#
#   clean                       0
#   findings                    2   (because of `--exit-code=2`)
#   unreadable scan path        1
#   unparseable .gitleaks.toml  1
#   unknown flag              126
#   image cannot be resolved  125   (docker, not gitleaks)
#   THE GIT SOURCE FAILED       0   <- see the two checks at the bottom
#
# That last row is why exit 0 is not sufficient on its own, and it has two
# shapes: the walk produced NOTHING (`0 commits scanned`), or it stopped
# PART WAY and reported the commits it had already seen. Both exit 0 and both
# read as clean. So the path to exit 0 here is gitleaks exiting 0 AND, in
# `git` mode, at least one commit scanned AND no git `fatal:`/`error:` in the
# log — plus, in both modes, a mount that passed the preflight below.
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
host_repo="$(host_path "${REPO_ROOT}")"
mounts=(-v "${host_repo}:/repo:ro")

# PREFLIGHT, and it exists because a bad mount is silent. Docker Desktop
# CREATES a bind-mount source that does not exist, as an empty directory — so
# `dir /repo` walks an empty tree, gitleaks reports no leaks, and exits 0.
# There is no output to catch it with either: gitleaks logs a byte count but
# never a file count, and an empty directory scans in the same shape as a
# clean one. `git` mode has the zero-commit check below; `dir` mode has
# nothing, so the check has to happen HOST-side, before the container runs.
#
# Two things are asserted, and both are about the path rather than the scan:
# that the mount source really is this repository (its `.gitleaks.toml` is
# there, which also means the rule set the scan depends on exists), and that
# under Git Bash the path has been converted to the drive-lettered spelling
# the daemon can resolve. A `/c/Users/...` path is the exact input that gets
# auto-created as an empty directory.
if [ ! -f "${REPO_ROOT}/.gitleaks.toml" ]; then
  echo "::error::${REPO_ROOT}/.gitleaks.toml is missing, so the scan would run against no rule set and mount a directory that is not this repository. SCANNER FAILURE, not a clean scan." >&2
  exit 1
fi
if command -v cygpath >/dev/null 2>&1; then
  case "${host_repo}" in
    [A-Za-z]:/*) ;;
    *)
      echo "::error::the mount source resolved to '${host_repo}', which the Docker daemon cannot resolve on this host — it would be auto-created as an EMPTY directory and scan clean. SCANNER FAILURE, not a clean scan." >&2
      exit 1
      ;;
  esac
fi

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

# The output is captured rather than streamed because exit status alone cannot
# answer the questions below, and then printed in full so a reader loses
# nothing. `NO_COLOR=1` is belt-and-braces: zerolog's console writer colours
# the LEVEL token and may ignore the variable, but the message body — which is
# what the greps below read — is uncoloured either way.
log="$(mktemp)"
trap 'rm -f "${log}"' EXIT

status=0
docker run --rm -e NO_COLOR=1 "${mounts[@]}" "${GITLEAKS_IMAGE}" "${scan[@]}" "${args[@]}" \
  >"${log}" 2>&1 || status=$?
cat "${log}"

if [ "${status}" -eq "${LEAK_EXIT}" ]; then
  echo "::error::gitleaks reported findings in ${LABEL}. The values above are redacted; the file, commit and rule id are not." >&2
  exit 1
fi

if [ "${status}" -ne 0 ]; then
  echo "::error::gitleaks did NOT complete over ${LABEL} (exit ${status}). This is a SCANNER FAILURE, not a clean scan — nothing has been checked." >&2
  exit 1
fi

# THE ZERO-COMMIT FALSE GREEN, and it is the reason exit 0 is not trusted on its
# own. When the git source itself fails — an unresolvable range, or
# `detected dubious ownership` — gitleaks logs the git error, decides it
# completed, and exits 0:
#
#   ERR [git] fatal: ambiguous argument 'deadbeef..cafebabe': unknown revision…
#   INF 0 commits scanned.
#   INF no leaks found
#
# Measured on v8.28.0. `--exit-code` never applies, because from gitleaks' point
# of view there was nothing to find. That lands on the REQUIRED gate: the
# pull-request scope's `${PR_BASE_SHA}..${PR_HEAD_SHA}` is unresolvable whenever
# the base commit is missing from the checkout, and the gate would report a
# clean scan of nothing at all.
#
# Zero commits is never a legitimate result for any caller here — every scope
# this repository scans contains at least one commit — so it is treated as the
# scanner failure it is.
if [ "${MODE}" = "git" ] && ! grep -Eq '(^|[^0-9])[1-9][0-9]* commits scanned' "${log}"; then
  echo "::error::gitleaks completed but walked ZERO commits over ${LABEL} — the range is empty or git rejected it; either way nothing was scanned. This is a SCANNER FAILURE, not a clean scan." >&2
  exit 1
fi

# THE OTHER HALF, and the zero-commit check does not cover it. A git error
# does not have to happen at the START of the walk. In v8.28.0 the git source
# streams commits to the detector and a failure mid-stream simply stops
# producing them; gitleaks then reports however many it had already seen and
# exits 0. A bad object twenty percent into `--all` therefore prints
#
#   ERR [git] fatal: bad object <sha>
#   INF 1500 commits scanned.
#   INF no leaks found
#
# which passes the zero-commit check and reads as a clean sweep of the whole
# repository. A TRUNCATED scan reported as complete is the same defect class as
# a zero-commit one, only harder to notice.
#
# Matched on git's own two truncating prefixes and NOT on every `[git]` line:
# gitleaks surfaces ordinary `warning:` chatter from git through the same ERR
# channel — a line-ending warning is the common one on this repository — and
# failing on those would redden the required gate for nothing.
if [ "${MODE}" = "git" ] && grep -Eq 'ERR .*\[git\] (fatal|error):' "${log}"; then
  echo "::error::gitleaks logged a git error over ${LABEL}; the commit walk stopped there, so the scan is TRUNCATED even though gitleaks exited 0. This is a SCANNER FAILURE, not a clean scan." >&2
  exit 1
fi

echo "gitleaks found nothing in ${LABEL}."
exit 0
