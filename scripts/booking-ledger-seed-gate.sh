#!/usr/bin/env bash
# The booking ledger's cut-over gate, run in CI over a seeded history (#3583 PR 2;
# design docs/design/booking-ledger.md §6, §7). The same commands, in the same
# order, as the owner's runbook (docs/MAINTENANCE.md, "Back-post the booking
# ledger and open the cut-over gate"), against a throwaway database:
#
#   seed (real writers, lines stripped) -> census (must be SHUT, not crash) ->
#   back-post dry run -> --apply -> --apply again (must post nothing) ->
#   acknowledgement draft (must be exactly the class instances the history is
#   built to show; never KNOWN_DEFECT_HISTORY) -> census --acknowledged
#   --fail-on-gap (must be OPEN). The database is dropped on exit.
#
# Usage: scripts/booking-ledger-seed-gate.sh <database-url>
#   The URL must pass the race-database guard (loopback, port 55442+, never 5432,
#   a name containing concurrency_race_1881); the database must not exist yet.
set -euo pipefail

url="${1:?usage: $0 <database-url>}"

# The race-database guard (src/lib/__tests__/support/race-db-url.ts), BEFORE
# anything is created, migrated or dropped.
if [[ ! "$url" =~ ^postgresql://[^@/]+@(127\.0\.0\.1|localhost):([0-9]+)/([A-Za-z0-9_]+)$ ]]; then
  echo "Refusing that URL: a loopback postgresql://user:pass@127.0.0.1:<port>/<name> URL is required." >&2
  exit 1
fi
port="${BASH_REMATCH[2]}"
database="${BASH_REMATCH[3]}"
if (( port == 5432 || port < 55442 )); then
  echo "Refusing port ${port}: use a throwaway PostgreSQL on 55442+ (never 5432)." >&2
  exit 1
fi
if [[ "$database" != *concurrency_race_1881* ]]; then
  echo "Refusing database ${database}: its name must contain concurrency_race_1881." >&2
  exit 1
fi
admin_url="${url%/*}/postgres"
work="$(mktemp -d)"

# The class instances the seeded history is built to show, and nothing else,
# each to the cent: the completed hand-back on the cash cancellation names its
# refunded column (design §6).
expected_acknowledgements='[{"bookingId":"seed-3583-cash-cancel-handback","class":"REFUND_MIRROR_HAND_BACK","cents":10000}]'

created=0
cleanup() {
  rm -rf "$work"
  if (( created == 1 )); then
    psql "$admin_url" -v ON_ERROR_STOP=1 -q -c "DROP DATABASE IF EXISTS \"${database}\" WITH (FORCE)" || true
  fi
}
trap cleanup EXIT

echo "==> Creating and migrating ${database}"
psql "$admin_url" -v ON_ERROR_STOP=1 -c "CREATE DATABASE \"${database}\""
created=1
DATABASE_URL="$url" pnpm exec prisma migrate deploy

echo "==> Seeding the history through the real writers"
SEED_BOOKING_LEDGER_HISTORY=1 CONCURRENCY_RACE_DATABASE_URL="$url" \
  pnpm exec vitest run src/lib/__tests__/booking-ledger-history-seed.realdb.test.ts

export DATABASE_URL="$url"

echo "==> Census before the back-post: the gate must be shut (exit 2), never crash"
set +e
pnpm run --silent booking-ledger:census --fail-on-gap > "$work/census-before.txt" 2>&1
status=$?
set -e
if (( status != 2 )); then
  cat "$work/census-before.txt"
  if (( status == 0 )); then
    echo "The census passed a history with no lines: it is not measuring anything." >&2
  else
    echo "The census failed (exit ${status}) instead of reporting a shut gate." >&2
  fi
  exit 1
fi

echo "==> Back-post, dry run"
pnpm run --silent booking-ledger:back-post | tee "$work/dry-run.txt"

echo "==> Back-post, --apply"
pnpm run --silent booking-ledger:back-post --apply --confirm-database "$database" | tee "$work/apply.txt"

echo "==> Back-post, --apply again: must post nothing"
pnpm run --silent booking-ledger:back-post --apply --confirm-database "$database" | tee "$work/apply-again.txt"
if ! grep -q "posted: 0 (0 line(s))" "$work/apply-again.txt"; then
  echo "A second --apply posted lines: the back-post is not idempotent." >&2
  exit 1
fi

echo "==> Acknowledgement draft: exactly the expected class instances"
pnpm run --silent booking-ledger:census --write-acknowledgement-draft "$work/acknowledged.json" > /dev/null
node -e '
  const [draftPath, expectedJson] = process.argv.slice(1);
  const draft = JSON.parse(require("node:fs").readFileSync(draftPath, "utf8"));
  const key = (entry) => `${entry.bookingId}|${entry.class}|${entry.cents}`;
  const found = draft.map(key).sort();
  const expected = JSON.parse(expectedJson).map(key).sort();
  if (JSON.stringify(found) !== JSON.stringify(expected)) {
    console.error(`The draft is not the history the seed builds.\n  expected ${JSON.stringify(expected)}\n  found    ${JSON.stringify(found)}`);
    process.exit(1);
  }
  console.log(`Acknowledging ${draft.length} expected class instance(s).`);
' "$work/acknowledged.json" "$expected_acknowledgements"

echo "==> Census after the back-post: the gate must be open"
pnpm run --silent booking-ledger:census --acknowledged "$work/acknowledged.json" --fail-on-gap
