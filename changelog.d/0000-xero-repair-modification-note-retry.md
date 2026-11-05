- **The Xero booking repair tool no longer applies a booking change's credit note twice (#4757).**
  When Xero raised a booking change's credit note but could not apply it to the
  invoice, the repair tool used to queue a fresh application of the note beside
  the operation's own **Retry**, or beside a retry that was running at that
  moment. It now offers that operation's retry instead. While a retry is
  running, or where the operation cannot be retried, the report says the note
  is blocked and offers nothing, as it already did for the credit note that
  clears a cancelled unpaid booking's invoice.
