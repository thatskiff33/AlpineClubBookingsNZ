- **A booking that costs nothing is now in the ledger when it is confirmed, whichever way it is confirmed (#4738).**
  Confirming a saved draft, accepting a waitlist offer, confirming pending guests, the overnight pending-confirm run and an admin force-confirm each mark a $0 booking paid and post its confirmation in the same step, as creating one already did. Doing it again does not post the charge a second time.
  Confirming a draft also re-checks, under the booking's locks, that it still costs nothing, so a draft priced by an edit made mid-confirm is refused rather than marked paid.
