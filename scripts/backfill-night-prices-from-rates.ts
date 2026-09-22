/**
 * Re-derive evenly-split night prices from the rate table (#3531 stage 3b,
 * programme #3527; owner decision D-3531-2).
 *
 * For every strand whose night rows are EVEN_SPLIT or UNKNOWN (integers that
 * reconcile to the guest's total but were never sold night by night), the
 * pricing engine is run over the booking's party as it was sold. A strand is
 * rewritten ONLY where the engine's per-night vector reproduces the stored
 * guest total to the cent; those rows become RATE_DERIVED. Everything else is
 * LISTED with a reason and never priced. No guest total, booking total or
 * member-visible figure changes. ZERO live-provider calls (no Xero, no Stripe,
 * no SES). Idempotent: a rewritten strand is no longer a candidate.
 *
 * WHEN IT MAY RUN. Only after a deploy has FULLY cut over to code that knows
 * RATE_DERIVED - never during a blue/green window. A colour whose generated
 * client predates the value cannot read a row that carries it, so a row
 * rewritten while both colours serve would fail the old colour's reads of that
 * booking. The script checks the enum value is present in the database and
 * refuses otherwise; it cannot see which colours are serving, so the operator
 * runbook is the second fence: run it from the new image, after the cutover.
 *
 * Dry run by default. SAFE USAGE - run against a NON-PRODUCTION copy first:
 *
 *   DATABASE_URL='postgresql://user:pass@127.0.0.1:5432/scratch_copy' \
 *     npm run bookings:backfill-night-prices-from-rates
 *
 * Only after reviewing the dry-run report, apply (each booking in its own
 * transaction, one audit row per booking):
 *
 *   ... npm run bookings:backfill-night-prices-from-rates -- --apply
 */
import "dotenv/config";
import process from "node:process";
import { z } from "zod";
import {
  formatRateDerivedBackfillReport,
  runRateDerivedNightPriceBackfill,
} from "../src/lib/rate-derived-night-price-backfill";
import { prisma } from "../src/lib/prisma";
import { decodeRawRows } from "../src/lib/raw-sql-rows";

function printUsage() {
  console.log(`Usage:
  npm run bookings:backfill-night-prices-from-rates                    # dry run (default)
  npm run bookings:backfill-night-prices-from-rates -- --dry-run       # explicit dry run
  npm run bookings:backfill-night-prices-from-rates -- --apply         # rewrite the derivable strands
  npm run bookings:backfill-night-prices-from-rates -- --booking <id>  # one booking only
  npm run bookings:backfill-night-prices-from-rates -- --limit <n>     # the n oldest candidate bookings

Options:
  --apply         Rewrite every strand the rate table reproduces, each booking
                  in its own transaction with an audit row. Without it (the
                  default) nothing is written.
  --booking <id>  Scope to one booking id.
  --limit <n>     Stop after the n oldest candidate bookings.
  --json          Emit machine-readable JSON alongside the report.
  --help, -h      Show this help.
`);
}

function parseArgs(argv: string[]) {
  const options: { apply: boolean; json: boolean; bookingId: string | null; limit: number | null } = {
    apply: false,
    json: false,
    bookingId: null,
    limit: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    }
    if (arg === "--apply") {
      options.apply = true;
      continue;
    }
    if (arg === "--dry-run") {
      options.apply = false;
      continue;
    }
    if (arg === "--json") {
      options.json = true;
      continue;
    }
    if (arg === "--booking") {
      const value = argv[i + 1];
      if (!value) throw new Error("--booking needs a booking id");
      options.bookingId = value;
      i += 1;
      continue;
    }
    if (arg === "--limit") {
      const value = Number(argv[i + 1]);
      if (!Number.isInteger(value) || value <= 0) throw new Error("--limit needs a positive integer");
      options.limit = value;
      i += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

/** The migration that adds RATE_DERIVED must be applied before any row can carry it. */
async function assertRateDerivedValueExists() {
  const returned = await prisma.$queryRaw`
    SELECT EXISTS (
      SELECT 1
      FROM pg_enum e
      JOIN pg_type t ON t.oid = e.enumtypid
      WHERE t.typname = 'BookingGuestNightPriceSource' AND e.enumlabel = 'RATE_DERIVED'
    ) AS present
  `;
  const [row] = decodeRawRows(returned, z.object({ present: z.boolean() }), "RATE_DERIVED enum check");
  if (!row?.present) {
    throw new Error(
      "The database does not know the RATE_DERIVED provenance yet: apply migration 20261005020000 first, and run this only after the deploy has fully cut over.",
    );
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  await assertRateDerivedValueExists();
  const result = await runRateDerivedNightPriceBackfill({
    apply: args.apply,
    bookingId: args.bookingId,
    limit: args.limit,
  });
  console.log(`Mode: ${result.mode}`);
  console.log(formatRateDerivedBackfillReport(result.plans));
  if (result.mode === "apply") {
    console.log(
      `Applied: ${result.applied.length} booking(s), ${result.applied.reduce((n, a) => n + a.rows, 0)} night row(s)`,
    );
    if (result.raced.length > 0) {
      console.log(`Raced (rolled back, re-run to retry): ${result.raced.join(", ")}`);
    }
  }
  if (args.json) {
    console.log("");
    console.log("---BEGIN RATE-DERIVED NIGHT PRICE BACKFILL JSON---");
    console.log(JSON.stringify(result, null, 2));
    console.log("---END RATE-DERIVED NIGHT PRICE BACKFILL JSON---");
  }
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : "Unknown rate-derived night price backfill error");
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect().catch(() => {});
  });
