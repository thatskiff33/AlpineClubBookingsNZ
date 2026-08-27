file: src/lib/waitlist.ts
lines: 1333
reason: one import line. The non-member hold deadline was derived by walking
  `booking.checkIn` back with `setDate(getDate() - n)`, which reads the HOST's
  clock face — n LOCAL days rather than n calendar nights, so on a
  daylight-saving weekend the hold expired an hour early or late. Replacing it
  with `addDaysDateOnly` is one line shorter at the call site and costs one line
  of `import`, for a net +1 on a file that was already 611 lines over its
  ceiling before this branch touched it. The reasoning that would otherwise have
  been a comment block here lives in `INV-DATE-014`
  (`docs/invariants/booking-dates-and-capacity.md`), which is where the rule
  belongs; the call site cites the id in one line. Splitting a 1,300-line
  waitlist module is real work and it is not this issue's — CT-6 is the Club
  Time convergence proof, and widening it into a waitlist refactor would put an
  unreviewable diff in front of the epic's one gated merge.
  #3123 adds twenty-one, fifteen of them two comments. The offer-time reprice
  judges the booking's promotion against a validity window, so
  `repriceWaitlistCandidate` gains a REQUIRED `todayAtClub` — resolved by the
  sweep before it opens the transaction that holds every active lodge's
  capacity key (`INV-LOCK-004`), positioned ahead of the optional lockout mode
  so it cannot be defaulted, and passed exactly the way
  `subscriptionLockoutMode` beside it already is. The runtime reader, because
  this module is reachable from `instrumentation.node.ts` through
  `cron-waitlist.ts`. The 1,300-line split this entry called real work is
  still real work and still not this issue's.
