- **A saved-card charge that was interrupted no longer leaves a booking
  confirmed but unpaid (#4993).** When the app charges a member's saved card,
  it first marks the booking Confirmed so its beds are held while the card is
  charged. If the app stopped part-way through, or could not hand the booking
  back after the card was declined, the booking stayed Confirmed and unpaid,
  holding beds, until someone noticed.

  Each claim is now recorded on the booking. The confirm-pending job returns
  any such booking that has been stuck for more than 30 minutes to Pending,
  and charges it again in the same run by repeating the original attempt, so
  the card is never charged twice. Both events appear in Admin -> Audit log as
  critical payment entries ("Interrupted saved-card charge returned to
  Pending" and "Saved-card charge claim could not be released"). There is
  nothing to configure.
