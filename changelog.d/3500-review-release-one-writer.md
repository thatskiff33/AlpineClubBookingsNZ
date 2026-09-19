- **Only an officer's approval releases a booking that is waiting on review
  (#3500).** The guest-add route, and three of the booking-edit modules behind
  it, carried code that would have moved a booking out of "awaiting review"
  by itself when a member added an adult. That code could never run, because
  editing is refused while a booking is under review, so nothing changes for
  members or officers - a paid booking flagged for review still has its flag
  cleared when an adult is added, and it keeps its paid status.

  The dead code is removed so the next person reading it is not told a
  self-service way out of review exists. A test now guards that the officer
  review action is the only place that release happens.
