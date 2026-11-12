import type { ManualRefundTaskKind, Prisma } from "@prisma/client";

import {
  editFinancialReviewStrandMovesNights,
  editFinancialReviewStrandRecords,
  parseEditFinancialReviewContext,
  type EditFinancialReviewContext,
} from "@/lib/edit-financial-review-context";

/*
 * Which guests an edit review names were removed after it was raised, and the
 * completion refusal that follows (#4317, #4343). Client-safe: the finance
 * queue reads the warning, and `manual-refund-task-resolution.ts` (server-only)
 * reads the refusal. Split out of `edit-financial-review-context.ts`, which
 * stays the review context's parser and strand reader.
 */

/**
 * The review's own edit removed this guest: every stored night was surrendered
 * and none were added. Where it held no stored rows, a whole surrender is read
 * as that removal, so the warning errs towards silence. One predicate: the
 * "removed since raised" list stays silent on it, and the cleanup credits it.
 */
export function editFinancialReviewRemovedByItsOwnEdit(strand: {
  surrenderedNightDates: readonly string[];
  addedNightDates: readonly string[];
  storedEvidence: { nightPrices: readonly { date: string }[] };
}): boolean {
  if (strand.addedNightDates.length > 0) return false;
  const surrendered = new Set<string>(strand.surrenderedNightDates);
  return surrendered.size > 0 && strand.storedEvidence.nightPrices.every((night) => surrendered.has(night.date));
}

/** Completing the review would pay the guest's removal a second time. Dismiss it. */
export const EDIT_REVIEW_LATER_REMOVAL_COMPLETION_REFUSAL =
  "A guest this review names was removed after it was raised, and that removal already credited them, so this review cannot be settled.";

/**
 * #4317 (owner decision on #4302, after review round 1): THE GUESTS A REVIEW
 * NAMES THAT WERE REMOVED FROM THE BOOKING AFTER IT WAS RAISED.
 *
 * Since #4317 a removal is priced, and a consent removal is exempt from the
 * open-review fence (D-14), so a guest a pre-#4317 review is about can come off
 * the booking while the review is open - credited its whole STORED total. A
 * parked edit left that total exactly as it was (`INV-MOD-040`; on `main` every
 * parked writer stored `priceCents` unchanged, pinned by
 * `booking-edit-financial-review-parity.test.ts`: a three-night strand extended
 * to five parked at its three-night total). So:
 *
 *  - nights the review's edit GAVE BACK are still inside that total, and the
 *    removal credited them: settling the review could credit them again;
 *  - nights it ADDED never were, and the removal did not credit them: settling
 *    could charge for nights the guest no longer holds.
 *
 * The owner's answer: price the removal, warn the officer here (in the direction
 * each strand moved, `gaveNightsBack` / `addedNights`), and let wave B's
 * clean-up (D3) close such a review with no money moved.
 *
 * Only a strand whose nights the review's edit MOVED counts
 * (`editFinancialReviewStrandMovesNights`): a review's money only ever comes
 * from those (#4317 review rounds 3, 4 and 6). A strand the review merely
 * carries - one of its `otherStrands`, or a pre-#3498 one-strand row about a
 * guest the edit did not touch - cannot be settled twice by its guest's
 * removal, and warning on it would steer an officer away from money owed for
 * another guest.
 *
 * And a moved strand counts only when the review's OWN edit did not remove it: a
 * parked removal deletes its departing guest in the transaction that raised the
 * review, and that strand records every night it held as surrendered and none
 * added. Where it held no stored rows, a whole surrender is read as that
 * removal, so the warning errs towards silence.
 *
 * Read through `editFinancialReviewStrandRecords`, the one list of an item's
 * strands (`INV-SSOT`); `strandIndex` is a strand's place in it, the ordinal the
 * settle card's evidence block names each guest by ("Guest 1 of 2").
 */
export function editFinancialReviewGuestsRemovedSinceRaised(
  context: EditFinancialReviewContext,
  currentGuestIds: ReadonlySet<string>,
): Array<{
  bookingGuestId: string;
  strandIndex: number;
  strandCount: number;
  guestTotalCents: number | null;
  gaveNightsBack: boolean;
  addedNights: boolean;
}> {
  const strands = editFinancialReviewStrandRecords(context.occurrence);
  return strands.flatMap((strand, strandIndex) => {
    if (!editFinancialReviewStrandMovesNights(strand)) return [];
    if (currentGuestIds.has(strand.bookingGuestId)) return [];
    if (editFinancialReviewRemovedByItsOwnEdit(strand)) return [];
    return [
      {
        bookingGuestId: strand.bookingGuestId,
        strandIndex,
        strandCount: strands.length,
        guestTotalCents: strand.storedEvidence.guestTotalCents,
        gaveNightsBack: strand.surrenderedNightDates.length > 0,
        addedNights: strand.addedNightDates.length > 0,
      },
    ];
  });
}

/**
 * #4343: completing an edit review whose guest was removed since it was raised
 * would pay that removal a second time, so the completion is refused and the
 * review is left to be dismissed. Reads the booking's current party through the
 * caller's transaction: `resolveManualRefundTask` holds `lock(1)`, which a
 * consent removal also takes, so the two cannot both pay. Null where it does
 * not apply (not an edit review, not a completion, or an unreadable context).
 */
export async function editReviewLaterRemovalRefusal(
  store: { bookingGuest: Pick<Prisma.TransactionClient["bookingGuest"], "findMany"> },
  task: { kind: ManualRefundTaskKind | null; bookingId: string; reviewContext: unknown },
  resolution: "completed" | "dismissed",
): Promise<string | null> {
  if (task.kind !== "EDIT_FINANCIAL_REVIEW" || resolution !== "completed") return null;
  const context = parseEditFinancialReviewContext(task.reviewContext);
  if (context === null) return null;
  const guests = await store.bookingGuest.findMany({ where: { bookingId: task.bookingId }, select: { id: true } });
  const removed = editFinancialReviewGuestsRemovedSinceRaised(context, new Set(guests.map((guest) => guest.id)));
  return removed.length > 0 ? EDIT_REVIEW_LATER_REMOVAL_COMPLETION_REFUSAL : null;
}
