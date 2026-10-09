import { asRecord, readString } from "@/lib/xero-json";

/**
 * #3791: the key parts that scope a modification credit note to ONE review
 * task. Two reviews of one edit each settle their own share against the same
 * `BookingModification`, so an anchor-and-amount key would fold two equal
 * shares into one note. The amount stays in every key (`INV-MOD-058`); this
 * adds the task beside it, and nothing at all where there is no task, so every
 * key written before it is unchanged.
 */
/**
 * #3809: the scope of an edit's second invoice-allocated note - applied credit
 * given back beside a card or bank refund's note on the same edit. Not a review
 * task; it rides the same slot so the enqueue's own-key dedupe, the builder's
 * keys and the operator retry need nothing new.
 */
export const APPLIED_CREDIT_GIVE_BACK_NOTE_SCOPE = "applied-credit-give-back";

/** The give-back note's scope, nested under a caller's own where it has one. */
export function giveBackNoteScope(reviewTaskId: string | null | undefined): string {
  return reviewTaskId ? `${reviewTaskId}:${APPLIED_CREDIT_GIVE_BACK_NOTE_SCOPE}` : APPLIED_CREDIT_GIVE_BACK_NOTE_SCOPE;
}

/** Whether a scope is a give-back note's (`giveBackNoteScope`). */
export function isGiveBackNoteScope(scope: string | null | undefined): boolean {
  return scope === APPLIED_CREDIT_GIVE_BACK_NOTE_SCOPE || Boolean(scope?.endsWith(`:${APPLIED_CREDIT_GIVE_BACK_NOTE_SCOPE}`));
}

/**
 * #3954 (owner decision 10 Oct 2026, "Auto credit note", `INV-PAY-120`): the
 * scope of a reduction's invoice-correction note for the part of its
 * unpaid-ask offset the primary invoice had already billed. Rides the same
 * slot as the give-back's, for the same reasons; only an edit's own
 * settlement raises it, so it is never nested under a review task.
 */
export const UNPAID_ASK_BILLED_OFFSET_NOTE_SCOPE = "unpaid-ask-billed-offset";

export function reviewTaskKeyParts(reviewTaskId: string | null | undefined): string[] {
  return reviewTaskId ? ["review-task", reviewTaskId] : [];
}

/**
 * The review task a queued modification credit note was scoped to, read raw
 * from its payload: both shapes it takes (queued, and as the builder rewrote it)
 * carry it under one key, as the operator retry reads it too.
 */
export function queuedReviewTaskId(operation: { requestPayload: unknown }): string | undefined {
  return readString(asRecord(operation.requestPayload)?.reviewTaskId) ?? undefined;
}
