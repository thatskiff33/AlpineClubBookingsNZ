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
import { bookingHasConfirmationLines, findPostedChargeLines } from "@/lib/booking-ledger-read";
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
   * What the club keeps under the policy, from the cancel path's own figures
   * (`cancellationKeptCents`); 0 for an unpaid cancellation or a hold release.
   */
  keptCents: number;
  /** Which cancel path posted, for the log line a gap leaves. */
  site: string;
}): Promise<void> {
  if (!(await bookingHasConfirmationLines(store, bookingId))) return;
  const postedLines = await findPostedChargeLines(store, bookingId);
  let rows: ReturnType<typeof buildBookingLedgerRows> = [];
  try {
    const plan = planCancellationChargeLines({ bookingId, lodgeId, keptCents, postedLines });
    if (plan.kind === "none") {
      logger.warn(
        { bookingId, site, reason: plan.reason, keptCents },
        "Booking ledger: a cancellation's lines were not posted; the cancellation stands and the gap is the census's to report (#3611)",
      );
      return;
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
