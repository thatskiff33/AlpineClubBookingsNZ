/**
 * #4162 (owner decision 17 Oct 2026, `INV-ADDPAY-042`): what a "bank refund
 * to re-confirm" carries and says - the open hand-back the nightly undo of a
 * voided bank-transfer refund note raises (`bank-refund-void-follow-up.ts`).
 *
 * A pure leaf with no server dependency, so the refund list's card, the
 * completion route and the writer read one shape and one sentence
 * (`INV-SSOT-001`).
 */

/** The `ManualRefundTask.reviewContext` key the follow-up keeps its facts under (beside no other kind's). */
export const BANK_REFUND_VOID_FOLLOW_UP_CONTEXT_KEY = "bankRefundVoidFollowUp";

/** What the follow-up records about the void that raised it, written once at the undo. */
export interface BankRefundVoidFollowUpContext {
  /** The voided Xero credit note. */
  voidedCreditNoteId: string;
  voidedCreditNoteNumber: string | null;
  /** When the app recorded the void (the link's last write), as an ISO instant. */
  voidedAt: string;
  /** The completed hand-back whose refund the note recorded. */
  originalTaskId: string;
  /** That hand-back's `BANK_REFUND` line, which the undo reversed. */
  reversedLineId: string;
}

/** The context as the task stores it. */
export function bankRefundVoidFollowUpReviewContext(
  context: BankRefundVoidFollowUpContext,
): Record<typeof BANK_REFUND_VOID_FOLLOW_UP_CONTEXT_KEY, Record<string, string | null>> {
  return { [BANK_REFUND_VOID_FOLLOW_UP_CONTEXT_KEY]: { ...context } };
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

/** The context a follow-up keeps, or null when the column holds no readable one. */
export function readBankRefundVoidFollowUpContext(reviewContext: unknown): BankRefundVoidFollowUpContext | null {
  if (!reviewContext || typeof reviewContext !== "object" || Array.isArray(reviewContext)) return null;
  const raw = (reviewContext as Record<string, unknown>)[BANK_REFUND_VOID_FOLLOW_UP_CONTEXT_KEY];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const voidedCreditNoteId = readString(record.voidedCreditNoteId);
  const voidedAt = readString(record.voidedAt);
  const originalTaskId = readString(record.originalTaskId);
  const reversedLineId = readString(record.reversedLineId);
  if (!voidedCreditNoteId || !voidedAt || !originalTaskId || !reversedLineId) return null;
  return {
    voidedCreditNoteId,
    voidedCreditNoteNumber: readString(record.voidedCreditNoteNumber),
    voidedAt,
    originalTaskId,
    reversedLineId,
  };
}

/**
 * The two answers that complete a follow-up (the money went to the member).
 * "Not yet" leaves it on the list, and "the club keeps it" is the ordinary
 * dismissal with a reason, so neither is an answer here.
 */
export const BANK_REFUND_VOID_ANSWERS = ["fresh-note", "recorded-in-xero"] as const;
export type BankRefundVoidAnswer = (typeof BANK_REFUND_VOID_ANSWERS)[number];

/** The longest credit-note number the "already in Xero" answer accepts (Xero's own limit is 255). */
export const HAND_MADE_CREDIT_NOTE_NUMBER_MAX = 255;

/** The one question the refund list asks of a follow-up. Takes formatted parts. */
export function bankRefundVoidQuestion(parts: {
  bookingReference: string;
  amount: string;
  memberName: string;
  creditNoteNumber: string | null;
  voidedOn: string;
}): string {
  const note = parts.creditNoteNumber ? `Its Xero credit note ${parts.creditNoteNumber}` : "Its Xero credit note";
  return `Booking ${parts.bookingReference}: ${parts.amount} to ${parts.memberName}. ${note} was found voided on ${parts.voidedOn}, so it's back on this list. Has the ${parts.amount} gone to the member?`;
}

/** Each answer as the dialog offers it. */
export const BANK_REFUND_VOID_ANSWER_COPY: Record<BankRefundVoidAnswer, { label: string; help: string }> = {
  "fresh-note": {
    label: "Yes, raise a fresh credit note",
    help: "The member was paid. The refund is recorded again and one new credit note is raised in Xero, dated today.",
  },
  "recorded-in-xero": {
    label: "Yes, I already recorded it in Xero myself",
    help: "The member was paid and you made the credit note in Xero by hand. Type its number: the app checks Xero has it, live, for this amount, and tracks it from now on.",
  },
};

/** The refusal when a follow-up is completed without one of the two answers (an older screen). */
export const BANK_REFUND_VOID_ANSWER_REQUIRED_MESSAGE =
  "This refund is back on the list because its Xero credit note was voided. Say whether to raise a fresh credit note or which note you made in Xero by hand - refresh the page and answer the question.";

/** The refusal when an answer is sent for a task that is not a follow-up. */
export const BANK_REFUND_VOID_ANSWER_NOT_ASKED_MESSAGE =
  "This refund was not put back on the list by a voided credit note, so that answer does not apply. Refresh the page and try again.";

/** What the treasurer is told once a follow-up is completed on one of its answers. */
export function bankRefundVoidCompletionMessage(answer: BankRefundVoidAnswer, creditNoteNumber?: string | null): string {
  return answer === "fresh-note"
    ? "Refund recorded as paid back again. One fresh credit note is queued for Xero, dated today."
    : `Refund recorded as paid back again, against credit note ${creditNoteNumber ?? "the one you made"} in Xero, which the app now tracks.`;
}
