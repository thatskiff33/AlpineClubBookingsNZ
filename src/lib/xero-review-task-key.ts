import { asRecord, readString } from "@/lib/xero-json";

/**
 * #3791: the key parts that scope a modification credit note to ONE review
 * task. Two reviews of one edit each settle their own share against the same
 * `BookingModification`, so an anchor-and-amount key would fold two equal
 * shares into one note. The amount stays in every key (`INV-MOD-058`); this
 * adds the task beside it, and nothing at all where there is no task, so every
 * key written before it is unchanged.
 */
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
