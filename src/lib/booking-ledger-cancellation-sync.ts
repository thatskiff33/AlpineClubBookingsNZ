import "server-only";

/**
 * POST A CANCELLATION'S CHARGE LINES TO THE BOOKING LEDGER (#3611, programme
 * #3527). The planning is `booking-ledger-cancellation-posting.ts`; this module
 * asks the ledger what it holds, plans, and writes — inside the cancel path's
 * own transaction, under the `pg_advisory_xact_lock(1)` every cancel path
 * already takes first.
 *
 * Only a booking already confirmed on the ledger posts
 * (`bookingHasConfirmationLines`), asked under that key: a booking cancelled
 * before it was confirmed has no lines to take back (design §4.1a).
 *
 * Build in pure code, caught and logged; write unwrapped. A refused statement
 * has already aborted the transaction (#3590's review), so the write is never
 * the thing anyone is invited to swallow.
 */
import type { Prisma } from "@prisma/client";

import { planCancellationChargeLines } from "@/lib/booking-ledger-cancellation-posting";
import {
  bookingHasConfirmationLines,
  findPostedAdjustmentLines,
  findPostedCancellableChargeLines,
} from "@/lib/booking-ledger-read";
import { buildBookingLedgerRows, writeBookingLedgerRows } from "@/lib/booking-ledger-write";
import logger from "@/lib/logger";

export async function postCancellationLedgerLines({
  store,
  bookingId,
  lodgeId,
  keptCents,
  site,
}: {
  store: Pick<Prisma.TransactionClient, "bookingLedgerLine">;
  bookingId: string;
  lodgeId: string;
  /**
   * What the club keeps of the booking's money, change fees included: the
   * paid path's `ledgerKeptCents` (`paid-cancellation-money.ts`); 0 for every
   * path that keeps nothing (design §5.1).
   */
  keptCents: number;
  /** Which cancel path posted, for the log line a gap leaves. */
  site: string;
}): Promise<void> {
  if (!(await bookingHasConfirmationLines(store, bookingId))) return;
  const chargeLines = await findPostedCancellableChargeLines(store, bookingId);
  const adjustmentLines = await findPostedAdjustmentLines(store, bookingId);
  let rows: ReturnType<typeof buildBookingLedgerRows> = [];
  try {
    const plan = planCancellationChargeLines({ bookingId, lodgeId, keptCents, chargeLines, adjustmentLines });
    if (plan.kind === "none") {
      logger.warn(
        { bookingId, site, reason: plan.reason, keptCents },
        "Booking ledger: a cancellation's lines were not posted; the cancellation stands and the gap is the census's to report (#3611)",
      );
      return;
    }
    if (plan.changeFeesReversed && keptCents > 0) {
      // Not a gap: the club kept less than the change fees it charged (a
      // payment that never covered them), so §5.1 takes them back and the fee
      // carries what was kept. Said out loud because it is rare.
      logger.info(
        { bookingId, site, keptCents, cancellationFeeCents: plan.cancellationFeeCents },
        "Booking ledger: a cancellation kept less than its change fees; they were reversed and the fee carries what was kept (#3611)",
      );
    }
    rows = buildBookingLedgerRows(plan.postings);
  } catch (error) {
    logger.error(
      { err: error, bookingId, site },
      "Booking ledger: could not build a cancellation's lines; the cancellation stands and the gap is the census's to report (#3611)",
    );
    return;
  }
  await writeBookingLedgerRows(store, rows);
}
