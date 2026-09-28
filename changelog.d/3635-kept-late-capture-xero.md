- **A late card payment a treasurer keeps is now recorded in Xero (#3635).**
  Where a club has a treasurer approve the refund of a card payment that went
  through after its booking was cancelled, choosing to keep the money used to
  leave nothing in Xero naming it, so the Stripe payout held cash the accounts
  could not explain. A payment for a change to the booking was worse: its
  waiting Xero invoice was retired while the treasurer was still deciding, and
  could never come back.

  Now the change's invoice waits until the treasurer decides. Keeping the
  money records it in Xero the same way any card payment is recorded: an
  invoice for what the card paid, dated the day Stripe took it, paid from the
  Stripe bank account that day. For a change to a booking Xero had invoiced
  that is the change's own invoice; otherwise a separate "Payment kept after
  cancellation" invoice. The booking's original invoice and any note that
  cleared it are left alone, so the money is counted once, and any refund of it
  (including one made in the Stripe dashboard) is recorded as an ordinary refund
  credit note against it. A refund of a late payment Xero never recorded no
  longer raises a refund note against the booking's old, already-cleared
  invoice, which used to show money leaving the Stripe account that never came
  in. Reopening a kept one and then refunding it withdraws an invoice not yet
  sent, or credits back one already sent. The Xero repair tool records any kept
  payment Xero is missing.

  The email telling admins a late payment is held for approval is now tried
  again a day later by the payments cron if nobody could receive it, while the
  payment is still waiting for a decision.
