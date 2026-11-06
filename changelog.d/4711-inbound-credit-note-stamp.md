- **An account-credit note synced from Xero is recorded against one member
  credit only (#4705).** When Xero told the app about an account-credit note,
  the app recorded it on the member's credit by matching the member, booking,
  amount and description, so two credits that agreed on all of those could both
  be marked with that one note.

  The app now records it the same way as a note it raised itself: on the credit
  the note's queued work named, or, where none was named, on one matching credit
  only, the oldest first. Nothing changes in Xero, and no setting or action is
  needed.
