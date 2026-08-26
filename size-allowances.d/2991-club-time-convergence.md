file: src/lib/waitlist.ts
lines: 1312
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
