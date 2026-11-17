#!/usr/bin/env bash
# Reduced-load evidence on a fresh disposable stack only (#4940).
# Requires k6 and Docker; caller owns prepare/down so CI always tears down.
set -euo pipefail
cd "$(dirname "$0")/.."
# The target opt-in stays the caller's: the guard's confirmation step is not
# defaulted here.
if [[ "${LOAD_TEST_CONFIRM_TARGET:-}" != "1" ]]; then
  echo "Set LOAD_TEST_CONFIRM_TARGET=1 once BASE_URL is confirmed to be the disposable load stack." >&2
  exit 1
fi
bash scripts/load-stack.sh require-running
# Every value below comes from the running stack, not from a copy kept here: the
# stack's own app port, its member count and the password its seeders hashed.
# (BASE_URL may still be set by the caller; the k6 target guard checks it either way.)
BASE_URL="${BASE_URL:-$(bash scripts/load-stack.sh base-url)}"
export BASE_URL
export PEAK_VUS=10
LOAD_VOLUME_USERS="${LOAD_VOLUME_USERS:-$(bash scripts/load-stack.sh volume-members)}"
export LOAD_VOLUME_USERS
# Reuse the seeder's domain instead of maintaining a second default in k6.
export LOAD_VOLUME_DOMAIN
LOAD_VOLUME_DOMAIN="$(pnpm exec tsx -e 'import { DEMO_SEED_DOMAIN } from "./src/lib/demo-seed-guard"; console.log(DEMO_SEED_DOMAIN)')"
# The read scenarios take one account per VU, so the pool is PEAK_VUS long. A
# pool the size of the whole history would also outgrow one environment
# variable (128 KiB on Linux) at about four thousand members.
export LOAD_USERS
LOAD_USERS="$(node --input-type=module -e 'import { volumeUserPool } from "./load/lib/volume-users.js"; const n = Math.min(Number(process.env.LOAD_VOLUME_USERS), Number(process.env.PEAK_VUS)); console.log(volumeUserPool(n, process.env.LOAD_VOLUME_DOMAIN).join(","))')"
LOAD_USER_PASSWORD="$(bash scripts/load-stack.sh demo-password)"
export LOAD_USER_PASSWORD
export LOAD_ADMIN_PASSWORD="$LOAD_USER_PASSWORD"
export RAMP_UP=10s STEADY=30s RAMP_DOWN=10s
export MIXED_ITERATIONS=4
# CONTENTION_CHECKIN is left to its default, a night 116 days out that is clear
# of the mixed and payment windows and the seeded demo data (load/lib/stay-window.js).
mkdir -p .artifacts/load
bash scripts/load-stack.sh profile > .artifacts/load/profile.json
failed=0
run_scenario() {
  local name="$1" suffix="${2:-}"
  if ! k6 run --summary-export ".artifacts/load/${name}${suffix}.json" "load/scenarios/${name}.js"; then
    failed=1
  fi
}
for scenario in public-browse login member-dashboard booking-contention mixed-writes admin-reads payment-path; do
  run_scenario "$scenario"
done
bash scripts/load-stack.sh cron-on
# Read only the generated local secret; never pass a provider key to k6.
export CRON_SECRET
CRON_SECRET="$(bash scripts/load-stack.sh cron-secret)"
run_scenario cron-overlap
exit "$failed"
