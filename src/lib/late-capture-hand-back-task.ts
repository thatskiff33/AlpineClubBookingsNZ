import { ManualRefundTaskKind } from "@prisma/client";

import { automaticCancelledBookingRefundTaskReasons } from "@/lib/deleted-booking-modification-payment";

/**
 * #4843: WHICH TASKS ARE A LATE CAPTURE'S QUESTION (#2700, `INV-PAY-106`). A
 * module of its own so the frozen sentences' module does not grow; it reads
 * them (`automaticCancelledBookingRefundTaskReasons`), it never restates them.
 */

/** Stands in for the intent id when the frozen sentences are read as templates. */
const INTENT_SLOT = "\u0000";

/**
 * #4843: IS THIS STORED `reason` ONE OF THE FOUR AUTOMATIC LATE-CAPTURE
 * SENTENCES, for any payment intent? Read off their frozen builders, so it
 * cannot drift from them (`INV-SSOT`): each is split at the intent id, and a reason matches when
 * it starts with the words before it and ends with the words after it, with a
 * non-empty id between. The longest sentence is under 300 characters without
 * its id, so the 500-character cap never cuts the words after an id of up to
 * 200 characters (Stripe's are under 40); a longer one would read as no match,
 * which is the check's behaviour before #4843.
 *
 * Why it exists: `kind` was added (19 Aug 2026) with no backfill, so a #2700
 * row raised before then carries NULL, and its sentence is then the only thing
 * that says what it is (`isLateCaptureHandBackTask`).
 */
export function isAutomaticCancelledBookingRefundTaskReason(reason: string): boolean {
  return automaticCancelledBookingRefundTaskReasons(INTENT_SLOT).some((sentence) => {
    const slot = sentence.indexOf(INTENT_SLOT);
    const before = sentence.slice(0, slot);
    const after = sentence.slice(slot + INTENT_SLOT.length);
    return reason.length > before.length + after.length && reason.startsWith(before) && reason.endsWith(after);
  });
}

/**
 * #4843: IS THIS TASK A LATE CAPTURE'S QUESTION (#2700, `INV-PAY-106`)? The
 * typed kind, or - on a row raised before `kind` existed, which carries NULL -
 * one of the automatic late-capture sentences. A NULL-kind row with any other
 * reason is a cancellation's own hand-back (`openHandBackOwedCents`) and is not
 * one. The still-owed check of a hand-back (`assertLateCaptureHandBackStillOwed`)
 * is gated on this, so a legacy row is checked under the Payment row too.
 */
export function isLateCaptureHandBackTask(task: { kind: ManualRefundTaskKind | string | null; reason: string }): boolean {
  if (task.kind === ManualRefundTaskKind.DELETED_BOOKING_LATE_CAPTURE) return true;
  return task.kind === null && isAutomaticCancelledBookingRefundTaskReason(task.reason);
}
