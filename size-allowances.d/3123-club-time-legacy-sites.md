# File-size allowances for #3123 (the last legacy-zone call sites)

Twenty-eight already-over-budget files grow here. This issue deleted the
`= APP_TIME_ZONE` defaults from six `date-only.ts` helpers, so an unstated zone
stopped being a plausible answer and became a compile error — and that is what
produced the growth, in four recognisable shapes:

- **A required day or zone threaded through a call chain.** Where a value could
  not simply be read in place, every layer between the resolver and the decision
  gained a parameter. Required, never defaulted: a default is exactly what put
  the container's timezone where the club's belonged, and a required parameter
  is what makes the compiler enumerate the call sites instead.
- **A read hoisted OUT of a transaction.** `INV-LOCK-004` names the club
  timezone as one of only two reads that cannot take a transaction client, so
  the day is resolved before `$transaction` opens and passed in. The growth is
  the hoist plus the comment saying why it is hoisted — and that comment is
  load-bearing, because moving the read back down to where it is used is the
  single most likely thing a future reader will do.
- **One function split into two because it was handling both a calendar day and
  an instant.** A stored `@db.Date` takes no timezone at all; a real instant has
  no civil date until a zone is chosen. Where one helper was doing both, it
  became two.
- **A docblock explaining a line that now looks trivially safe.** Several of
  these files are SHORTER in body and longer in prose.
  `finance-booking-metrics.ts` deletes a helper outright and still grows,
  because the explanation that helper carried is now true of a parameter.

The tone is deliberate. This work removed five measured defects, all of the same
shape: refund tiers a whole tier out ($400), promotional codes refused on their
first valid day and honoured on their excluded last, a joining fee quoted at $100
where the club's own schedule said $250, a member's bed released a day before
club policy allowed, and a duplicated age rule still carrying a bug its canonical
copy had been fixed for. Every line below was bought knowingly.

**Twenty-three further files also grew and are NOT here.** Each already carries
an allowance from an earlier child of this epic, and one change may not hold two
allowance files naming the same path — so those entries had their `lines:`
corrected in place, with a paragraph recording what #3123 added, exactly as
`3110-policy-set-transaction-client.md` did for #3107.

## Routes and pages

file: src/app/(admin)/admin/members/_components/member-import-dialog.tsx
lines: 868
reason: twelve lines, and they are the browser half of a defect whose server
  half is in `member-csv-import.ts`. The import preview refuses a cancellation
  date in the future, and that comparison defaulted its "today" from
  `todayDateOnlyForTimeZone()` — the CONTAINER's zone — inside a module that
  runs in the browser and can read no timezone at all. The dialog now takes the
  club's day from `useClubTime()`, which the provider resolves on the server and
  delivers as data, and passes it into `buildMemberImportPreview`. The growth is
  that read, the four-line note saying why the viewer's own clock is never the
  answer, and the call plus its `useMemo` dependency going multi-line. Splitting
  a dialog to land twelve lines would separate the preview from the table that
  renders it.

file: src/app/api/admin/family-groups/[id]/route.ts
lines: 303
reason: nine lines on a 294-line route, six of them the comment. This screen
  exists to tell two similar member records apart (#2568), and it does that with
  a calculated age label — so `formatMemberIdentityAge` now requires the club's
  day and the route resolves it ONCE for the whole payload. Asking per member
  would let two rows of the SAME group be aged against different days across
  club midnight, which is precisely the confusion the screen is there to remove.
  Splitting a route handler to hoist one `await` would put the reason somewhere
  the reader of the payload will not look.

file: src/app/api/bookings/[id]/guests/[guestId]/route.ts
lines: 513
reason: eleven lines — one import, one hoisted `clubTodayDateOnlyInstant()` with
  its eight-line comment, and the `today:` argument. The hoist sits beside the
  `subscriptionLockoutMode` read this route already makes for the identical
  reason: `INV-LOCK-004`, and the removal runs under the per-lodge capacity key.
  What it decides is whether a member may take themselves off a stay that has
  not started, so for a club behind Greenwich the container's timezone refused a
  self-removal a whole day early. The comment IS the growth, and it is what
  stops the next reader moving the read back down to where it is used.

file: src/app/api/bookings/[id]/guests/route.ts
lines: 1229
reason: eighteen lines, thirteen of them one comment. ONE club day answers three
  questions on this path and they must agree: the edit policy's admission gate,
  and — inside the transaction — the promotion's validity window and the
  reduction refund's settlement tier. Two of the three move money, so a second
  read straddling club midnight would admit an add-guest edit under one day and
  price it under another. The day is resolved before `acquireLodgeCapacityLock`
  per `INV-LOCK-004`. Splitting a 1,208-line route inside a timezone migration
  would bury the migration's own diff.

file: src/app/api/bookings/[id]/modify-quote/route.ts
lines: 2360
reason: fourteen lines, eight of them the comment naming the FIVE decisions in
  this quote that read the club's day: the edit policy, the late-notice change
  fee's two `daysUntilDate` operands, the promotion's validity window and the
  reduction refund's settlement tier. A quote whose fee said one day and whose
  refund tier said another would be internally inconsistent, so all five come
  from one resolved value; the body shrinks slightly where the local
  `new Date()` is deleted. This route is 2,345 lines against a 250-line route
  budget and genuinely wants decomposing — but that is a large
  behaviour-preserving job with its own review, and attempting it around a
  fourteen-line correction on a money path is the trade this directory's README
  warns about. Named for follow-up rather than pretended away.

file: src/app/api/payments/switch-to-internet-banking/route.ts
lines: 450
reason: six lines — one import and the `today:` argument with a four-line
  comment. The internet-banking lead-time cutoff compares against
  `booking.checkIn`, a stored `@db.Date` calendar day carrying no zone, so the
  note says the other operand is encoded on the same UTC-midnight frame
  (`INV-DATE-026`) and comes from the club's persisted zone rather than the
  container's. That pairing is exactly the property a future reader breaks by
  "simplifying" one side of the comparison.

file: src/app/api/promo-codes/validate/route.ts
lines: 377
reason: eleven lines. The options object goes multi-line to carry `todayAtClub`,
  and six of the lines record which reader was chosen and why: no transaction is
  open here and this route is reachable from neither a CLI nor instrumentation,
  so the request-scoped `server-only` binding is the correct one. This is the
  endpoint a member's own quote screen calls, so it is where the promo-window
  defect this issue fixes was visible — a code refused on its first valid day
  and accepted on its excluded last one.

## Domain modules

file: src/lib/admin-bookings-service.ts
lines: 1350
reason: sixty-two lines, and about forty-five of them are one exported type and
  its docblock. This module answers TWO different temporal questions and both
  were on the container's zone: `Booking.checkIn` is `@db.Date`, so its bound is
  a calendar day, while `Booking.updatedAt` is a real instant, so its bounds are
  genuine instant boundaries in the club's zone. `AdminBookingsClubDay` carries
  both, resolved once per render, because `appliedBookingViewFilters` exists
  only to describe what `buildBookingWhere` did — two independent reads could
  disagree across club midnight and the diagnostics panel would then report a
  filter the list is not using. The docblock has to sit on the type: a reader
  meeting the two fields separately has no way to learn why one is a day and the
  other a zone. The `updatedTo` bound also becomes half-open, a correctness fix
  riding along, because Postgres keeps microseconds and an inclusive millisecond
  bound drops a row written in the day's final millisecond.

file: src/lib/adult-member-hosting-review.ts
lines: 3051
reason: thirty-one lines, twenty-eight of them three docblocks.
  `enqueueHostingCoverageReevaluationForMember` gains a required `today` in
  third position, ahead of its defaulted `context`, so the compiler enumerates
  every caller — nine of them across this branch. It runs inside its callers'
  transactions, takes a `Member` row lock, then bounds `checkOut >= today`
  TWICE, comparing a planning pass against a post-lock re-verify: a day resolved
  in here would both take a second pooled connection under that lock AND let the
  two passes land on different days across club midnight, surfacing as a
  spurious `HostingCoverageParticipantRetryError` on a merge nothing was wrong
  with. That cannot be said anywhere but at the parameter. The file is 3,051
  lines and wants a split; a hosting-coverage engine of that size is not one to
  re-cut inside a timezone migration.

file: src/lib/bed-allocation-lifecycle.ts
lines: 2732
reason: forty-one lines, thirty-five of them docblocks on four signatures. The
  chain here is a lock prefix and the sweep it protects:
  `acquireFuturePartnerSharedAllocationLocks` derives its lodge set from "future
  allocations", and `sweepFuturePartnerSharedAllocationsWithLocksHeld` then
  judges rows in that set — so if the two derive their day independently, the
  set that was LOCKED and the rows that are REMOVED can disagree. Each now takes
  the caller's one resolved day, and each docblock names the locks held at that
  point (`pg_advisory_xact_lock(1)`, every affected lodge key, both member keys)
  and therefore why the club's timezone cannot be read there at all
  (`INV-LOCK-004`). Splitting a 2,691-line allocation lifecycle would cut a
  locked transaction across a module boundary, which is the one refactor this
  file must not have.

file: src/lib/booking-cancel.ts
lines: 2408
reason: twenty-nine lines, twenty-three of them two comments — and one of the
  two records a measured defect. The refund tier is `daysUntilDate(checkIn)`
  against the cancellation policy's day thresholds, and it measured from the
  container's day: for a club behind Greenwich that tiered every cancellation
  one day short of the club's own published policy — a whole tier, and $400 in
  the case this issue was filed on. The started-stay gate above it had the same
  fault in the other direction, refusing a member's own cancellation a day
  early. Both now read ONE club day, resolved at the top of the function before
  any transaction opens, because the paid-path claim holds
  `pg_advisory_xact_lock(1)`. The comment also records the reader choice — the
  runtime one, because this module is instrumentation-reachable through
  `general-cron-runner` -> `booking-request.ts` — which is a fact about the
  import graph that nothing in this file would otherwise reveal.

file: src/lib/booking-date-modification-service.ts
lines: 1806
reason: twenty-five lines, sixteen of them two comments, one per entry point.
  FOUR decisions inside `modifyBookingDates`' transaction read the day and three
  of them move money: the edit policy's gate, the promotion's validity window,
  the late-notice change fee's two day-counts and the reduction refund's
  settlement tier. The local `new Date()` is deleted, so the fee's two operands
  are measured from one club day instead of from a clock read no other decision
  shared. Both entry points resolve the day before opening their transaction,
  per `INV-LOCK-004`.

file: src/lib/booking-exception-request-service.ts
lines: 2132
reason: seven lines, five of them a comment. The hold expiry that reserves beds
  now comes from the club's persisted zone, resolved in the request path and
  passed in — which is what keeps `computePolicyExceptionHoldExpiry` a pure
  function of its inputs. That purity is load-bearing rather than tidy: the
  reaper has to re-derive the identical deadline for a row that never got one.
  The comment says so at the one call site where a future reader would otherwise
  make the rule async.

file: src/lib/booking-exception-requests.ts
lines: 740
reason: twenty lines, seventeen of them the docblock and the note inside the
  branch; the file was already 720 against a 700 budget before this change.
  `zone` becomes required because turning a lodge night into the instant that
  night BEGINS is the one thing here that genuinely cannot be answered without a
  zone — unlike a stored `@db.Date` comparison, which takes none. It stays
  required, and the function stays synchronous and pure, because both callers
  loop: the reaper walks every candidate row and the request path sits inside a
  creation flow, so a zone read in here would be one uncached
  `ClubTimeSettings` query per row. The note also records that the
  unparseable-night behaviour is unchanged — the old `new Date(NaN)` guard and
  the new `null` return both mean "the cap does not apply" — which is a quiet
  contract a reader has no other way to verify.

file: src/lib/finance-booking-metrics.ts
lines: 1285
reason: four lines NET, and the body got shorter: a sixteen-line helper and its
  docblock are deleted, replaced by one parameter and one argument. What grew is
  the fourteen-line explanation on `normalizeForwardWindow`, which now says the
  `asOfDate` cut-off — the line between realised and forward-booked stays —
  comes from the club's persisted zone rather than the container's. #2682 fixed
  this same complaint from the UTC side and left its explanation in place;
  keeping that note beside a default that no longer exists would have described
  a helper the file no longer has.

file: src/lib/finance-report-mappings.ts
lines: 1058
reason: thirty-six lines, thirty of them one docblock, and the correction is to
  take a zone OFF a value rather than move it onto a different one. The fallback
  P&L period label rendered `FinanceSnapshot.periodEnd` or `asOfDate` — both
  `@db.Date` columns — through `formatNZDate`, which projected them into
  `APP_TIME_ZONE`: the identity for a club east of Greenwich, and the PREVIOUS
  day's period label on a finance report for any club west of it. The
  replacement composes the encoding-proof helper rather than wrapping it in a
  short local name, because `date-only-encoding-guard.test.ts` audits by the
  encoder's name at the call site and a rename is what once hid thirty-three
  Xero document dates from it. That reasoning belongs on the function — a reader
  of `formatSnapshotPeriodEnd` sees three nested calls and would otherwise
  shorten them.

file: src/lib/group-booking.ts
lines: 1827
reason: thirty-eight lines, and this file's own allowance history is why the
  number is worth stating exactly: the #2870 payment-link allowance recorded it
  at 1,763 — EXACTLY its base length — and said plainly that pointer-only
  comments had bought a net zero rather than a reduction. #3123 does grow it.
  `hasGroupStayFullyEnded` defaulted its "now" from the container's zone, so the
  day a group stopped accepting joins moved with the deployment rather than with
  the club. The parameter is now required; the function stays pure and sync
  because it is called from inside write paths; and each of its four callers
  resolves the club's day once, with `verifyAndCreateNonMemberJoin` reusing the
  single zone read the payment-link expiry beside it already makes. Fifteen
  lines are the docblock on that required parameter, which is what stops the
  default coming back. **Plus nineteen from the delta review of that fix**, and
  they are almost entirely prose. `joinGroupBookingAsMember` was the one function
  in this change that read the club's zone TWICE — once for the stay-ended
  refusal and the Internet Banking lead time, once again for
  `createConfirmedBooking` — with a comment between them already claiming "one
  read, one answer, for the whole join". Both reads were outside every
  transaction, so this was never a lock breach; it was a join running across club
  midnight gating one half of itself on day D and the other on D+1. The read is
  now one, and it yields two named values because the callees want two KINDS: a
  `CalendarDate` and that same day in the UTC-midnight `@db.Date` encoding the
  stored `checkOut` column is compared against. The comment saying so is the
  growth, and it is load-bearing — passing one of those where the other belongs
  is the exact conflation this issue exists to remove.

file: src/lib/group-cancel.ts
lines: 890
reason: eighteen lines, fifteen of them one comment, and it earns them. This
  module's own header already states that the refund tier must be frozen once,
  because an organiser cancel can be re-driven more than 24 hours later —
  resolving the club's day once, before the cancellation fence, is what makes
  that true for the DAY as well as for the plan. The tier is `daysUntilDate`
  against the policy thresholds for every paid child, the fence holds
  `pg_advisory_xact_lock(1)`, and this module is reachable from
  `instrumentation.node.ts` through `payment-recovery.ts`. The comment records
  the hoist, the lock reason and the reader choice, and a reader would have to
  rediscover all three.

file: src/lib/group-settlement.ts
lines: 1242
reason: seven lines — two imports and a five-line `today:` argument. The
  internet-banking cutoff for a group settlement invoice now comes from the
  club's persisted zone, read outside the settlement transaction the caller
  opens. The comment names the instrumentation path that forces the runtime
  reader (`xero-inbound/invoice.ts` -> `invoice-paid-effects.ts` -> here), which
  is the fact that decides which of the two readers is correct and is not
  discoverable from inside this file.

file: src/lib/induction-baseline.ts
lines: 898
reason: twenty-two lines, sixteen of them a docblock. The guard refusing a
  baseline date later than "today" read the container's zone, so an operator on
  the club's own last permissible day could be refused — or handed one day too
  many. The day is resolved once in `runInductionBaseline` and passed to a guard
  that stays sync and private, which is what lets that guard be tested without a
  database. The docblock also carries the one thing a reader cannot infer: the
  CLI-safe runtime reader is MANDATORY here because
  `scripts/induction-baseline.ts` imports this module through a dynamic
  `await import(...)` that the static CLI census cannot see, and `server-only`
  would be a bare throw the moment the command runs. The refusal message also
  loses its hard-coded "New Zealand", which is an `INV-CONFIG-001` correction in
  the same breath.

file: src/lib/member-csv-import.ts
lines: 1066
reason: fifteen lines, twelve of them two docblocks, and this is the server half
  of the dialog change above. Both `today` and `todayAtClub` become required
  because this module is IN THE BROWSER BUNDLE — `member-import-dialog.tsx` is
  `"use client"` — so it can read no timezone of its own at all, and a default
  here was the container's answer shipped to a browser. `todayAtClub` sits third
  on `buildMemberImportPreview`, ahead of the defaulted format mapping,
  precisely so the typechecker enumerates every call site rather than leaving
  the ones that forgot it silently green.

file: src/lib/member-guest-consent-service.ts
lines: 1180
reason: thirty-nine lines, twenty-two of them the same nine-line hoist and
  comment at the two entry points, plus a docblock on the internal helper the
  day is threaded through. Both paths hold `pg_advisory_xact_lock(1)` and the
  per-lodge capacity key by the time the day is used, and both are reached from
  `instrumentation.node.ts` through `cron-member-guest-consent-expiry`, so the
  reader must be the runtime one — `server-only` is a bare throw at import
  there. The remaining lines are two call sites re-wrapped for the new required
  argument on `enqueueHostingCoverageReevaluationForMember`.

file: src/lib/member-guest-email-notes.ts
lines: 814
reason: twenty-one lines, eighteen of them the distinction this epic exists to
  make. Two kinds of date live in this one file: a guest night and a stay's
  check-in/check-out are `@db.Date` calendar days taking no timezone, while a
  consent deadline is a real moment with no calendar day of its own. They used
  to go through ONE formatter — `formatNZDate`, the container's zone — which
  named the previous night for any club behind Greenwich. They now go through
  the two shared email seams, the SAME two `email/member-guest.ts` renders these
  values with, which is what keeps the two rendering paths this file's header
  already pairs from disagreeing about a date as well as about a word. The
  module docblock is where that has to be said, because the two calls look
  identical at the call site.

file: src/lib/member-lifecycle-actions.ts
lines: 1751
reason: fourteen lines, seven of them the comment on one hoisted read.
  `enqueueHostingCoverageReevaluationForMember` now requires the club's day and
  takes a `Member` row lock before bounding its fan-out, so the day is resolved
  before this archive review's transaction opens; the rest is the call site
  going multi-line for the new third argument.

file: src/lib/member-merge.ts
lines: 3782
reason: twenty-one lines, sixteen of them one comment, on the file where a
  second club-time read would be most expensive and least visible. Merge runs on
  a 120-second budget holding every affected lodge capacity key and a
  `Member ... FOR UPDATE`, and ONE resolved day keeps four consumers coherent:
  the lodge derivation deciding what is LOCKED, the sweep deciding what is
  REMOVED, and the hosting plan that is built, rebuilt under the participant
  locks and compared for equality. A plan and a re-plan on two different club
  days would 409 a merge nothing was wrong with, intermittently and
  unreproducibly. This file is 3,782 lines and is the largest in the tree; it
  wants its own decomposition issue, and an irreversible member-merge engine is
  the last place to attempt one alongside a correctness change.

file: src/lib/member-partner-link.ts
lines: 1418
reason: twenty-one lines, sixteen of them the same eight-line comment at both
  removal paths. Each opens a transaction taking the global cohort key, every
  affected lodge key and both member keys, and then calls the lock prefix and
  the sweep in `bed-allocation-lifecycle.ts` that now require the day — so it is
  resolved above the transaction and handed to both, which is what keeps the set
  that was LOCKED and the rows the sweep JUDGES derived from one day.
  Duplicating the comment rather than cross-referencing is deliberate: the two
  functions are three hundred lines apart and the member-facing one is the
  likelier to be edited alone.

file: src/lib/membership-cancellation-admin.ts
lines: 1157
reason: fourteen lines, seven of them the comment on one hoisted read, and the
  same shape as `member-lifecycle-actions.ts` above: the hosting fan-out takes a
  `Member` row lock before bounding on `checkOut >= today`, so the day is
  resolved before the transaction opens rather than inside it.

file: src/lib/promo.ts
lines: 2193
reason: the largest growth in this change, on the file holding the defect it was
  filed for. A promotion's booking-date window read ONE side of its own
  comparison through a zone-free stored-day helper and the OTHER side — the
  booking's `checkIn`, itself a `@db.Date` — through a helper that projected it
  into `APP_TIME_ZONE`. Two frames in one comparison, so for a club behind
  Greenwich a booking starting on the promotion's first valid day was refused
  and one starting on the excluded upper bound was allowed. About 110 of the 141
  lines are five docblocks, and they are the deliverable: `storedPromoDateKey`
  is now overloaded and documented as THE way a stored day becomes a comparison
  key here, which makes the mixed-frame comparison unrepresentable rather than
  merely fixed; `validatePromoCodeRules` takes a required `CalendarDate` instead
  of an optional `Date`, with the docblock naming the four callers that reach it
  from inside an open interactive transaction and the `INV-LOCK-004` rule
  forbidding a `ClubTimeSettings` read there; and the whole options object on
  `validateAndCalculatePromoDiscount` becomes required so the typechecker
  enumerates every call site. At 2,193 lines against a 700-line budget this
  module wants splitting, and the seam is real — the validity/window rules
  against the assignment-summary readers. Re-cutting the module that prices
  discounts inside the change correcting how it decides what day it is would put
  the correction and a structural refactor in one review. Named for follow-up
  rather than smuggled in.

## The person-night guard's doors (#3123 review)

Six more files grow, all for the SAME reason and all of it comment. An
adversarial review found that this issue had replaced a pure, zero-IO `new
Date()` inside `findBookingMemberNightConflicts` — the authoritative "is this
member already booked on one of these nights" guard — with a `ClubTimeSettings`
query, and that guard runs inside nine booking-write transactions holding
`pg_advisory_xact_lock(1)`, the per-lodge capacity key and one advisory lock per
member-linked guest. The read went to the module-level client rather than the
`db` the guard was handed, so it needed a second pooled connection under all of
that; with the pool at N and N concurrent creates in flight they all reach
`pool_timeout` together, and because the zone reader is fail-soft the symptom is
a silently WRONG club day rather than an error.

The fix is a required `today` parameter threaded from fifteen call sites, so
each door below resolves the club's day once, before its transaction opens.
The code is two or three lines per file. The rest is the explanation of why the
read may not move back down to where the value is used — which is the single
most likely thing a future reader will do, and the reason this whole class of
defect keeps coming back.

file: src/app/api/admin/booking-exception-requests/[id]/route.ts
lines: 756
reason: eleven lines on the approve-and-execute door, ten of them comment. This
  route is the ONLY caller that hands a transaction to `modifyBookingBatch` and
  `createConfirmedBooking`, so it is the only position on that path outside a
  transaction — everything below it runs under the global booking lock and the
  lodge capacity key. The comment says exactly that, because the read looks
  misplaced up here and looks natural down in the service, which is where it
  cannot go. Splitting a route to land eleven lines would separate the read from
  the call it exists to feed.

file: src/app/api/bookings/[id]/modify/route.ts
lines: 479
reason: eleven lines, eight of them the comment. `modifyBookingBatch` is
  transaction-AWARE: `withOptionalTransaction` runs its body inside the caller's
  transaction when there is one, so no line in that service is outside a
  transaction on every path and the day has to arrive as a value. This route is
  where the standalone path resolves it. The comment is what stops the next
  reader moving the read into the service "where it belongs".

file: src/app/api/bookings/quote/route.ts
lines: 484
reason: twelve lines, eleven of them comment, for one `clubTodayDateOnlyInstant()`
  call. The quote path holds no locks at all — so the explanation is doing all
  the work here: it records that the guard's `today` is required for the sake of
  the NINE callers that do hold locks, and that a default on the shared guard
  would be a default for all of them. Without that, the obvious future
  simplification is to give the parameter a default and delete this line.

file: src/lib/booking-request-quotes.ts
lines: 1746
reason: twenty-eight lines across two entry points. `holdBookingRequestSlots`
  resolves the club day before its transaction takes the lodge capacity key and
  the per-member night locks; `findLinkedGuestMemberNightConflicts` gains a
  required `today` with the docblock saying why an advisory, lock-free path
  still may not default it. Both comments name the runtime reader and say why —
  `src/instrumentation.node.ts` reaches this module through the booking-request
  cron chain, where `@/lib/club-time/server`'s `server-only` is a bare throw at
  import. That sentence has already been rediscovered twice in this epic.

file: src/lib/school-booking-request.ts
lines: 2555
reason: fifty-two lines across the two approval pipelines, and only two of them
  are code. Each pipeline gains one hoisted club-day read plus a comment, and
  the comment is longer than usual for a measured reason: it also records that
  the global lock must be named in PROSE here rather than spelled as its raw
  call, because `advisory-lock-guard.test.ts` counts that literal inside each
  approval block and reads a second occurrence as a second acquisition. Writing
  it the obvious way broke that contract during this very change.

file: src/lib/waitlist-cross-lodge.ts
lines: 965
reason: nine lines, seven of them comment, for one read before
  `createConfirmedBooking`. The comment records the fact that makes the position
  correct — that all three of this confirm's transaction spans have closed by
  here — which is not visible from the call site and is exactly what a future
  edit could invalidate by moving the call up.
