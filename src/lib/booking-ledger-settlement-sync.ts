/**
 * POST THE SETTLEMENT LINES A PAYMENT'S ROWS IMPLY (#3581, programme #3527).
 *
 * The store-facing half of `booking-ledger-settlement-posting.ts`: it loads the
 * payment's transactions and refunds and the settlement lines already on the
 * ledger, asks the pure planner what is missing, and writes that.
 *
 * WHERE IT RUNS. At the end of `reconcilePaymentAggregates` — the one place the
 * `Payment` mirror is derived from these same rows — and from the three paths
 * that write their rows and the payment's columns themselves instead: the
 * manual mark-paid settle, its reversal (`INV-PAY-047`), and the Xero
 * payment-received path's Internet Banking receipt. One function, four named
 * call sites; not four definitions. The first cut claimed every writer ended
 * at the chokepoint; review of #3604 traced every writer and found the
 * receipt path did not.
 *
 * WHAT IS SWALLOWED AND WHAT IS NOT (the lesson of #3590's review). Planning
 * and building the rows are pure: ANY throw there — a malformed plan, or a
 * plain programming error such as a missing field — happens before anything
 * reaches the database, so the caller's transaction is untouched; it is caught
 * and logged at error level, and the gap is C4's census to report (#3583). The reads
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
  // READ ORDER IS LOAD-BEARING (review of #3604). Outside a transaction these
  // are separate read-committed statements, and the posted LINES are read
  // BEFORE the payment's ROWS. That way a mixed snapshot can only ever pair
  // older lines with newer rows — which at worst re-plans a line already
  // posted, and the key makes that a skip. Read the other way round, an older
  // row ("not yet captured") could meet a newer line and the sync would post a
  // permanent, wrong reversal. The booking id is immutable, so reading it first
  // takes no part in the race.
  const owner = await store.payment.findUnique({
    where: { id: paymentId },
    select: { bookingId: true },
  });
  if (!owner) return;

  const postedLines = await findPostedSettlementLines(store, owner.bookingId);

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
