- Fixed: a school that has booked before can be credited or re-invoiced on its
  earlier bookings again. A refund credit note, an account-credit note, a
  modification credit note and a supplementary invoice all used to look the
  school's customer up through the invented member record the club created for
  that old booking; since the school became a customer in its own right, that
  member no longer holds one, so the club's accounting system was asked to find
  the customer by email address instead - and a school's recorded address is
  usually a teacher's own. Those four now bill the school, exactly as a new
  booking's invoice already does, and so does the repair that runs when a
  customer reference has gone stale.
- Changed: nothing else. "Who owns this booking?" is now asked in one place in
  the code rather than in several hundred, which is preparation for a booking
  being owned by a school rather than by a person. While the change was made,
  the answer is the same answer as before, at every one of those places. One
  diagnostics entry visible to administrators was accidentally renamed by that
  sweep and has been put back.
