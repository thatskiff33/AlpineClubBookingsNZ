import "server-only";
import type { Prisma } from "@prisma/client";
import { planConfirmationChargeLines, type ConfirmationPostingBooking } from "@/lib/booking-ledger-confirmation-posting";
import { modificationChangeFeePosting } from "@/lib/booking-ledger-modification-posting";
import { loadFeesAddedToAmountOwed } from "@/lib/booking-finished-stay-correction";
import { bookingHasConfirmationLines } from "@/lib/booking-ledger-read";
import { buildBookingLedgerRows, writeBookingLedgerRows } from "@/lib/booking-ledger-write";
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
  booking: ConfirmationPostingBooking & { payment?: { changeFeeCents: number } | null },
  journal: BookingJournalContext,
): Promise<void> {
  const alreadyConfirmedOnLedger = await bookingHasConfirmationLines(tx, booking.id);
  // #3750 (owner, 7 Oct 2026, "Add fee to amount owed"): a fee a finished-stay
  // correction added to this unpaid booking's amount owed had no confirmed
  // ledger to post to; it posts here, beside the confirmation's nights, under
  // its modification's own key, so the ledger's CHANGE_FEE lines equal the
  // payment's recorded fee once the booking is paid.
  // Read only where a fee was recorded on the payment at all.
  const feeOwedPostings =
    alreadyConfirmedOnLedger || !(booking.payment && booking.payment.changeFeeCents > 0)
    ? []
    : (await loadFeesAddedToAmountOwed(tx, booking.id)).map((fee) =>
        modificationChangeFeePosting({
          bookingId: booking.id,
          lodgeId: booking.lodgeId,
          bookingModificationId: fee.modificationId,
          changeFeeCents: fee.changeFeeCents,
        }),
      );
  const ledgerRows = alreadyConfirmedOnLedger ? [] : (() => {
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
            unpricedStrandIds: plan.unpricedStrandIds,
            postedLines: plan.postings.length,
          },
          "Booking ledger: the charge lines for a settled booking do not add up to its final price (#3580)"
        );
      }
      return buildBookingLedgerRows([...plan.postings, ...feeOwedPostings]);
    } catch (error) {
      logger.error(
        { err: error, bookingId: booking.id },
        "Booking ledger: could not build charge lines for a settled booking; the settle stands and the gap is the census's to report (#3580)"
      );
      return [];
    }
  })();
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
  if (!alreadyConfirmedOnLedger) {
    await postBookingLedgerJournal(tx, journal, {
      bookingId: booking.id,
      lodgeId: booking.lodgeId,
      event: { kind: "confirmation" },
      postingKeys: ledgerRows.flatMap((row) => (row.postingKey ? [row.postingKey] : [])),
    });
  }
}

/** Re-read after an edit's guest/night writes, or a new approval's PAID write. */
export async function postStoredBookingConfirmationLedgerLines(
  tx: Prisma.TransactionClient,
  bookingId: string,
  journal: BookingJournalContext,
): Promise<void> {
  const booking = await tx.booking.findUniqueOrThrow({
    where: { id: bookingId },
    include: {
      guests: { include: { nights: { select: { stayDate: true, priceCents: true } } } },
      payment: { select: { changeFeeCents: true } },
    },
  });
  await postBookingConfirmationLedgerLines(tx, booking, journal);
}
