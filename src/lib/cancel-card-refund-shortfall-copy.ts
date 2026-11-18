/**
 * #4097 (`INV-PAY-129`): the officers' "Manual refund needed" wording for a
 * card cancellation whose card refund carried less than the refund due. Pure,
 * so the HTML template and the text body's `{{handBackNote}}`
 * (`manualRefundTaskAlertNote`) read the same sentences. Neither says what the
 * member was told: the alert's reason line does, because only the send knows
 * whether the member is being emailed.
 */

/** The alert's first sentence: the HTML's warning box, and the note's lead. */
export const CARD_REFUND_SHORTFALL_ALERT_LEAD =
  "A booking paid by card has been cancelled, and its card refund could not carry all of the refund due - the rest has not been refunded by the card refund.";

/** The alert's paragraph after its lead, shared by the HTML and the note. */
export const CARD_REFUND_SHORTFALL_ALERT_BODY =
  "The card refund covers only what the payment's records show can still go back to the card, which was less than the cancellation policy's refund; that usually means the payment's records disagree. The rest is on the payments board as up to two tasks, and neither can be marked paid back until the card refund itself has gone through. A part the payment's other (non-card) charges still hold is to be refunded by bank transfer: mark it paid back first, which records it and, where the booking has a Xero invoice, raises its refund credit note, then pay it straight after the app accepts. Any part beyond that is one the payment's records show already refunded, or that nothing holds, and the member has only been told the club will be in touch about it: check Stripe and the bank, then contact the member with what you found. Dismiss it, with a note saying how, only once you have confirmed the card refund reached the member; if it really is owed, mark it paid back first, after the bank-transfer part, then pay it by bank transfer straight after the app accepts. The reason line below gives each amount.";
