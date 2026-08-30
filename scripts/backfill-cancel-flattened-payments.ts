/**
 * One-off, idempotent backfill for Payment rows whose captured aggregate
 * `status` was flattened to FAILED by the pre-#1489 booking-cancel defect
 * (#1473 / #1506).
 *
 * The read path is already correct — the booking-vs-Xero repair pass
 * synthesizes captured state from the STRIPE mirror / ledger — so this is a
 * stored-data cleanup only. It restores each flattened row's `status` to the
 * exact captured status the repair pass already derives from the intact
 * `refundedAmountCents` mirror. It makes ZERO live-provider calls (no Xero, no
 * Stripe), touches only the `status` field, and is safe to re-run (a second
 * run finds nothing).
 *
 * Dry run by default. SAFE USAGE — run against a NON-PRODUCTION copy first:
 *
 *   DATABASE_URL='postgresql://user:pass@127.0.0.1:5432/scratch_copy' \
 *     npm run payments:backfill-cancel-flattened
 *
 * Only after reviewing the dry-run report, apply inside a transaction:
 *
 *   ... npm run payments:backfill-cancel-flattened -- --apply
 */
import "dotenv/config";
import process from "node:process";
import {
  backfillFlattenedCancelPayments,
  formatFlattenedCancelPaymentReport,
} from "../src/lib/cancel-flattened-payment-backfill";
import { prisma } from "../src/lib/prisma";

function printUsage() {
  console.log(`Usage:
  npm run payments:backfill-cancel-flattened               # dry run (default)
  npm run payments:backfill-cancel-flattened -- --dry-run  # explicit dry run
  npm run payments:backfill-cancel-flattened -- --apply    # write restorations

Options:
  --apply         Restore the flattened statuses inside a transaction.
                  Without it (the default) nothing is written.
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

  const result = await backfillFlattenedCancelPayments({ apply: args.apply });

  console.log(formatFlattenedCancelPaymentReport(result));

  if (args.json) {
    console.log("");
    console.log("---BEGIN CANCEL FLATTENED PAYMENT BACKFILL JSON---");
    console.log(JSON.stringify(result, null, 2));
    console.log("---END CANCEL FLATTENED PAYMENT BACKFILL JSON---");
  }
}

main()
  .catch((error) => {
    console.error(
      error instanceof Error
        ? error.message
        : "Unknown cancel-flattened-payment backfill error"
    );
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect().catch(() => {});
  });
