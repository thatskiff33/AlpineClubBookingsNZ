import "server-only";

import { Prisma } from "@prisma/client";

import { isNonNegativeIntegerCents } from "@/lib/edit-financial-review-context";
import type { EditFinancialReviewOccurrence } from "@/lib/edit-financial-review-context";
import { raiseEditFinancialReviewTask } from "@/lib/edit-financial-review";
import {
  editReviewSettlementPaymentId,
  type EditReviewSettlementPayment,
} from "@/lib/booking-payment-state";
import { calendarDateOfDateOnlyInstant } from "@/lib/club-time";

/**
 * #3166/#3498 (epic #2797): THE PARKED EDIT'S RAISE, in one place, for all four
 * doors.
 *
 * Split out of `edit-financial-review.ts` when #3498 pushed that module past its
 * size budget, and along a seam it already draws: that module owns the STATE -
 * writing the row, fencing a replay, reading one back, refusing a further edit
 * while a review is open - and knows nothing about who is calling it. This is
 * the CALLERS' half: the arguments every parked door would otherwise derive for
 * itself, and which of them are not arguments at all.
 */

/**
 * #3166: THE PARKED EDIT'S WHOLE RAISE, in one place, for all four doors.
 *
 * #3498 (D1): and it raises ONE task - a parked edit is one thing to price, so
 * the per-strand loop is gone and every strand is on the one occurrence.
 * Every parked path used to write this block out by hand: the same settlement
 * payment id, the same `memberIdByGuestId` map, the same loop with the same
 * constant arguments. Four copies of ONE fact — which captured payment a parked
 * edit's review settles against, and which member owns the strand it names — and
 * two of the four said why the payment id matters while two did not (`INV-SSOT`).
 *
 * That value is not incidental. `chooseEditReviewSettlementRoute` reads it at
 * COMPLETION to decide whether a confirmed amount goes back to the card, is
 * mirrored as a hand-settled allocation, or becomes account credit — so getting
 * it wrong does not fail, it routes real money down the wrong path weeks later
 * in front of an admin with no way to tell. It is derived through
 * `editReviewSettlementPaymentId`, the one home for that rule - a SNAPSHOT
 * nothing backfills, which is why the COMPLETION re-asks the same question of
 * the booking where the task carries no id (#3194).
 *
 * `raisedAmountCents` is not an argument at all, so no caller can pass a number:
 * a parked edit's amount is unknown, zero is a real financial decision, and a
 * computed figure is the guess the review exists to avoid. Unrepresentable
 * beats policed.
 *
 * Call it inside the caller's transaction, after the locks and after the
 * `BookingModification` row exists. It returns THE task id — one per parked edit
 * since #3498, whatever the party size.
 */
export async function raiseParkedEditFinancialReviewTask({
  booking,
  guests,
  addedGuests,
  occurrence,
  bookingModificationId,
  store,
}: {
  /**
   * The booking AS IT WAS before this edit. Its dates are what the task
   * describes, so the review names the stay the unreadable evidence belongs to
   * rather than the one the edit moved it to.
   */
  booking: {
    status: string;
    payment: EditReviewSettlementPayment;
    checkIn: Date;
    checkOut: Date;
  };
  /**
   * Every strand an occurrence can name, INCLUDING one this edit is deleting —
   * the single-guest removal raises for the departing guest, whose row is not in
   * the booking's remaining guest list.
   */
  guests: readonly { id: string; memberId?: string | null }[];
  /**
   * The guests THIS edit added, if any. Passed as the created rows rather than
   * as a count so no caller has to state the rule twice; an add of nothing is an
   * empty array and is recorded as null.
   */
  addedGuests: readonly { priceCents: number }[];
  /**
   * THE parked edit's occurrence - ONE since #3498 (D1), where it was a list and
   * the list WAS the fan-out. Singular rather than policed at length one, so the
   * criterion is a property of the signature (`INV-SSOT`).
   */
  occurrence: EditFinancialReviewOccurrence;
  /**
   * Owner decision D-3032-1: THIS edit's own `BookingModification`, so the
   * credit or refund that eventually moves is keyed to the change that caused it
   * rather than to a second history row minted at completion.
   */
  bookingModificationId: string | null;
  store: Prisma.TransactionClient;
}): Promise<string> {
  const memberIdByGuestId = new Map(
    guests.map((guest) => [guest.id, guest.memberId ?? null]),
  );
  const paymentId = editReviewSettlementPaymentId(booking);
  // Money the club is owed and has not taken: a parked edit writes the booking's
  // total back unchanged, so an added guest's price lives only on their own row.
  // A total that is not usable money is recorded as ABSENT rather than as a
  // figure an admin might act on - the same rule the stored evidence follows.
  const addedTotalCents = addedGuests.reduce(
    (total, guest) => total + guest.priceCents,
    0,
  );
  const guestsAddedByEdit =
    addedGuests.length === 0
      ? null
      : {
          count: addedGuests.length,
          totalPriceCents: isNonNegativeIntegerCents(addedTotalCents)
            ? addedTotalCents
            : null,
        };
  const raised = await raiseEditFinancialReviewTask({
    occurrence,
    // The LEAD strand's member - no browser sees it (the queue projection has no
    // field for it), so this is the context's long-standing "whose money"
    // pointer, now aimed at the strand the card is headed by.
    guestMemberId: memberIdByGuestId.get(occurrence.bookingGuestId) ?? null,
    bookingCheckIn: calendarDateOfDateOnlyInstant(booking.checkIn),
    bookingCheckOut: calendarDateOfDateOnlyInstant(booking.checkOut),
    bookingModificationId,
    guestsAddedByEdit,
    paymentId,
    raisedAmountCents: null,
    store,
  });
  return raised.taskId;
}
