- **Approving a manual credit grant now raises its Xero credit note (#4431).**
  The admin who requests the credit chooses the account: the member's own
  money (an overpayment or a double charge) or goodwill. The admin who
  approves sees that choice and cannot change it. Approval queues one Xero
  credit note for that credit. Spending the credit uses that note.

  A deduction is refused while the member still has credit that already has
  a Xero note, because the note would stay at its full amount. Older credit
  that was granted before this change, and never had a note, is unchanged:
  it still gets its note when the member spends it. A grant requested before
  an account was chosen has to be rejected and requested again.
