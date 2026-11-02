- **Each account-credit note in Xero is now recorded against the one member
  credit it was raised for (#4685).** When a booking's refund was held as
  account credit, the app recorded the resulting Xero credit note on the
  member's credit by matching the member, booking, amount and description. Two
  credits that agreed on all of those could both be marked with the first note,
  leaving a later note recorded against nothing.

  The note's queued work now names its credit, and the app records the note on
  that credit alone. Work queued before this release, which names no credit, is
  still recorded by the old match, but on one credit only. Nothing changes in
  Xero, and no setting or action is needed.
