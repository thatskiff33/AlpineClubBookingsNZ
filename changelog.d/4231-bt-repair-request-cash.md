- **A bank-transfer payment no longer forgets a refund request it already paid
  back when Xero sends an update (#4215).** When a refund request on a
  bank-transfer booking is paid back, the booking system records the refund on
  the payment and raises the request's own credit note in Xero. But whenever
  Xero then sent an update about the cancellation's refund credit note, the
  payment's account-credit note, or a booking change's credit note on its
  invoice, the booking system recounted the payment's refunded total and left
  out only the cash the refund requests had paid back. The payment then showed
  less refunded than the club had actually paid back.

  The recount now also counts every refund request the treasurer has marked
  paid back, at the amount recorded then. It does this while the request's
  note is still waiting to go to Xero, after Xero voids it, and when the
  request was paid back before the booking had a Xero invoice, so no note was
  ever raised for it. The request's refund is never added to the cancellation's
  credit note. Voiding the cancellation's credit note in Xero still removes that
  note's refund, as before.

  The booking repair tool now reads the same figure. Before, for a request paid
  back before the booking had a Xero invoice, it could offer a cancellation
  credit note that included the request's refund as well. It now leaves that
  refund out, and passes the cancellation's amount to a person when the two
  sit side by side.

  A payment that already lost a request's refund this way is not corrected by
  itself: it is recounted only when Xero sends an update about the
  cancellation's credit note, the account-credit note, or a booking change's
  credit note on its invoice (never the request's own credit note), and that
  may not happen again. After deploying, and after any rollback and roll
  forward, run the read-only check in the Xero architecture guide's #4215
  deploy note. It lists the bank-transfer payments that read less refunded than
  their records show. Check each one in Xero, because a cancellation credit
  note voided in Xero is listed too. Then replay one of its stored credit-note
  events from Xero, Inbound events. Stop the previous release's Xero inbound
  worker before this release takes over, because while it runs it can drop the
  request's refund again.
