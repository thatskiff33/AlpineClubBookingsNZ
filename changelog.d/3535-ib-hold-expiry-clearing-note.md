- **An unpaid booking's Xero invoice is now cleared, not "refunded" (#3535).**
  When an internet-banking booking's payment hold ran out, its still-unpaid
  invoice was answered with a refund credit note reading "Refund requested via
  internet banking" — for money nobody had paid — and that note was never
  applied to the invoice, so the treasurer found an open invoice and a floating
  credit note to match up by hand. It now gets a credit note applied straight
  against the booking's invoices, so they close, with no payment recorded
  against any bank account, worded "Invoice cleared - booking not paid".

  The same wording now also appears on the note raised when a booking is
  cancelled before any payment was taken, and on the note the Xero repair tool
  re-queues for such a booking; both used to read "Refund against original
  credit card". Where a booking was edited upward before it went unpaid, the
  note is now spread across the original and the extra invoice instead of
  being refused by Xero. If the invoices owe less than the note (part of the
  booking was paid), no note is created and the problem is shown for a person
  to resolve. A clearing note that fails can now be retried from the Xero
  operations screen, and a late payment on such a booking still warns that a
  clearing note already exists.

  Holds that expired before this change keep their old refund note; the hold
  release never picks them up again, and the repair tool's handling of them is
  #3639. Notes queued but not yet sent to Xero when this is deployed keep the
  old wording.
