/**
 * POST THE SETTLEMENT LINES A BOOKING'S ACCOUNT-CREDIT ROWS IMPLY (#3599,
 * programme #3527). The store-facing half of `booking-ledger-credit-posting.ts`.
 *
 * WHERE IT RUNS. Credit rows have no chokepoint the way payment rows have
 * `reconcilePaymentAggregates`, so this is called by EVERY writer of a
 * booking-linked credit row, straight after the row, inside the writer's own
 * transaction: the five writers in `member-credit.ts` (which between them serve
 * every cancel, restore, reduction, clamp and credit election) and the four
 * rows the Xero inbound paths write directly. "Every writer" is held by a
 * census rather than by this sentence: `booking-ledger-credit-writers.test.ts`
 * fails on a credit-row write in a file that never calls this. It converges the
 * whole booking each time, so a row a caller missed is posted by the next.
 *
 * WHAT IS SWALLOWED AND WHAT IS NOT — as in `booking-ledger-settlement-sync.ts`
 * and for the same reason (#3590's review): planning and building are pure and
 * a throw there is caught and logged, leaving the caller's transaction whole;
 * the reads and the write are statements and are never wrapped, because a
 * statement PostgreSQL refuses has already aborted the transaction. The write
 * skips, rather than refuses, a key already posted (`INV-MONEY-033`).
 *
 * NO READ-ORDER RACE. #3581's sync must read lines before rows because it can
 * post reversals; nothing here is ever reversed, so a mixed snapshot can only
 * re-plan a line already posted (a skip) or miss a row a later call will post.
 */
import type { Prisma } from "@prisma/client";

import { planCreditLines } from "@/lib/booking-ledger-credit-posting";
import { findPostedCreditLines } from "@/lib/booking-ledger-read";
import { buildBookingLedgerRows, writeBookingLedgerRows } from "@/lib/booking-ledger-write";
import logger from "@/lib/logger";

export type CreditSyncStore = Pick<Prisma.TransactionClient, "booking" | "memberCredit" | "bookingLedgerLine">;

export async function syncBookingLedgerCredits({
  bookingId,
  store,
}: {
  bookingId: string;
  store: CreditSyncStore;
}): Promise<void> {
  const booking = await store.booking.findUnique({
    where: { id: bookingId },
    select: { lodgeId: true },
  });
  if (!booking) return;

  const postedLines = await findPostedCreditLines(store, bookingId);
  const credits = await store.memberCredit.findMany({
    where: {
      OR: [
        { appliedToBookingId: bookingId, type: "BOOKING_APPLIED" },
        { sourceBookingId: bookingId, type: { in: ["CANCELLATION_REFUND", "BOOKING_MODIFICATION_REFUND"] } },
      ],
    },
    select: { id: true, type: true, amountCents: true, restoredFromBookingId: true },
  });

  let rows: ReturnType<typeof buildBookingLedgerRows> = [];
  try {
    const plan = planCreditLines({ bookingId, lodgeId: booking.lodgeId, credits, postedLines });
    if (plan.amountDrift.length > 0) {
      logger.warn(
        { bookingId, drift: plan.amountDrift },
        "Booking ledger: a posted credit line no longer matches its credit row (#3599)",
      );
    }
    rows = buildBookingLedgerRows(plan.postings);
  } catch (error) {
    logger.error(
      { err: error, bookingId },
      "Booking ledger: could not build credit lines; the credit write stands and the gap is the census's to report (#3599)",
    );
    return;
  }
  await writeBookingLedgerRows(store, rows);
}
