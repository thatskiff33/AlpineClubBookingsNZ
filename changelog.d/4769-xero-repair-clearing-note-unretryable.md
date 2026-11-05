- **The Xero booking repair tool no longer queues a second allocation beside a
  clearing credit note it cannot retry (#4762).** When Xero raised the credit
  note that clears a cancelled unpaid booking's invoice but could not apply all
  of it, and that operation cannot be retried, the repair tool used to queue a
  fresh application of the whole note against the booking's first invoice,
  even where the note was meant to be split across two invoices. Where part of
  it was already applied, it said nothing at all.

  The report now says the note is blocked, gives the reason the retry is
  refused, lists the invoices left, and offers nothing. Apply those by hand in
  Xero, as for a booking change's note. Invoices you already applied by hand
  are not listed, and when none is left the note is reported as done. While
  another application of the note is still queued or running, the report
  shows that instead: let it finish, then run the report again. A failed
  application of a different size or invoice, such as one the tool queued
  earlier, is retried or reported first. Where the note's recorded plan was
  redacted, the report says the invoices left are unknown.

  A booking change's note whose operation cannot be retried now gets the same
  treatment: the report shows an application still queued or running
  instead, retries or reports another failed application first, reports the
  note as done when you applied it by hand in Xero, and lists the invoice
  left.
