# The pinned gitleaks scanner, written down ONCE (#2852, `INV-SSOT`).
#
# Two things scan this repository for secrets and they must never be a version
# apart: the REQUIRED `Secret scan (gitleaks)` gate in `.github/workflows/ci.yml`,
# which blocks a merge, and the advisory scheduled sweep in
# `.github/workflows/gitleaks-scheduled.yml`, which walks every branch. #2686
# found the previous pair of jobs running 8.24.3 and 8.28.0 over the same
# commits and disagreeing about which tool was enforcing the gate; this file is
# what makes that unrepresentable rather than merely discouraged.
#
# Deliberately NOT `${GITLEAKS_IMAGE:-...}`. An overridable default is how the
# drift comes back: a workflow sets its own `env: GITLEAKS_IMAGE:`, this file
# yields to it, and the two scanners are different again while every guard still
# reads green. A bump is an edit HERE and nowhere else.
#
# Source it; do not execute it:
#
#   . "$(dirname "${BASH_SOURCE[0]}")/gitleaks-image.sh"
#
# `deployment-image-contracts.test.ts` asserts this is the only file under
# `.github/workflows/` or `scripts/` that names a `ghcr.io/gitleaks/gitleaks:`
# tag.
GITLEAKS_IMAGE=ghcr.io/gitleaks/gitleaks:v8.28.0
