- **Membership subscription invoices are raised again, and the ones that
  failed can be retried (#3971).** Every membership subscription charge failed
  in Xero with "Membership subscription charge not found: [REDACTED]", so
  those members were never invoiced. The job stored the charge it was meant to invoice under a name the
  system's privacy filter hides, and then could not read it back. It now takes
  the charge from the record the job is attached to, which the filter never
  touches. Card-payment details are hidden in the logs exactly as before.

  **What an officer must do after this release:** open **Xero → Operations**,
  find each failed membership subscription invoice row, and press **Retry in
  background**. That screen used to say "This invoice retry path is not
  supported by the current replay helper". The row goes back to the queue and
  the next Xero run invoices and emails the member. Retry is refused for a
  charge that already has a Xero invoice, so it cannot bill anyone twice. If
  one charge has several failed rows, retry one and mark the rest resolved
  once it has gone through.
