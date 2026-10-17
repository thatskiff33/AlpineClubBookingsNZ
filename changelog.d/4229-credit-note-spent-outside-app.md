- **A booking's account credit that was already spent in Xero now fails once, with
  a plain reason, instead of failing the same way on every retry (#4218).** If a
  treasurer used a member's credit note in Xero directly (for example an offset
  against something the member owed) and the app was not told, the app could
  still apply that credit to a new booking. Xero then refused the allocation, and
  the failed operation sat under Active failures with a bare "400" and a Retry
  button that could never work.

  Before it sends an allocation, the app now asks Xero what the credit note has
  left. If the note has less than the allocation needs, the operation fails once
  with the reason "The credit note this allocation needs has only $X left in Xero;
  it was used outside the app", and it no longer offers Retry. If Xero cannot be
  reached, or the note looks unusual, nothing changes from before. This change
  only makes the failure clear and final; it does not change any credit balance
  or write anything to Xero.
