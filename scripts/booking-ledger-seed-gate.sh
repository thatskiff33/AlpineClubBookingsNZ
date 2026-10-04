#!/usr/bin/env bash
# The booking ledger's cut-over gate, run in CI over a seeded history (#3583 PR 2;
# design docs/design/booking-ledger.md §6, §7). The same commands, in the same
# order, as the owner's runbook (docs/MAINTENANCE.md, "Booking ledger: back-post
# and cut-over gate"), against a throwaway database:
#
#   seed (real writers, lines stripped) -> census (must be SHUT) -> back-post dry
#   run -> --apply -> --apply again (must post nothing) -> acknowledgement draft
#   (expected classes only; never KNOWN_DEFECT_HISTORY) -> census --acknowledged
#   --fail-on-gap (must be OPEN).
#
# Usage: scripts/booking-ledger-seed-gate.sh <database-url>
#   The URL must pass the race-database guard (loopback, port 55442+, a name
#   containing concurrency_race_1881); the database must not exist yet.
set -euo pipefail

url="${1:?usage: $0 <database-url>}"
admin_url="${url%/*}/postgres"
database="${url##*/}"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

# The classes the seeded history is built to show, and nothing else: a completed
# hand-back on a cash booking names its refunded column (design §6).
expected_classes='["REFUND_MIRROR_HAND_BACK"]'

echo "==> Creating and migrating ${database}"
psql "$admin_url" -v ON_ERROR_STOP=1 -c "CREATE DATABASE \"${database}\""
DATABASE_URL="$url" pnpm exec prisma migrate deploy

echo "==> Seeding the history through the real writers"
SEED_BOOKING_LEDGER_HISTORY=1 CONCURRENCY_RACE_DATABASE_URL="$url" \
  pnpm exec vitest run src/lib/__tests__/booking-ledger-history-seed.realdb.test.ts

export DATABASE_URL="$url"

echo "==> Census before the back-post: the gate must be shut"
if pnpm run --silent booking-ledger:census --fail-on-gap > "$work/census-before.txt"; then
  cat "$work/census-before.txt"
  echo "The census passed a history with no lines: it is not measuring anything." >&2
  exit 1
fi

echo "==> Back-post, dry run"
pnpm run --silent booking-ledger:back-post | tee "$work/dry-run.txt"

echo "==> Back-post, --apply"
pnpm run --silent booking-ledger:back-post --apply | tee "$work/apply.txt"

echo "==> Back-post, --apply again: must post nothing"
pnpm run --silent booking-ledger:back-post --apply | tee "$work/apply-again.txt"
if ! grep -q "posted: 0 (0 line(s))" "$work/apply-again.txt"; then
  echo "A second --apply posted lines: the back-post is not idempotent." >&2
  exit 1
fi

echo "==> Acknowledgement draft, expected classes only"
pnpm run --silent booking-ledger:census --write-acknowledgement-draft "$work/acknowledged.json" > /dev/null
node -e '
  const [draftPath, expectedJson] = process.argv.slice(1);
  const draft = JSON.parse(require("node:fs").readFileSync(draftPath, "utf8"));
  const expected = new Set(JSON.parse(expectedJson));
  const unexpected = draft.filter((entry) => !expected.has(entry.class));
  if (unexpected.length > 0 || draft.length === 0) {
    console.error("The draft names classes the seeded history was not built to show:", JSON.stringify(unexpected.length > 0 ? unexpected : draft));
    process.exit(1);
  }
  console.log(`Acknowledging ${draft.length} expected class instance(s).`);
' "$work/acknowledged.json" "$expected_classes"

echo "==> Census after the back-post: the gate must be open"
pnpm run --silent booking-ledger:census --acknowledged "$work/acknowledged.json" --fail-on-gap
