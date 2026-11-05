- **Early warning when a booking's credit note was used in Xero outside the app (#4220).**
  When the treasurer uses a member's credit note in Xero directly while a booking is
  still waiting for its credit to be allocated from that note, the Xero Health
  Snapshot now counts it under **Credit used in Xero**, and the booking repair check
  reports the booking (`APPLIED_CREDIT_NOTE_CONSUMED_EXTERNALLY`) before the app first
  tries the allocation, including a booking whose credit has not been allocated at
  all yet. A cancelled booking, and one whose allocation was resolved in Xero, are
  left out, so the warning clears. It only reads: it changes no credit, invoice or
  Xero record and sends no email. It follows Xero by the webhook and sync delay.
