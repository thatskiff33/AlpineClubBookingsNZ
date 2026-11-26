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
 * what a delta-sized ask produced when it superseded an unpaid one, unless it
 * is on an Internet Banking booking whose Xero invoice is linked or still going
 * out: that invoice asks for it, so it is listed apart (#5288). A
 * **negative** residual is the club holding more than the price, which is normal
 * after a policy-tiered reduction (`INV-MOD-011` keeps a slice) or a reduction
 * settled as account credit.
 *
 * REPORT ONLY - IT NEVER WRITES, AND IT NEVER REPAIRS. That is the owner's
 * decision of 8 Sep 2026: the affected population was two rows, already handled
 * by hand, and repair code for it would be risk with no benefit. This reports;
 * a person decides.
 *
 * IT READS TYPED, NOT RAW (`INV-OPS-001`, "lock raw, read typed"). The arithmetic
 * is `bookingLedgerResidualCents`, the same function the CI census guard calls,
 * read through `loadBookingLedgerCensus` (`src/lib/booking-ledger-census.ts`), so
 * the operator's answer and the guard's answer are one implementation rather than
 * two. `--sql` prints the EQUIVALENT statement for an operator who would rather
 * run it against a read-only replica; that statement is not written by hand
 * either - it is folded from `BOOKING_LEDGER_IDENTITY_TERMS`, the same signed
 * term table (`INV-SSOT-001`).
 *
 * SAFE USAGE - run against a NON-PRODUCTION copy:
 *
 *   DATABASE_URL='postgresql://user:pass@127.0.0.1:5432/scratch_copy' \
 *     pnpm run payments:audit-booking-ledger
 */
import "dotenv/config";
import process from "node:process";

import { bookingLedgerCensusSql } from "../src/lib/additional-payment-ask";
import { loadBookingLedgerCensus } from "../src/lib/booking-ledger-census";
import { prisma } from "../src/lib/prisma";
import { getClubFormat } from "../src/lib/club-format-settings";
import { formatCents } from "../src/lib/utils";

function printUsage() {
  console.log(`Usage:
  pnpm run payments:audit-booking-ledger            # read-only census (default)
  pnpm run payments:audit-booking-ledger --sql   # print the equivalent SQL and exit
  pnpm run payments:audit-booking-ledger --json  # also emit machine-readable JSON

This census is read-only. It never writes and never calls Xero/Stripe/SES.

Options:
  --sql           Print the equivalent SELECT, to run against a read-only replica.
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

  // The club's format (#3565), read once before the census query.
  const format = await getClubFormat();
  const rows = await loadBookingLedgerCensus();
  const unasked = rows.filter((row) => row.verdict === "unasked");
  // #5288: owed on an Internet Banking invoice that is linked or still going out.
  const billedInXero = rows.filter((row) => row.verdict === "billedInXero");
  const retained = rows.filter((row) => row.verdict === "retained");

  console.log("Booking ledger census (INV-PAY-047) - read only\n");
  console.log(
    `${unasked.length} booking(s) are owed money nobody is asking for; ${billedInXero.length} are owed money billed on a Xero invoice; ${retained.length} hold more than the price (normally a policy-retained or credit-settled reduction).\n`,
  );

  for (const [title, group] of [
    ["Money nobody is asking for", unasked],
    ["Billed on a Xero invoice; check Xero before invoicing by hand", billedInXero],
    ["Club holds more than the price", retained],
  ] as const) {
    if (group.length === 0) continue;
    console.log(`## ${title}`);
    for (const row of group) {
      console.log(
        `  ${row.bookingId}  ${row.bookingStatus.padEnd(16)} residual ${formatCents(row.residualCents, format)}` +
          `  (price ${formatCents(row.finalPriceCents, format)}, fees ${formatCents(row.changeFeeCents, format)},` +
          ` captured ${formatCents(row.amountCents, format)}, refunded ${formatCents(row.refundedAmountCents, format)},` +
          ` credit ${formatCents(row.creditAppliedCents, format)}, ask ${formatCents(row.additionalAmountCents, format)}` +
          ` [${row.additionalPaymentStatus ?? "none"}])`,
      );
    }
    console.log("");
  }

  if (argv.includes("--json")) {
    console.log(JSON.stringify({ unasked, billedInXero, retained }, null, 2));
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
