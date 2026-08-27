- **Booking changes no longer take a second database connection while holding
  the booking locks (#3110).** When a member or an officer cancelled a booking,
  moved its dates, removed a guest or confirmed a waitlist offer, the code that
  looks up the club's cancellation rules and non-member hold period opened its
  own database connection, separately from the one the booking change was
  already using.

  Nothing was wrong with the answer it gave. The cost was under load: the
  booking change holds the club-wide booking lock and the lodge's capacity lock
  while it waits for that second connection, so on a busy evening enough
  simultaneous changes could each be holding a connection while waiting for one,
  and bookings would slow down or time out for everybody at once.

  Those lookups now use the connection the booking change already holds. Nine
  places were corrected, and a new check on the source code fails the build if a
  tenth is ever added, so this cannot quietly come back. Operators will notice
  nothing different about how cancellation fees, refund tiers or hold periods
  are calculated -- the rules and the figures are unchanged.
