#!/usr/bin/env bash
# Reduced-load evidence on a fresh disposable stack only (#4940).
# Requires k6 and Docker; caller owns prepare/down so CI always tears down.
set -euo pipefail
cd "$(dirname "$0")/.."
export BASE_URL="${BASE_URL:-http://localhost:3001}"
export LOAD_TEST_CONFIRM_TARGET="${LOAD_TEST_CONFIRM_TARGET:-1}"
export PEAK_VUS=10
export LOAD_VOLUME_USERS="${LOAD_VOLUME_USERS:-${LOAD_VOLUME_MEMBERS:-2000}}"
# Reuse the seeder's domain instead of maintaining a second default in k6.
export LOAD_VOLUME_DOMAIN
LOAD_VOLUME_DOMAIN="$(pnpm exec tsx -e 'import { DEMO_SEED_DOMAIN } from "./src/lib/demo-seed-guard"; console.log(DEMO_SEED_DOMAIN)')"
export LOAD_USERS
LOAD_USERS="$(node --input-type=module -e 'import { volumeUserPool } from "./load/lib/volume-users.js"; console.log(volumeUserPool(Number(process.env.LOAD_VOLUME_USERS),process.env.LOAD_VOLUME_DOMAIN).join(","))')"
export LOAD_USER_PASSWORD="${DEMO_SEED_PASSWORD:-demo1234}"
export LOAD_ADMIN_PASSWORD="$LOAD_USER_PASSWORD"
export RAMP_UP=10s STEADY=30s RAMP_DOWN=10s
export MIXED_ITERATIONS=4
# Relative to this run, separate from the mixed/payment windows and demo data.
export CONTENTION_CHECKIN
CONTENTION_CHECKIN="$(node -e 'console.log(new Date(Date.now()+90*86400000).toISOString().slice(0,10))')"
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
