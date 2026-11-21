/**
 * #3924 round 14 (`INV-PAY-122`): WHAT AN OFFICER IS TOLD of a late capture's
 * card refunds that a card note the app tried to send may already answer
 * (`readUnnotedLateCaptureCardRefunds`, `mayBeInXeroCents`) - check Xero for
 * that credit note before recording them by hand, as a receipt that may be in
 * Xero is checked before it is retried. Round 15: "may be in Xero", never
 * "was sent": the call may have failed with no reply, or with an error that
 * is not a refusal (`xeroRefusedOperation`).
 *
 * Pure: the one home of the sentence, read by the linked change invoice's
 * 409 and every record-by-hand finding of the repair tool (`INV-SSOT`).
 */
export function cardNoteMayBeInXeroSentence(amountLabel: string): string {
  return `A refund credit note for ${amountLabel} refunded to the card may be in Xero: the app tried to send it and cannot tell whether Xero took it. Check Xero for that credit note first, and record that ${amountLabel} by hand only if Xero does not hold it.`;
}

/**
 * #4383 (`INV-PAY-110`): WHAT AN OFFICER IS TOLD of a late capture's card
 * refunds above what its capped receipt recorded
 * (`readUnnotedLateCaptureCardRefunds`, `aboveRecordedCents`). The app's note
 * stops at what Xero received; the rest of the refund matches the part the
 * receipt's alert asked the officer to record by hand, so it is recorded by
 * hand only if that part was. Pure: the one home of the sentence (`INV-SSOT`).
 */
export function cardRefundAboveRecordedSentence(amountLabel: string): string {
  return `Xero's receipt for this card payment recorded only part of it, so the app's refund credit note stops at that part. If the rest of the payment was recorded in Xero by hand, as the receipt's alert asks, record the ${amountLabel} of the refund above it by hand too; if not, record nothing.`;
}
