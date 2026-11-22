#!/usr/bin/env bash
# Sekreton's production typecheck job (#5053), run only where it can finish.
#
# A cold `pnpm run typecheck:src` needs more than 3 GB of V8 heap (measured
# 12 Nov 2026: out of memory under --max-old-space-size=3072, 4.6 GB peak
# uncapped). Sekreton's platform compute has 4 GB, so there it would be killed
# and fail every task. Owner decision (12 Nov 2026): run it on runners with
# enough memory, skip it with a clear message elsewhere, and prefer the owner's
# own runners in the project's compute order. PR CI runs the full typecheck
# either way.
#
# Usable memory is the smaller of /proc/meminfo's MemTotal and the cgroup
# limit, because inside a container MemTotal can report the host's memory.
set -euo pipefail

MIN_KB=$((6 * 1024 * 1024))

mem_kb=$(awk '/^MemTotal:/ { print $2 }' /proc/meminfo)
limit_bytes=""
if [ -r /sys/fs/cgroup/memory.max ]; then
  limit_bytes=$(cat /sys/fs/cgroup/memory.max)
elif [ -r /sys/fs/cgroup/memory/memory.limit_in_bytes ]; then
  limit_bytes=$(cat /sys/fs/cgroup/memory/memory.limit_in_bytes)
fi
# "max" (v2) or a huge number (v1) means no limit.
if [[ "$limit_bytes" =~ ^[0-9]+$ ]]; then
  limit_kb=$((limit_bytes / 1024))
  if [ "$limit_kb" -lt "$mem_kb" ]; then
    mem_kb=$limit_kb
  fi
fi

if [ "$mem_kb" -lt "$MIN_KB" ]; then
  echo "Skipped the production typecheck: this runner has $((mem_kb / 1024)) MiB, under the 6 GiB a cold run needs. PR CI runs the full typecheck."
  exit 0
fi

pnpm run typecheck:src
