- **The "already booked that night" check no longer queries the database while
  a booking is being written (#3123).** Every booking write — creating a
  booking, changing its dates, adding a guest, approving a request, converting a
  quote — runs inside a single database transaction that holds several locks so
  two people cannot claim the same bed at once. Inside that transaction sits the
  check that stops one member being booked on two overlapping stays.

  Moving that check onto the club's own calendar had, in an earlier draft of this
  work, made it fetch the club's timezone from the database at that exact point.
  That fetch needs a second database connection while the first one is still
  held, so under load — several people booking at the same moment — every
  booking in flight could end up holding one connection and waiting for another
  that nothing can release until it finishes. The timezone lookup is written to
  never fail loudly, so the visible symptom would not have been an error message:
  it would have been the site quietly using the wrong day when deciding whether a
  member may take themselves off somebody else's booking, with the warning in the
  log appearing at most once a minute.

  The club's day is now worked out once, before the booking write begins, and
  handed to the check as a value. Nothing about the answer changes; the work
  simply happens where it is safe to do it. The same correction was applied to
  the batch-edit service, the confirmed-booking service and the booking
  diagnostics pack, each of which can be handed a transaction that another part
  of the system has already opened.

- **A guard that was supposed to catch this could not see it (#3123).** The
  automated check that enforces "never read the club's timezone inside a
  transaction" recognised only one way of opening a transaction. Two services
  open theirs through a shared helper, so the guard reported them as clean while
  they were doing exactly what it exists to forbid. It now recognises that helper
  too, and additionally treats any service that can be handed somebody else's
  transaction as being inside one from its first line — because on that path it
  is.
