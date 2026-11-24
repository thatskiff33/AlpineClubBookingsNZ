#!/usr/bin/env bash
# Disposable, loopback-only PostgreSQL proof for #4324, #3403, #4930 and #4069 in Sekreton.
set -euo pipefail

# The cluster start lives in one sourced helper (INV-SSOT); it sets pg_dir,
# pg_port and pg_runner and stops the cluster on exit. The suite safety guard
# requires loopback, port 55442+ (the helper's range), and this DB marker.
# shellcheck source=scripts/ci/disposable-postgres.sh
source "$(dirname "${BASH_SOURCE[0]}")/disposable-postgres.sh"
start_disposable_postgres kept-change-realdb
race_dir=$pg_dir
race_port=$pg_port
"${pg_runner[@]}" createdb -h 127.0.0.1 -p "$race_port" -U postgres concurrency_race_1881
export DATABASE_URL="postgresql://postgres@127.0.0.1:$race_port/concurrency_race_1881"
export CONCURRENCY_RACE_DATABASE_URL="$DATABASE_URL"
export RUN_CONCURRENCY_RACE_TESTS=1
export TMPDIR=/tmp/scratch
export NODE_OPTIONS=--max-old-space-size=1800
# Regenerate the client from this tree's schema: a workspace generated before a
# merge added an enum value rejects it client-side (PrismaClientValidationError).
pnpm run db:generate
pnpm run db:migrate
files=(
  # #4069: cash-cover evidence and snapshot coherence over the real writers.
  src/lib/__tests__/booking-cash-evidence.realdb.test.ts
  src/lib/__tests__/kept-change-capture-record.realdb.test.ts
  src/lib/__tests__/superseded-ask-invoice-carry.realdb.test.ts
  src/lib/__tests__/additional-capture-receipt.realdb.test.ts
  src/lib/__tests__/additional-capture-receipt-legs.realdb.test.ts
  src/lib/__tests__/primary-invoice-edit-race.realdb.test.ts
  src/lib/__tests__/unpaid-edit-change-fee-owed.realdb.test.ts
  src/lib/__tests__/price-preserving-edit-preview-save.realdb.test.ts
  src/lib/__tests__/edit-quoted-figures.realdb.test.ts
  # #4930: exercise reconciliation, cancellation and group settlement after
  # moving their shared imports; a skipped suite is rejected below.
  src/lib/__tests__/capacity-race-refund-shortfall-task.realdb.test.ts
  src/lib/__tests__/booking-ledger-cancellation.realdb.test.ts
  src/lib/__tests__/booking-ledger-group-settlement.realdb.test.ts
  # #5255: the once-ever alert sweep's give-back against the alert's email row.
  src/lib/__tests__/admin-alert-once-sweep.realdb.test.ts
)
# An explicit report plus the existing validator rejects green describe.skip.
pnpm exec vitest run --maxWorkers=1 --reporter=json --outputFile="$race_dir/report.json" "${files[@]}"
node --input-type=module - "$race_dir/report.json" "${files[@]}" <<'JS'
import { readFileSync } from "node:fs";
import { unexercisedRealdbFiles } from "./scripts/ci/check-realdb-ran.mjs";
const [, , report, ...files] = process.argv;
const problems = unexercisedRealdbFiles(JSON.parse(readFileSync(report, "utf8")), files);
if (problems.length) throw new Error(problems.join("\n"));
console.log(`All ${files.length} kept-change and adjacent PostgreSQL suites ran with no skips.`);
JS
