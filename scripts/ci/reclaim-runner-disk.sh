#!/usr/bin/env bash
# Reclaim disk on a hosted GitHub runner before building a Docker image (#3424).
#
# WHY THIS FILE EXISTS. A hosted runner ships roughly 14 GB free, and this
# project's app image no longer fits one build of it comfortably. Six image
# builds across three workflows had no reclaim step at all:
#
#   * `e2e.yml`               - the app image, twice (`playwright`, `multi-lodge`)
#   * `ci.yml` -> `docker-image-security`  - the app image, for the Trivy gate
#   * `ci.yml` -> `publish-ghcr-images`    - the app image AND the migrate image,
#     on ONE runner, the second at `target: builder`, deliberately the fattest
#     stage in the Dockerfile: it carries the full `node_modules`, the complete
#     Next build and the sources the runtime stage discards
#   * `e2e-rollover-proof.yml` - the app image again
#
# Several of those also export every intermediate layer with `cache-to:mode=max`,
# which must materialise locally before it uploads.
#
# THE MEASURED FAILURE, from a deployment fork porting 423dcaf94:
#
#   Unhandled exception. System.IO.IOException: No space left on device :
#   '/home/runner/actions-runner/cached/2.337.0/_diag/Worker_....log'
#
# Note what that path names: the runner's OWN diagnostic log, not anything in
# this repository. The runner ran out of disk while writing its own trace, so the
# failure surfaced as an unhandled .NET exception rather than as a build error -
# which is exactly why this is easy to misread as infrastructure flakiness.
#
# A related symptom worth knowing: a runner that dies of disk cannot upload its
# log. If a job fails and its log comes back `BlobNotFound` while sibling jobs in
# the same run return theirs normally, disk is a reasonable first hypothesis -
# though NOT a conclusion. The same fork filed, then corrected, a diagnosis that
# leaned on that signal alone, and a job it had blamed on disk later succeeded
# unaided. A good hint, not proof.
#
# WHY ONE SCRIPT RATHER THAN SIX COPIES OF THE SAME YAML. The issue proposed an
# inline `run:` block at each build. Six copies of one rule is the shape
# `INV-SSOT` exists to prevent: the next person to add a path to reclaim would
# have to find all six, and the sixth would be missed. One file, six callers -
# the same arrangement `scripts/ci/gitleaks-scan.sh` uses for the secret scan.
#
# WHY EVERY REMOVAL TOLERATES ABSENCE. `|| true` throughout, deliberately. This
# step exists to BUY space, not to assert what a runner image ships. A path that
# a future runner image stops shipping must not fail the build.
#
# THE CONSEQUENCE OF THAT, AND WHY THE `df` LINES ARE NOT DECORATION. If a runner
# ever ships none of these, the step frees nothing and says nothing - it is
# silent by construction. The `df -h /` either side is what makes the margin
# READABLE IN THE LOG rather than inferred the next time it gets tight. Do not
# remove them to tidy the output.
#
# CALL IT IMMEDIATELY BEFORE THE BUILD, not at job start, so it also clears
# whatever earlier steps in the same job left behind.

# No `set -e`: every reclaim below is best-effort by design (see above), and a
# failure to delete something must not fail the build. `-u` still catches a typo
# in a variable name, and every optional variable is defaulted explicitly.
set -uo pipefail

echo "::group::Disk before reclaim"
df -h /
echo "::endgroup::"

# Preinstalled toolchains none of these jobs use. Roughly 25 GB in total on a
# current `ubuntu-latest` image; see the note above about why none of this is
# allowed to fail the build.
sudo rm -rf /usr/share/dotnet || true
sudo rm -rf /usr/local/lib/android || true
sudo rm -rf /opt/ghc || true
sudo rm -rf /usr/local/share/boost || true
# Guarded rather than interpolated bare. `sudo rm -rf ""` is merely noisy, but
# this is a recursive sudo delete of a path that comes from the environment, and
# the cost of being careful here is one `if`.
tools_dir="${AGENT_TOOLSDIRECTORY:-}"
if [ -n "$tools_dir" ] && [ "$tools_dir" != "/" ] && [ -d "$tools_dir" ]; then
  sudo rm -rf "$tools_dir" || true
fi

# Anything a previous step in this job already pulled or built. Harmless on a
# clean runner; the point is the `publish-ghcr-images` job, which builds a second
# image on the same runner as the first.
docker system prune -af --volumes || true

echo "::group::Disk after reclaim"
df -h /
echo "::endgroup::"
