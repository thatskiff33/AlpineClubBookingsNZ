- **The Xero booking repair report now lists a credit note an officer marked
  resolved in Xero (#4763).** When a booking change's credit note, or the note
  that clears a cancelled unpaid booking's invoice, was raised but could not be
  applied, and an officer then applied it by hand and marked the operation
  **resolved in Xero**, the report left the note out, showing at most another
  application still failing beside it.

  It now shows an information-only "resolved in Xero by an officer" finding
  naming the note, with nothing offered, and still reports any other
  application beside it without retrying it.
