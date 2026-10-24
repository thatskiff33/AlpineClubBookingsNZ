/**
 * #4300 (`INV-PAY-138`) - the words of the refused-superseded-capture alert
 * (`admin-superseded-capture-refused`), shared by its hand-built HTML
 * (`email-templates/admin-superseded-capture-refused.ts`) and the
 * `{{supersededCaptureNote}}` token. Like `duplicate-capture-kept-note.ts`, it
 * imports nothing.
 *
 * Worded by the booking's status: a cancelled booking does not "still owe".
 */
export function supersededCaptureRefusedParagraph({ bookingCancelled }: { bookingCancelled: boolean }): string {
  return bookingCancelled
    ? "The booking has been cancelled, so this payment does not pay for anything. The club's superseded-payment refund returns it to the card, or holds it for a treasurer to approve if the club refunds late payments by hand."
    : "It did not mark the booking paid: the club's superseded-payment refund returns it to the card. The booking still owes its payment.";
}

/** What a person checks, by the same status. */
export function supersededCaptureRefusedAction({ bookingCancelled }: { bookingCancelled: boolean }): string {
  return bookingCancelled
    ? "Check that the payment is returned to the member, or approve its refund if it is waiting for a treasurer."
    : "Check that the refund completes, and that the member pays the amount the booking shows now. If the refund stalls, the payment is listed under Refunds owed on the Payments page.";
}
