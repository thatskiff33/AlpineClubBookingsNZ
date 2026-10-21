import type { ManualRefundTaskKind } from "@prisma/client";

/**
 * #4162 (owner decision 17 Oct 2026, `INV-ADDPAY-042`): THE OCCURRENCE-KEY
 * PREFIX of a bank refund to re-confirm - the open hand-back the nightly undo
 * of a voided bank-transfer refund note raises (`bank-refund-void-follow-up.ts`)
 * after taking that refund back out of the payment's records, so the
 * treasurer answers once whether the money went to the member. One per voided
 * note for the nightly undo, one per picked refund for a person's picks
 * (below): the key is the claim, so each undo happens once, and with the kind
 * it is the marker. A `CANCELLED_BOOKING_HAND_BACK`, so the previous app
 * version lists and completes it as an ordinary hand-back.
 *
 * Not a cancellation's own hand-back in the sense the readers below ask: the
 * money it owes was already promised (and once recorded) by the hand-back the
 * note recorded, so while it is open it is netted from refundable cash like an
 * edit's, its completion takes `lock(1)`, and it queues its own note (keyed
 * and sized on it), never the payment's one refund note.
 */
export const BANK_REFUND_VOID_FOLLOW_UP_KEY_PREFIX = "bank-refund-void:";

/** The one occurrence key of the nightly follow-up for one voided note on one payment (`INV-ADDPAY-042`). */
export function bankRefundVoidFollowUpOccurrenceKey(paymentId: string, creditNoteId: string): string {
  return `${BANK_REFUND_VOID_FOLLOW_UP_KEY_PREFIX}${paymentId}:${creditNoteId}`;
}

/**
 * #4162 final review (money A): the prefix every PICK's follow-up on one voided
 * note shares. A note may have recorded several refunds, so a person may pick
 * one refund at a time until the picks add up to the note's amount; each pick
 * is claimed under its own key, `<prefix><paymentId>:<creditNoteId>:<lineId>`.
 */
export function bankRefundVoidPickKeyPrefix(paymentId: string, creditNoteId: string): string {
  return `${bankRefundVoidFollowUpOccurrenceKey(paymentId, creditNoteId)}:`;
}

/** The occurrence key of a person's pick of one hand-back line for one voided note: the pick's claim. */
export function bankRefundVoidPickOccurrenceKey(paymentId: string, creditNoteId: string, lineId: string): string {
  return `${bankRefundVoidPickKeyPrefix(paymentId, creditNoteId)}${lineId}`;
}

/** #4162: is this task a bank refund to re-confirm after its note's void? The kind and the key prefix together. */
export function isBankRefundVoidFollowUpTask(task: {
  kind: ManualRefundTaskKind | string | null;
  occurrenceKey: string | null;
}): boolean {
  return (
    task.kind === "CANCELLED_BOOKING_HAND_BACK" &&
    (task.occurrenceKey?.startsWith(BANK_REFUND_VOID_FOLLOW_UP_KEY_PREFIX) ?? false)
  );
}

/** #4162: the follow-ups as a `ManualRefundTask` where fragment, in any status. */
export const BANK_REFUND_VOID_FOLLOW_UP_TASK_WHERE = {
  kind: "CANCELLED_BOOKING_HAND_BACK" satisfies ManualRefundTaskKind,
  occurrenceKey: { startsWith: BANK_REFUND_VOID_FOLLOW_UP_KEY_PREFIX },
} as const;
