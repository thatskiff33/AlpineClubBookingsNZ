import type { PaidAnotherWayXeroPromise, PaidAnotherWayXeroQueued } from "@/lib/card-refund-paid-another-way-xero";
import { paidAnotherWayReceiptRetryInstruction } from "@/lib/paid-another-way-receipt-retry-wording";

/**
 * #3372 / #3924: the Xero words of the stuck-states "Paid another way" dialog
 * (`DeadCardRefundsPanel`) - its promise before the close, and the message
 * after it. Pure and client-safe; the panel's tests pin every sentence.
 */

/**
 * What the dialog says, before the close, about Xero (#3924 rounds 5 to 7).
 * `bankNoteWording` is the bank-transfer note's own wording, from the one home
 * of refund-note words (`describeRefundMethod("internet-banking")`, passed by
 * the server page so this client file does not bundle that module).
 */
export function xeroRefundNotePromise(
  xeroRefundNote: PaidAnotherWayXeroPromise,
  bankNoteWording: string,
  /** #4369: what a card refund note still covers, formatted (`cardNoteCoversCents`). */
  cardNoteCovers = "",
): string {
  if (xeroRefundNote === "now") {
    return `A Xero refund credit note for the amount, worded "${bankNoteWording}", is queued when you close it.`;
  }
  // #4104: a refund Stripe failed later - its card note, raised while it counted, is in Xero.
  // Delta review (D4): said for a close of any amount, in full or in part.
  if (xeroRefundNote === "covered-by-card-note") {
    return `Closing this queues two Xero documents: an invoice for ${cardNoteCovers} recording the failed card refund's money back in the Stripe account, and a Xero refund credit note for the full amount you pay back, worded "${bankNoteWording}". If you pay back less than ${cardNoteCovers}, Xero's note credits more than went back: the Xero reconciliation report lists the difference as refund coverage above the refunded total, for you to correct in Xero.`;
  }
  if (xeroRefundNote === "after-receipt") {
    return `Xero has no record of this late card charge yet. Closing it records the charge in Xero as a payment received into the Stripe account, then queues a Xero refund credit note for the amount, worded "${bankNoteWording}", against it.`;
  }
  if (xeroRefundNote === "after-receipt-on-its-way") {
    return `This late card charge's invoice is on its way to Xero but is not there yet. Once it is, a Xero refund credit note for the amount, worded "${bankNoteWording}", is queued against it.`;
  }
  // Round 9: nothing sends these until an officer retries them, so the dialog
  // never says they are on their way.
  if (xeroRefundNote === "after-receipt-failed" || xeroRefundNote === "after-receipt-held-for-officer") {
    const instruction = paidAnotherWayReceiptRetryInstruction(
      xeroRefundNote === "after-receipt-failed" ? "failed" : "held-for-officer",
      `once it is in Xero a Xero refund credit note for the amount, worded "${bankNoteWording}", is queued against it`,
    );
    return `Closing this does not send the late card charge's Xero record. ${instruction}`;
  }
  // Round 7 (UX): an invoice may still be on its way to Xero, so this never
  // says there is none.
  return "No Xero refund credit note is queued: the app has no Xero invoice it can credit for this money yet. Check Xero, and record the refund there by hand if it needs one.";
}

/** What the message after the close says it queued in Xero (`CardRefundPaidAnotherWayResult.xeroQueued`). */
export function xeroQueuedMessage(xeroQueued: PaidAnotherWayXeroQueued | undefined, bankNoteWording: string): string {
  if (xeroQueued === "refund-note") return `Its Xero refund credit note, worded "${bankNoteWording}", is queued.`;
  if (xeroQueued === "receipt-then-refund-note") {
    return `The late card charge is queued to be recorded in Xero as a payment received into the Stripe account; its refund credit note, worded "${bankNoteWording}", follows once it is.`;
  }
  if (xeroQueued === "refund-note-after-receipt") {
    return `Its Xero refund credit note, worded "${bankNoteWording}", follows once the late card charge's invoice reaches Xero.`;
  }
  // Round 9: an officer's retry is still needed; the note follows it.
  if (xeroQueued === "refund-note-after-failed-receipt" || xeroQueued === "receipt-held-for-officer") {
    return paidAnotherWayReceiptRetryInstruction(
      xeroQueued === "refund-note-after-failed-receipt" ? "failed" : "held-for-officer",
      `its refund credit note, worded "${bankNoteWording}", follows`,
    );
  }
  if (xeroQueued === "stripe-reversal-and-bank-note") {
    return `An invoice recording the failed card refund's money back in the Stripe account, for the amount its card note covered, is queued, and a Xero refund credit note worded "${bankNoteWording}" is queued for the full amount paid back.`;
  }
  return "No Xero refund credit note was queued: check the refund is recorded in Xero.";
}
