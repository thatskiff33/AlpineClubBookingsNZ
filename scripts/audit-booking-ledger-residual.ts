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
 * what a delta-sized ask produced when it superseded an unpaid one. A
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
 * is `bookingLedgerResidualCents`, the same function the CI census guard calls, so
 * the operator's answer and the guard's answer are one implementation rather than
 * two. `--sql` prints the EQUIVALENT statement for an operator who would rather
 * run it against a read-only replica; that statement is not written by hand
 * either - it is folded from `BOOKING_LEDGER_IDENTITY_TERMS`, the same signed
 * term table (`INV-SSOT-001`).
 *
 * SAFE USAGE - run against a NON-PRODUCTION copy:
 *
 *   DATABASE_URL='postgresql://user:pass@127.0.0.1:5432/scratch_copy' \
 *     npm run payments:audit-booking-ledger
 */
import "dotenv/config";
import process from "node:process";

import {
  BOOKING_LEDGER_CENSUS_CAPTURED_PAYMENT_STATUSES,
  BOOKING_LEDGER_CENSUS_EXCLUDED_BOOKING_STATUSES,
  bookingLedgerCensusSql,
  bookingLedgerResidualCents,
  bookingLedgerVerdict,
  type BookingLedgerIdentityRow,
} from "../src/lib/additional-payment-ask";
import { prisma } from "../src/lib/prisma";
import { formatCents } from "../src/lib/utils";

function printUsage() {
  console.log(`Usage:
  npm run payments:audit-booking-ledger            # read-only census (default)
  npm run payments:audit-booking-ledger -- --sql   # print the equivalent SQL and exit
  npm run payments:audit-booking-ledger -- --json  # also emit machine-readable JSON

This census is read-only. It never writes and never calls Xero/Stripe/SES.

Options:
  --sql           Print the equivalent SELECT, to run against a read-only replica.
  --json          Emit machine-readable JSON alongside the human report.
  --help, -h      Show this help.
`);
}

interface CensusRow extends BookingLedgerIdentityRow {
  bookingId: string;
  bookingStatus: string;
  residualCents: number;
}

async function loadCensus(): Promise<CensusRow[]> {
  const bookings = await prisma.booking.findMany({
    where: {
      deletedAt: null,
      status: {
        notIn: [...BOOKING_LEDGER_CENSUS_EXCLUDED_BOOKING_STATUSES],
      },
      payment: {
        status: { in: [...BOOKING_LEDGER_CENSUS_CAPTURED_PAYMENT_STATUSES] },
      },
    },
    select: {
      id: true,
      status: true,
      finalPriceCents: true,
      payment: {
        select: {
          changeFeeCents: true,
          amountCents: true,
          refundedAmountCents: true,
          creditAppliedCents: true,
          additionalAmountCents: true,
          additionalPaymentStatus: true,
        },
      },
    },
  });

  const rows: CensusRow[] = [];
  for (const booking of bookings) {
    if (!booking.payment) continue;
    const row: CensusRow = {
      bookingId: booking.id,
      bookingStatus: booking.status,
      finalPriceCents: booking.finalPriceCents,
      changeFeeCents: booking.payment.changeFeeCents,
      amountCents: booking.payment.amountCents,
      refundedAmountCents: booking.payment.refundedAmountCents,
      creditAppliedCents: booking.payment.creditAppliedCents,
      additionalAmountCents: booking.payment.additionalAmountCents,
      additionalPaymentStatus: booking.payment.additionalPaymentStatus,
      residualCents: 0,
    };
    row.residualCents = bookingLedgerResidualCents(row);
    if (row.residualCents !== 0) rows.push(row);
  }
  return rows.sort(
    (a, b) =>
      b.residualCents - a.residualCents || a.bookingId.localeCompare(b.bookingId),
  );
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

  const rows = await loadCensus();
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
