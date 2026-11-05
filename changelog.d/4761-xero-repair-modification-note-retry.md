- **The Xero booking repair tool no longer applies a booking change's credit note twice (#4757).**
  When Xero raised a booking change's credit note but could not apply it to the
  invoice, the repair tool used to queue a fresh application of the note beside
  the operation's own **Retry**, or beside a retry that was running at that
  moment. It now offers that operation's retry instead. While a retry is
  running, or where the operation cannot be retried, the report says the note
  is blocked and offers nothing. For a booking change's note and, as a
  deliberate change, the note that clears a cancelled unpaid booking's
  invoice, the retry is never offered while another application of the note
  is still queued or running (reported as blocked), or beside a failed
  application of a different size or invoice, such as one the tool queued
  earlier: that one is retried or reported first. The note's own failed
  attempts are left to its retry, which covers them. Where you applied part
  of an invoice-clearing note by hand, the report lists the invoices still
  to apply by hand and offers nothing. A clearing note whose operation
  cannot be retried is handled as before (#4762).
