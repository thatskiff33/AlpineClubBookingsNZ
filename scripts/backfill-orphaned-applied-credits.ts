/**
 * One-off, idempotent backfill for account credit a member applied to a booking
 * that was never restored when the booking was cancelled (the pre-#1547
 * defect): applying credit, abandoning payment, then cancelling left the
 * negative BOOKING_APPLIED MemberCredit row on the ledger, so the member
 * permanently lost that credit.
 *
 * This restores 100% of the applied credit (ledger truth) for each orphaned
 * CANCELLED booking, writing a CANCELLATION_REFUND reversal row, a critical
 * finance audit row, and a CREDITED booking event. It makes ZERO live-provider
 * calls (no Xero, no Stripe, no SES) and is safe to re-run — the under-lock
 * predicate re-check makes a second run find nothing.
 *
 * Dry run by default. SAFE USAGE — run against a NON-PRODUCTION copy first:
 *
 *   DATABASE_URL='postgresql://user:pass@127.0.0.1:5432/scratch_copy' \
 *     npm run payments:backfill-orphaned-credits
 *
 * Only after reviewing the dry-run report, apply (each booking in its own
 * transaction):
 *
 *   ... npm run payments:backfill-orphaned-credits -- --apply
 */
import "dotenv/config";
import process from "node:process";
import {
  findOrphanedAppliedCredits,
  formatOrphanedAppliedCreditReport,
  healOrphanedAppliedCredits,
} from "../src/lib/orphaned-applied-credit-backfill";
import { prisma } from "../src/lib/prisma";

function printUsage() {
  console.log(`Usage:
  npm run payments:backfill-orphaned-credits               # dry run (default)
  npm run payments:backfill-orphaned-credits -- --dry-run  # explicit dry run
  npm run payments:backfill-orphaned-credits -- --apply    # restore orphaned credit

Options:
  --apply         Restore the orphaned applied credit, each booking in its own
                  transaction. Without it (the default) nothing is written.
  --json          Emit machine-readable JSON alongside the report.
  --help, -h      Show this help.
`);
}

function parseArgs(argv: string[]) {
  const options = { apply: false, json: false };

  for (const arg of argv) {
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
    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const result = args.apply
    ? await healOrphanedAppliedCredits()
    : await findOrphanedAppliedCredits();

  console.log(
    formatOrphanedAppliedCreditReport(result, args.apply ? "apply" : "dry-run")
  );

  if (args.json) {
    console.log("");
    console.log("---BEGIN ORPHANED APPLIED CREDIT BACKFILL JSON---");
    console.log(JSON.stringify(result, null, 2));
    console.log("---END ORPHANED APPLIED CREDIT BACKFILL JSON---");
  }
}

main()
  .catch((error) => {
    console.error(
      error instanceof Error
        ? error.message
        : "Unknown orphaned-applied-credit backfill error"
    );
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect().catch(() => {});
  });
