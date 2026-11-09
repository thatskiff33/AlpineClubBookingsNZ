/**
 * #4848: THE FROZEN LATE-CAPTURE REASON SENTENCES, in a module with no imports
 * so a client-safe rule can read them (`isLateCaptureHandBackTask`, which the
 * owed figures in `manual-refund-task-settlement-rules.ts` ask). Moved byte for
 * byte from `deleted-booking-modification-payment.ts`, which re-exports them
 * and documents the race they record (#2700, #2760, #2773).
 *
 * `reason` IS THE IDEMPOTENCY KEY (`bookingId + paymentId + reason`), so no
 * sentence here is ever reworded; new populations get new sentences.
 */

/**
 * The confirm route's #2700 sentence: a booking-modification payment captured
 * against a booking the club had already deleted. The only one an OPEN task is
 * raised with (`raiseDeletedBookingModificationRefundTask`).
 */
export function deletedBookingModificationRefundReason(
  paymentIntentId: string,
): string {
  return `Booking modification payment ${paymentIntentId} was captured against a booking the club had already deleted (#2700). Decide by hand whether to refund it: nothing was owed on a deleted booking, but if the deletion was itself the mistake, put that right instead of refunding.`.slice(
    0,
    500,
  );
}

/**
 * The same sentence for the OTHER population #2760 widened this record to: a
 * late capture on a booking that is CANCELLED but has not been deleted.
 *
 * WHY A SECOND STRING AND NOT ONE SHARED SENTENCE. The reason is stored on the
 * row and printed on the finance card, so the sentence above — which says the
 * booking "had already been deleted" and asks an operator to decide — would be
 * false on both counts for a booking that is merely cancelled. Two honest
 * sentences beat one that is wrong for half the rows it now covers.
 *
 * AND WHY THE FIRST ONE'S BYTES DID NOT CHANGE. `reason` is the idempotency key
 * (`bookingId + paymentId + reason`) that the confirm route's raise and the
 * webhook's close/record both match on. Rewording it would leave any OPEN task
 * raised before this deploy unmatchable: the webhook would create a second,
 * DISMISSED row and leave the OPEN one in the hand-back queue asking an operator
 * to hand back money Stripe had already returned. So the deleted-population
 * sentence is frozen, this one is new, and every lookup matches BOTH — see
 * `automaticCancelledBookingRefundTaskReasons`.
 *
 * NO "decide by hand" CLAUSE, deliberately. Only the webhook writes this
 * variant, and only already-DISMISSED, so there has never been a decision on one
 * of these rows.
 */
export function cancelledBookingModificationRefundReason(
  paymentIntentId: string,
): string {
  return `Booking modification payment ${paymentIntentId} was captured against a booking the club had already cancelled (#2760). Nothing was owed on a cancelled booking, so there is no hand-back to make — but if the cancellation was itself the mistake, put that right rather than treating this as a refund somebody still owes.`.slice(
    0,
    500,
  );
}

/**
 * WHICH LATE CAPTURE THIS RECORD IS ABOUT (#2773 — the orchestrator's call on that
 * issue's Recommended option; the owner has not ruled. `INV-ADDPAY-039`'s authority
 * line states the provenance in full).
 *
 * There are TWO late-capture handlers on a cancelled booking, and until #2773
 * only one of them recorded anything:
 *
 * - `"modification"` — `handleCancelledBookingAdditionalPaymentSucceeded`, a
 *   payment for a *change* to the booking. The one #2760/#2761 fixed.
 * - `"primary"` — `handleCancelledBookingPaymentSucceeded`, the booking's OWN
 *   payment. It refunds with the same `cancelled_booking_late_capture` reason and
 *   writes the same `booking.payment.refunded_after_cancellation` audit entry, and
 *   until #2773 it wrote no `ManualRefundTask` at all and sent the generic
 *   muteable "Payment Failed" mail.
 *
 * IT IS NOT COSMETIC. The `reason` is stored on the row and printed on the
 * finance card, and the modification sentences above open "Booking modification
 * payment …" — which is simply false about a booking's own payment. So the kind
 * selects the sentence, exactly as the population already does.
 */
export type CancelledBookingLateCaptureKind = "modification" | "primary";

/**
 * The deleted-population sentence for a late capture of the booking's OWN
 * payment (#2773).
 *
 * NO "decide by hand" CLAUSE, for the same reason
 * `cancelledBookingModificationRefundReason` has none: only the webhook ever
 * writes this variant, and only already-`DISMISSED`, so no decision has ever
 * been taken on one of these rows. Nothing raises an `OPEN` task for a primary
 * capture — the confirm-modification-payment route is the only raiser and it
 * handles modification intents — so unlike the #2700 sentence this one is never
 * read by an operator with work in front of them.
 *
 * FROZEN FROM NOW ON, like its siblings. `reason` IS the idempotency key
 * (`bookingId + paymentId + reason`), so rewording it after a deploy would make
 * an already-written row unmatchable and let a Stripe redelivery write a SECOND
 * row for one capture. New populations or kinds get NEW sentences; existing ones
 * are never edited. See `automaticCancelledBookingRefundTaskReasons`.
 */
export function deletedBookingPrimaryPaymentRefundReason(
  paymentIntentId: string,
): string {
  return `The booking's own payment ${paymentIntentId} was captured against a booking the club had already deleted (#2773). Nothing was owed on a deleted booking, so there is no hand-back to make — but if the deletion was itself the mistake, put that right rather than treating this as a refund somebody still owes.`.slice(
    0,
    500,
  );
}

/**
 * The cancelled-but-still-on-file sentence for a late capture of the booking's
 * OWN payment (#2773). Same freeze and the same reasoning as its deleted sibling
 * above.
 */
export function cancelledBookingPrimaryPaymentRefundReason(
  paymentIntentId: string,
): string {
  return `The booking's own payment ${paymentIntentId} was captured against a booking the club had already cancelled (#2773). Nothing was owed on a cancelled booking, so there is no hand-back to make — but if the cancellation was itself the mistake, put that right rather than treating this as a refund somebody still owes.`.slice(
    0,
    500,
  );
}

/**
 * Every `reason` this record can carry for one payment intent, for the writers
 * that must find a row REGARDLESS of which population produced it (#2760).
 *
 * THE KEY MUST NOT DEPEND ON THE POPULATION, and that is the whole reason this
 * exists. A booking can be deleted BETWEEN two Stripe deliveries of the same
 * capture — deletion is one-way (`INV-ADDPAY-030`), but it can arrive at any
 * moment — so a redelivery would see the deleted population where the first
 * delivery saw the cancelled one. Keyed per population, that redelivery finds no
 * row and writes a SECOND one for a single refund. Matching both sentences makes
 * the lookup population-independent while each row still stores the sentence
 * that was true when it was written.
 *
 * The confirm route's raise matches this list too, so a webhook-created row of
 * either kind stops it raising a duplicate OPEN task. Its refund fence would
 * also decline that raise — this is deliberate belt and braces on the one path
 * where a duplicate would be an operator asked to hand back money twice.
 *
 * NOR MAY IT DEPEND ON THE CAPTURE KIND (#2773), for the identical reason. A
 * payment intent is either the booking's own or a modification's — the kind is
 * fixed for the life of the intent and cannot change under us the way `deletedAt`
 * can — so listing all four sentences buys no new correctness on a healthy
 * lookup. What it buys is that the key stays a property of the INTENT rather than
 * of whichever handler happens to be running: every reader here (the raise's
 * duplicate check, the close's `updateMany`, the record's `findFirst`, and #2774's
 * hand-back fence) becomes kind-independent by construction, so a future writer
 * cannot reintroduce the two-rows-for-one-capture defect by keying on its own
 * sentence alone. It costs one extra `IN` element per lookup on a key that is
 * already `bookingId + paymentId`-scoped.
 */
export function automaticCancelledBookingRefundTaskReasons(
  paymentIntentId: string,
): string[] {
  return [
    deletedBookingModificationRefundReason(paymentIntentId),
    cancelledBookingModificationRefundReason(paymentIntentId),
    deletedBookingPrimaryPaymentRefundReason(paymentIntentId),
    cancelledBookingPrimaryPaymentRefundReason(paymentIntentId),
  ];
}
