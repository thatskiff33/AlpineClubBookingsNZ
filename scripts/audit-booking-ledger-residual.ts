/**
 * Read-only census of the booking ledger identity (`INV-PAY-047`, #3340).
 *
 * For every live booking with a captured payment it asks the one question the
 * whole of #3340 is about:
 *
 *   finalPrice + changeFees - (captured - refunded) - credit - uncollected ask
 *
 * A residual of **zero** is the books balancing. A **positive** residual is the
 * #3340 class - money the price says is owed that nothing is asking for, which is
 * what a delta-sized ask used to produce when it superseded an unpaid one. A
 * **negative** residual is the club holding more than the price, which is normal
 * after a policy-tiered reduction (`INV-MOD-011` keeps a slice) or a reduction
 * settled as account credit.
 *
 * REPORT ONLY - IT NEVER WRITES, AND IT NEVER REPAIRS. That is the owner's
 * decision of 8 Sep 2026: the affected population was two rows, already handled
 * by hand, and repair code for it would be risk with no benefit. This reports;
 * a person decides.
 *
 * The SQL is not written here. It is generated from
 * `BOOKING_LEDGER_IDENTITY_TERMS`, the same signed term table the CI census
 * guard folds, so the operator's query and the guard cannot say different things
 * (`INV-SSOT-001`).
 *
 * SAFE USAGE - run against a NON-PRODUCTION copy:
 *
 *   DATABASE_URL='postgresql://user:pass@127.0.0.1:5432/scratch_copy' \
 *     npm run payments:audit-booking-ledger
 */
import "dotenv/config";
import process from "node:process";
import { z } from "zod";

import {
  bookingLedgerCensusSql,
  bookingLedgerVerdict,
} from "../src/lib/additional-payment-ask";
import { prisma } from "../src/lib/prisma";
import { decodeRawRows, rawIntColumn } from "../src/lib/raw-sql-rows";
import { formatCents } from "../src/lib/utils";

/**
 * `INV-OPS-001`: the row shape is VALIDATED, never asserted by a cast. Raw SQL
 * hands back physical column names and a wrong belief about them arrives as
 * `undefined`, which is falsy in exactly the comparisons that guard money.
 */
const CENSUS_ROW = z.object({
  bookingId: z.string(),
  bookingStatus: z.string(),
  finalPriceCents: rawIntColumn,
  changeFeeCents: rawIntColumn,
  amountCents: rawIntColumn,
  refundedAmountCents: rawIntColumn,
  creditAppliedCents: rawIntColumn,
  additionalAmountCents: rawIntColumn,
  additionalPaymentStatus: z.string().nullable(),
  residualCents: rawIntColumn,
});

function printUsage() {
  console.log(`Usage:
  npm run payments:audit-booking-ledger            # read-only census (default)
  npm run payments:audit-booking-ledger -- --sql   # print the SQL and exit
  npm run payments:audit-booking-ledger -- --json  # also emit machine-readable JSON

This census is read-only. It never writes and never calls Xero/Stripe/SES.

Options:
  --sql           Print the generated SELECT (to run by hand) and exit.
  --json          Emit machine-readable JSON alongside the human report.
  --help, -h      Show this help.
`);
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    printUsage();
    return;
  }
  if (argv.includes("--sql")) {
    console.log(bookingLedgerCensusSql());
    return;
  }

  const returned = await prisma.$queryRawUnsafe(bookingLedgerCensusSql());
  const rows = decodeRawRows(returned, CENSUS_ROW, "booking ledger census");

  const unasked = rows.filter(
    (row) => bookingLedgerVerdict(row.residualCents) === "unasked",
  );
  const retained = rows.filter(
    (row) => bookingLedgerVerdict(row.residualCents) === "retained",
  );

  console.log("Booking ledger census (INV-PAY-047) - read only\n");
  console.log(
    `${unasked.length} booking(s) are owed money nobody is asking for; ${retained.length} hold more than the price (normally a policy-retained or credit-settled reduction).\n`,
  );

  for (const [title, group] of [
    ["Money nobody is asking for", unasked],
    ["Club holds more than the price", retained],
  ] as const) {
    if (group.length === 0) continue;
    console.log(`## ${title}`);
    for (const row of group) {
      console.log(
        `  ${row.bookingId}  ${row.bookingStatus.padEnd(16)} residual ${formatCents(row.residualCents)}` +
          `  (price ${formatCents(row.finalPriceCents)}, fees ${formatCents(row.changeFeeCents)},` +
          ` captured ${formatCents(row.amountCents)}, refunded ${formatCents(row.refundedAmountCents)},` +
          ` credit ${formatCents(row.creditAppliedCents)}, ask ${formatCents(row.additionalAmountCents)}` +
          ` [${row.additionalPaymentStatus ?? "none"}])`,
      );
    }
    console.log("");
  }

  if (argv.includes("--json")) {
    console.log(JSON.stringify({ unasked, retained }, null, 2));
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
