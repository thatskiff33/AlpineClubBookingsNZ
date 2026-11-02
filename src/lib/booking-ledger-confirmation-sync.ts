import "server-only";
import type { Prisma } from "@prisma/client";
import { planConfirmationChargeLines, type ConfirmationPostingBooking } from "@/lib/booking-ledger-confirmation-posting";
import { modificationChangeFeePosting } from "@/lib/booking-ledger-modification-posting";
import { loadFeesAddedToAmountOwed } from "@/lib/booking-finished-stay-correction";
import { bookingHasConfirmationLines } from "@/lib/booking-ledger-read";
import { buildBookingLedgerRows, writeBookingLedgerRows, type BookingLedgerPosting } from "@/lib/booking-ledger-write";
import logger from "@/lib/logger";
import { postBookingLedgerJournal, type BookingJournalContext } from "@/lib/member-money/doors";

/**
 * One charge poster after a successful PAID claim (INV-PAY-047). The caller
 * holds global lock(1), then its lodge key (INV-LOCK-002). A booking posts once,
 * even if a later reversal and re-settle arrive with different guest/night ids.
 * Pure planning errors are logged; database reads/writes propagate because an
 * aborted transaction cannot recover by catching a statement failure (#3590).
 *
 * #4627 (Ledger M3b, R01): the same lines then post into the member-money
 * journal, in this transaction, from the context the door resolved before it
 * opened, as R01 even when they carry no money. A journal refusal is never
 * caught: it rolls the settle back.
 */
export async function postBookingConfirmationLedgerLines(
  tx: Prisma.TransactionClient,
  booking: ConfirmationBooking,
  journal: BookingJournalContext,
): Promise<void> {
  const alreadyConfirmedOnLedger = await bookingHasConfirmationLines(tx, booking.id);
  const ledgerRows = alreadyConfirmedOnLedger ? [] : buildBookingLedgerRows(await planConfirmationPostings(tx, booking, "confirmation"));
  const ledgerInserted = await writeBookingLedgerRows(tx, ledgerRows);
  // Under the fence every row is new, so a shortfall means a key was already
  // there — not an error (the write skipped it rather than aborting), but not
  // something that should happen either, so it is said out loud rather than
  // discarded (review of #3597).
  if (ledgerInserted !== ledgerRows.length) {
    logger.warn(
      { bookingId: booking.id, planned: ledgerRows.length, inserted: ledgerInserted },
      "Booking ledger: some confirmation lines were already posted under their keys (#3595)"
    );
  }
  // R01 posts for every first confirmation, even one with no money or whose
  // lines could not be built (a ZERO event): it is what puts the booking in the
  // journal's population, so its later money posts and the census compares it.
  // #4628: a booking charged at its binding moment links these lines to that
  // charge instead (`postBookingLedgerJournal`'s bridge), posting no second one.
  if (!alreadyConfirmedOnLedger) {
    await postBookingLedgerJournal(tx, journal, {
      bookingId: booking.id,
      lodgeId: booking.lodgeId,
      event: { kind: "confirmation" },
      postingKeys: ledgerRows.flatMap((row) => (row.postingKey ? [row.postingKey] : [])),
    });
  }
}

/** The booking as the confirmation plans it: its night rows, and the fee recorded on its payment. */
export type ConfirmationBooking = ConfirmationPostingBooking & { payment?: { changeFeeCents: number } | null };

/**
 * THE LINES A BOOKING'S CONFIRMATION POSTS, PLANNED AND NOT WRITTEN: the one
 * plan the confirmation writes (above) and the member-money journal's pending
 * charge stands on before it (#4628, `booking-ledger-pending-charge.ts`), so the
 * two are the same lines by construction. Its nights and promotion
 * (`planConfirmationChargeLines`), and (#3750, owner, 7 Oct 2026, "Add fee to
 * amount owed") each fee a finished-stay correction added to this unpaid
 * booking's amount owed, under its modification's own key, so the ledger's
 * CHANGE_FEE lines equal the payment's recorded fee once the booking is paid.
 * Read only where a fee was recorded on the payment at all.
 *
 * Pure planning errors are logged and plan nothing, as the confirmation always
 * has; database reads propagate, because an aborted transaction cannot recover
 * by catching a statement failure (#3590).
 */
export async function planConfirmationPostings(
  tx: Prisma.TransactionClient,
  booking: ConfirmationBooking,
  purpose: "confirmation" | "pending charge",
): Promise<BookingLedgerPosting[]> {
  const feeOwedPostings = !(booking.payment && booking.payment.changeFeeCents > 0)
    ? []
    : (await loadFeesAddedToAmountOwed(tx, booking.id)).map((fee) =>
        modificationChangeFeePosting({
          bookingId: booking.id,
          lodgeId: booking.lodgeId,
          bookingModificationId: fee.modificationId,
          changeFeeCents: fee.changeFeeCents,
        }),
      );
  try {
    const plan = planConfirmationChargeLines({
      id: booking.id,
      lodgeId: booking.lodgeId,
      totalPriceCents: booking.totalPriceCents,
      promoAdjustmentCents: booking.promoAdjustmentCents,
      guests: booking.guests,
    });
    if (!plan.reconciles) {
      logger.warn(
        {
          bookingId: booking.id,
          purpose,
          unpricedStrandIds: plan.unpricedStrandIds,
          postedLines: plan.postings.length,
        },
        "Booking ledger: the charge lines for a settled booking do not add up to its final price (#3580)"
      );
    }
    const postings = [...plan.postings, ...feeOwedPostings];
    // The write door's own shape check, so a plan it would refuse plans nothing here too.
    buildBookingLedgerRows(postings);
    return postings;
  } catch (error) {
    logger.error(
      { err: error, bookingId: booking.id, purpose },
      "Booking ledger: could not build charge lines for a settled booking; the settle stands and the gap is the census's to report (#3580)"
    );
    return [];
  }
}

/** The booking as `planConfirmationPostings` reads it, inside the caller's transaction. */
export async function readConfirmationBooking(tx: Prisma.TransactionClient, bookingId: string) {
  return tx.booking.findUniqueOrThrow({
    where: { id: bookingId },
    include: {
      guests: { include: { nights: { select: { stayDate: true, priceCents: true } } } },
      payment: { select: { changeFeeCents: true } },
    },
  });
}

/** Re-read after an edit's guest/night writes, or a new approval's PAID write. */
export async function postStoredBookingConfirmationLedgerLines(
  tx: Prisma.TransactionClient,
  bookingId: string,
  journal: BookingJournalContext,
): Promise<void> {
  await postBookingConfirmationLedgerLines(tx, await readConfirmationBooking(tx, bookingId), journal);
}
