- **A late card payment a treasurer keeps is now recorded in Xero (#3635).**
  Where a club has a treasurer approve the refund of a card payment that went
  through after its booking was cancelled, choosing to keep the money used to
  leave nothing in Xero naming it, so the Stripe payout held cash the accounts
  could not explain. A payment for a change to the booking was worse: its
  waiting Xero invoice was retired while the treasurer was still deciding, and
  could never come back.

  Now the change's invoice waits until the treasurer decides. Keeping the
  money raises a Xero invoice for it, paid from the Stripe bank account, the
  same way any card payment is recorded: the change's own invoice, or for the
  booking's own payment a separate "Payment kept after cancellation" invoice
  for exactly what the card paid. The booking's original invoice and any note
  that cleared it are left alone, so the money is counted once, and nothing has
  to be recorded by hand. Refunding it, or closing it after refunding it in the
  Stripe dashboard, records nothing; reopening a kept one and then refunding it
  withdraws an invoice not yet sent, or credits back one already sent.

  The email telling admins a late payment is held for approval is now tried
  again a day later if nobody could receive it, instead of being lost.
