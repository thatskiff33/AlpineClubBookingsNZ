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
# reads green.
#
# A bump is an edit HERE and in the pin the census asserts — the literal in
# `deployment-image-contracts.test.ts`, which is a guard rather than a second
# home, and which is what makes an unnoticed bump fail.
#
# What that census actually walks, stated exactly rather than as "nowhere
# else": every `.yml`/`.yaml` under `.github/workflows/` and `.github/actions/`,
# every `.sh`/`.mjs`/`.ts`/`.js` under `scripts/`, and the three documents that
# discuss the scanner — `SECURITY.md`, `docs/MAINTENANCE.md` and
# `docs/SECURITY-ATTACK-SURFACE.md`. A file outside those paths is not checked,
# so a version literal written into, say, a `docs/guides/` page would not be
# caught; the rule is still that nothing but this file names the container.
#
# Source it; do not execute it:
#
#   . "$(dirname "${BASH_SOURCE[0]}")/gitleaks-image.sh"
#
# `deployment-image-contracts.test.ts` asserts this is the only file it walks
# that names a `ghcr.io/gitleaks/gitleaks:` tag, apart from its own pinned
# literal. The walk's exact scope is above.
# Pinned by DIGEST as well as tag. A tag is a pointer the publisher can move,
# so a file whose whole job is to be the one immutable home should not rely on
# one; the tag stays in the name so a human can read which release this is, and
# the digest is what docker actually resolves. Re-take it with
# `docker inspect --format '{{index .RepoDigests 0}}' <image>:<tag>` when the
# version moves.
GITLEAKS_IMAGE=ghcr.io/gitleaks/gitleaks:v8.28.0@sha256:cdbb7c955abce02001a9f6c9f602fb195b7fadc1e812065883f695d1eeaba854
