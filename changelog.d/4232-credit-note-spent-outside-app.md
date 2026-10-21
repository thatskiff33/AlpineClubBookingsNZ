- **A credit note that was already used in Xero now fails with a plain reason,
  instead of a bare "400" from Xero (#4218).** If a treasurer used a member's
  credit note in Xero directly (for example an offset against something the member
  owed) and the app was not told, the app could still try to apply that credit to
  a new booking. Xero refused it, and the failed operation sat under Active
  failures with Xero's raw "400" message, which never said why.

  When Xero refuses a credit-note allocation because the note has less left than
  the allocation needs, the app now reads what the note has left and fails the
  operation with the reason "The credit note this allocation needs has only $X
  left in Xero; it was used outside the app. Retrying will not help until that
  credit is restored in Xero." If the use in Xero was a mistake, reverse it there
  and press **Retry in background**; the retry sends the allocation again and
  should go through. If it was deliberate, nothing in Xero needs changing: the
  invoice already shows what is still owed, but the failed row stays under Active
  failures until the planned fix (#4219) clears it. If Xero cannot be read
  to confirm it, the failure looks exactly as it did before. This change only makes the
  failure clear; it does not change any credit balance or write anything to Xero.
  Bringing the app's credit ledger into line automatically is planned separately
  (#4219).
