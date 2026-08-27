# File-size allowances for #2870 (CT-4a — the admin API on the club-time boundary)
> **Line counts refreshed by CT-4 group F3 (#2870).** That group hoisted the
> shared helpers these files each wrote out privately, so several of them are now
> SHORTER than this file recorded and four are two or three lines longer where a
> two-line import pair became one multi-line import. The gate requires
> `lines:` to equal the file's real length, so the numbers below were reset to
> what the tree holds; nothing about the reasoning above changed, and no file
> here crossed a ceiling it was not already over.

Thirteen route handlers move off the legacy timezone adapters and onto the
club-time kernel. Seven of them are already over the 250-line route budget — they
were before this change and none is restructured by it — and each grows by three
to seven lines. The growth is the same two things everywhere:

- **The import cost, which no split can remove.** A migrated file needs
  `@/lib/club-time` for the pure operations and `@/lib/club-time/server` for the
  request-scoped binding, because the second carries `import "server-only"` and
  the first must stay reachable from the browser bundle. That is two lines where
  the legacy adapter was one, on every file, and lifting it into a shared module
  would just be re-creating the adapter this epic exists to retire.
- **A sentence saying which kind of value the line holds.** This whole class of
  defect is invisible: a calendar day projected through the club zone, or a "today"
  read from the container's `TZ`, gives the RIGHT answer in New Zealand and the
  wrong one for a club behind UTC. The corrected code looks exactly like the code
  it replaces, so the reason has to sit at the line, or the next edit puts it back.
  `src/app/api/admin/reports/route.ts` shows what happens when it does not: CT-3
  already had to spend an allowance there for the same explanation, one issue ago.

Splitting is the better answer where it is available, and it is not available
here: these are seven unrelated route handlers, the seams they need are seven
separate refactors, and re-cutting a 1,278-line deletion-approval route inside a
timezone migration would bury the migration's diff and put an irreversible
member-erasure flow at risk for an unrelated reason. Where the budget could be
met, it was met — `reports/route.ts` gained the whole two-encoding window
derivation and still comes out at exactly its base length, so it needs no
allowance and does not collide with the one CT-3 left behind.

file: src/app/api/admin/age-tier-settings/route.ts
lines: 286
reason: nine lines. One is the second club-time import; the rest explain why the
  live-guest cut-off is now resolved BEFORE the transaction opens — reading the
  club's settings row is a second query, and it must not run on another
  connection while this one holds a write transaction — and why it is resolved
  only for a save that actually drops a tier, so an ordinary settings PUT does
  not pay for a read it will never use. The conditional needs the branch below
  to test the resolved cut-off rather than the tier list, and a reader meeting
  that test deserves to be told the two are the same question.

file: src/app/api/admin/bookings/[id]/force-confirm/route.ts
lines: 369
reason: seven lines. Two are the club-time imports, one is the hoisted
  cut-off itself, and four say why it is hoisted: the transaction below takes
  `pg_advisory_xact_lock(1)`, so a settings read inside it would make the global
  lock wait on a second connection. Inlining the read to save the line is the one
  thing this comment exists to stop.

file: src/app/api/admin/deletion-requests/[id]/route.ts
lines: 1284
reason: three lines on a 1,275-line route, extending an existing comment to say
  that the future-stay cut-off now comes from the persisted club timezone and is
  re-encoded to UTC midnight because that is the only bound shape a `@db.Date`
  column accepts. Splitting this route is a real job; doing it around a
  three-line change to an irreversible anonymisation flow is not.
  #3123 adds seven: one hoisted `clubTodayDateOnlyInstant()` above the
  anonymisation transaction with its five-line comment, and the day threaded
  into the three calls that now require it — the partner-share lock prefix,
  the sweep, and the hosting fan-out. That transaction holds the global cohort
  key, every affected lodge key and the member lifecycle keys, so the club's
  timezone cannot be read inside it at all. The split this entry already calls
  a real job is still a real job, and still not one to attempt around seven
  lines on an irreversible flow.

file: src/app/api/admin/members/bulk-update/route.ts
lines: 743
reason: four lines — the second club-time import, and three saying that the
  "future linked-guest booking" cut-off is a calendar day rather than an instant.
  The bound guards whether a member may be flipped to an age tier that cannot be
  a guest, so a day either way changes who the batch refuses.
  #3123 adds twenty-three, nine of them one comment. The same pre-transaction
  hoist as the deletion route above, plus two
  `enqueueHostingCoverageReevaluationForMember` calls re-wrapped across lines
  for its new required third argument and two sweeps taking the day. The extra
  reason this route states out loud: a bulk action touching dozens of members
  must judge every one of them against the SAME day, which per-member reads
  straddling club midnight would not.

file: src/app/api/admin/promo-codes/[id]/redemptions/route.ts
lines: 381
reason: seventeen lines. Three are the note that `PromoRedemption.createdAt` is a
  real instant, so its window edges are civil-day boundaries in the club's
  persisted zone — unlike the `@db.Date` check-in dates rendered eleven lines
  below, which take no zone at all. The two kinds sit in one file and the
  difference is the point. The other fourteen are a guard, with its reason, for a
  `to` of `9999-12-31`: a real day with no day after it, so the half-open club-day
  end throws a `RangeError` from outside any `try` and the request dies as an
  unhandled rejection. It belongs at the other range guard it sits beside, not in
  a helper a reader of this filter would never open.

file: src/app/api/admin/refund-requests/[id]/route.ts
lines: 461
reason: five lines of comment across the two branches that build the member's
  refund-outcome email. They record the defect this change fixes — the lodge
  nights were rendered with an INSTANT formatter, so a club behind UTC told the
  member their stay started a day earlier than it does — and the explanation has
  to sit at both branches, because the wrong version looked deliberate and agrees
  with the right one in New Zealand.

file: src/app/api/admin/subscription-billing/route.ts
lines: 328
reason: four lines, two of them the club-time imports. The other two say why the
  default decision date is the club's calendar day rather than the container's:
  it decides which members the treasurer is about to invoice, so it is a finance
  decision and belongs at the line that makes it.
