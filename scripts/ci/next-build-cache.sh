#!/usr/bin/env bash
# Carry Next.js's build cache between CI runners.
#
#   scripts/ci/next-build-cache.sh seed <dir>     # <dir> -> the builder's cache mount
#   scripts/ci/next-build-cache.sh export <dir>   # the builder's cache mount -> <dir>
#
# The Dockerfile builds with `.next/cache` as a BuildKit cache mount (id
# `tacbookings-next-build`), so Turbopack's build cache survives between builds
# on one machine. A hosted runner starts with an empty builder, so `e2e.yml`
# restores <dir> with actions/cache, seeds it into the mount before the image
# build, and exports it back afterwards for the next run to restore. A cache
# mount cannot be reached any other way: it is not part of any image or layer.
#
# Both directions are throwaway builds on the current buildx builder, the one
# the image build uses. The cache-bust argument makes the copy run every time
# rather than being satisfied from the layer cache. A missing or empty <dir>
# seeds nothing; a cold mount exports an empty <dir>. Neither is an error: the
# image build is correct either way, only slower.
set -euo pipefail

cd "$(dirname "$0")/../.."

MOUNT="type=cache,id=tacbookings-next-build,target=/app/.next/cache,sharing=locked"
# The Dockerfile's own base image, so these builds pull nothing the image build
# does not.
BASE_IMAGE="$(sed -n 's/^FROM \([^ ]*\) AS base$/\1/p' Dockerfile)"
if [[ -z "$BASE_IMAGE" ]]; then
  echo "next-build-cache: could not read the base image from Dockerfile." >&2
  exit 1
fi

mode="${1:-}"
dir="${2:-}"
if [[ -z "$dir" || ( "$mode" != "seed" && "$mode" != "export" ) ]]; then
  echo "Usage: $0 {seed|export} <dir>" >&2
  exit 1
fi
bust="$(date +%s%N)"

if [[ "$mode" == "seed" ]]; then
  mkdir -p "$dir"
  docker buildx build --progress=plain --output type=cacheonly --build-arg "CACHE_BUST=$bust" -f - "$dir" <<EOF
FROM $BASE_IMAGE
ARG CACHE_BUST
RUN --mount=$MOUNT --mount=type=bind,source=.,target=/seed \\
  find /app/.next/cache -mindepth 1 -delete && cp -a /seed/. /app/.next/cache/ && du -sh /app/.next/cache
EOF
else
  rm -rf "$dir"
  mkdir -p "$dir"
  empty="$(mktemp -d)"
  docker buildx build --progress=plain --output "type=local,dest=$dir" --build-arg "CACHE_BUST=$bust" -f - "$empty" <<EOF
FROM $BASE_IMAGE AS copy
ARG CACHE_BUST
RUN --mount=$MOUNT mkdir /out && cp -a /app/.next/cache/. /out/ && du -sh /out
FROM scratch
COPY --from=copy /out /
EOF
  rmdir "$empty"
  du -sh "$dir"
fi
