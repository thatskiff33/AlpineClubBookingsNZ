/**
 * POST THE SETTLEMENT LINES A PAYMENT'S ROWS IMPLY (#3581, programme #3527).
 *
 * The store-facing half of `booking-ledger-settlement-posting.ts`: it loads the
 * payment's transactions and refunds and the settlement lines already on the
 * ledger, asks the pure planner what is missing, and writes that.
 *
 * WHERE IT RUNS. At the end of `reconcilePaymentAggregates` — the one place the
 * `Payment` mirror is derived from these same rows, and the function every
 * capture, receipt and refund writer already ends in — and from the two paths
 * that deliberately bypass it: the manual mark-paid settle and its reversal,
 * which write their rows and the payment's columns themselves (`INV-PAY-047`).
 * One function, three call sites, each named; not three definitions.
 *
 * WHAT IS SWALLOWED AND WHAT IS NOT (the lesson of #3590's review). Planning
 * and building the rows are pure: a malformed plan throws before anything
 * reaches the database, the caller's transaction is untouched, and that throw
 * is caught and logged — the gap is C4's census to report (#3583). The reads
 * and the write are statements and are NOT wrapped: a statement PostgreSQL
 * refuses has already aborted the transaction, and no `catch` brings it back.
 * The write skips, rather than refuses, a key already posted (`INV-MONEY-033`).
 */
import type { Prisma } from "@prisma/client";

import { findPostedSettlementLines } from "@/lib/booking-ledger-read";
import { planSettlementLines } from "@/lib/booking-ledger-settlement-posting";
import { buildBookingLedgerRows, writeBookingLedgerRows } from "@/lib/booking-ledger-write";
import logger from "@/lib/logger";

export type SettlementSyncStore = Pick<Prisma.TransactionClient, "payment" | "bookingLedgerLine">;

export async function syncBookingLedgerSettlements({
  paymentId,
  store,
}: {
  paymentId: string;
  store: SettlementSyncStore;
}): Promise<void> {
  const payment = await store.payment.findUnique({
    where: { id: paymentId },
    select: {
      bookingId: true,
      manuallyMarkedPaidAt: true,
      manuallyMarkedPaidByMemberId: true,
      booking: { select: { lodgeId: true } },
      transactions: { select: { id: true, source: true, status: true, amountCents: true } },
      refunds: { select: { id: true, status: true, amountCents: true } },
    },
  });
  if (!payment) return;

  const postedLines = await findPostedSettlementLines(store, payment.bookingId);

  let rows: ReturnType<typeof buildBookingLedgerRows> = [];
  try {
    const plan = planSettlementLines({
      bookingId: payment.bookingId,
      lodgeId: payment.booking.lodgeId,
      // `INV-PAY-001`: the provenance predicate is this column alone.
      manuallySettled: payment.manuallyMarkedPaidAt !== null,
      manualActorMemberId: payment.manuallyMarkedPaidByMemberId,
      transactions: payment.transactions,
      refunds: payment.refunds,
      postedLines,
    });
    if (plan.amountDrift.length > 0) {
      logger.warn(
        { paymentId, bookingId: payment.bookingId, drift: plan.amountDrift },
        "Booking ledger: a posted settlement line no longer matches its source row (#3581)",
      );
    }
    rows = buildBookingLedgerRows(plan.postings);
  } catch (error) {
    logger.error(
      { err: error, paymentId, bookingId: payment.bookingId },
      "Booking ledger: could not build settlement lines; the payment write stands and the gap is the census's to report (#3581)",
    );
    return;
  }
  await writeBookingLedgerRows(store, rows);
}
