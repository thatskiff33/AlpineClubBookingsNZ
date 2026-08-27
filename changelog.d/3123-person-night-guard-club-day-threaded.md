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

  A follow-up review then found the same blind spot a second time: there is a
  *third* way of opening a transaction here — the helper the support and
  diagnostics evidence reads use — and the guard could not see into that one
  either. Putting the original fault back into the booking diagnostics pack was
  measured, and the guard stayed green over it. It now recognises that helper as
  well, and, more usefully, it no longer relies on somebody remembering to add
  the next one: it scans the codebase for anything that opens a transaction
  behind its own name and fails if it finds one it has not been told about. The
  same treatment was given to the list of files it checks, which was also
  maintained by hand.

- **A group join now works out the club's day once, not twice (#3123).** Joining
  somebody else's group booking asked "what is today at the club?" twice — once
  when refusing a join onto a stay that has already finished and when checking
  the Internet Banking cut-off, and again when creating the joiner's own
  booking. A join that happened to run across midnight at the club could get two
  different answers, so the two halves of the same join could disagree about
  which day it was — with the second answer deciding whether a promotion was
  still valid and whether the booking counted as a retroactive one. The day is
  now worked out once, at the top of the join, and used for all of it.
