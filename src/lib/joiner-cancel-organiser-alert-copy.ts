/**
 * #3949 (`INV-PAY-137`; owner decision, 22 Oct 2026): the officers' "Manual
 * refund needed" wording when a joiner cancels their own place in a group the
 * organiser paid for by Internet Banking. Its refund goes back to the
 * ORGANISER by bank transfer, as a hand-back task. Pure, so the HTML template
 * and the text body's `{{handBackNote}}` (`manualRefundTaskAlertNote`) read the
 * same sentences. Officer-facing, so it cites no issue numbers: the automatic
 * Xero notes it says are still to come are #4292.
 */

/** The alert's first sentence: the HTML's warning box, and the note's lead. */
export const JOINER_CANCEL_ORGANISER_ALERT_LEAD =
  "A joiner has cancelled their own place in a group the organiser paid for by Internet Banking, and the club has to repay the organiser by bank transfer - nothing has been refunded automatically.";

/** The alert's paragraph after its lead, shared by the HTML and the note. */
export const JOINER_CANCEL_ORGANISER_ALERT_BODY =
  "The refund was worked out under the club's card refund tiers, as every refund to the organiser is, and the money came from the organiser's group payment, so it goes back to the organiser, never to the joiner. Pay the organiser, then mark the task paid back on the payments board so the ledger records the refund. Until automatic Xero notes are added, the app raises no Xero credit note for it: once you mark it paid back, admins are emailed to credit the group's Xero invoice by hand. If the organiser declines it, or it was settled another way, dismiss the task with a note.";
