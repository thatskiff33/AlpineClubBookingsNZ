- **A change fee on a card booking not yet paid is now charged (#4735).**
  When a card booking that was still waiting to be paid was edited before the
  member had opened its pay page, the club's change fee was shown in the
  booking's history but never added to what the member owed, so the member
  later paid only the price.

  The edit now records the fee against the booking straight away, and the pay
  page, the saved-card charge and the switch to bank transfer all ask for the
  price plus the fee, once. Opening the pay page again does not add the fee a
  second time.
