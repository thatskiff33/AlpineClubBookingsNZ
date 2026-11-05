- **The Xero booking repair tool no longer queues a second allocation beside a
  clearing credit note it cannot retry (#4762).** When Xero raised the credit
  note that clears a cancelled unpaid booking's invoice but could not apply all
  of it, and that operation cannot be retried, the repair tool used to queue a
  fresh application of the whole note against the booking's first invoice,
  even where the note was meant to be split across two invoices. Where part of
  it was already applied, it said nothing at all.

  The report now says the note is blocked, gives the reason the retry is
  refused, and offers nothing. Apply the invoices left by hand in Xero, as for
  a booking change's note.
