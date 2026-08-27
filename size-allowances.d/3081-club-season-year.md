# File-size allowances for CT-4 group F1 (#2870)

The zone-aware club season year, and the roughly ninety call sites that had to
move with it. Almost every entry below is the same two or three lines: a call site
that used to read `getSeasonYear()` — the host's month — now resolves the club's
persisted timezone and derives the season from the club's own calendar day, and
says in a comment which temporal kind it is holding.

**Why splitting is not the answer for this shape of growth.** These are not new
features arriving in old files; they are one-line corrections spread across the
tree by the defect's own reach. The retired helper read its `Date` argument with
host-local getters, so no call site could be fixed on its own — the whole set had
to move together. Splitting any of these modules to absorb two corrected lines
would be a refactor chosen by a line count rather than by a seam, landed in the
same change as a money-adjacent correctness fix, which is exactly what the
allowance policy asks people not to do.

Where the growth is more than a line or two, the reason is stated on the entry.

file: src/app/api/admin/members/[id]/xero-link/route.ts
lines: 257
reason: one line. The subscription-refresh season is the club's rather than the
  container's, and the import of the retired helper becomes an import of the
  zone-aware one plus the server zone reader.

file: src/app/api/admin/members/[id]/xero-push/route.ts
lines: 388
reason: one line, and the same import swap as above.

file: src/app/api/admin/members/export/route.ts
lines: 511
reason: four lines. The export's "current season" is pinned to one moment for the
  whole file rather than re-read per row, and the three comment lines say why the
  moment is pinned — which is the property a future reader is most likely to undo
  by inlining a fresh clock read into the loop.

file: src/app/api/admin/members/import/route.ts
lines: 769
reason: one line. The age tier an imported row lands in is judged against the
  club's season start rather than the host's.

file: src/app/api/admin/membership-types/[id]/route.ts
lines: 439
reason: one line. The "current and future seasons" bound on the forced-age-tier
  check comes from the club's season.

file: src/app/api/admin/subscriptions/route.ts
lines: 411
reason: two lines. The default season year for the subscriptions list.

file: src/lib/admin-family-group-requests-service.ts
lines: 1607
reason: twenty lines, and most of them are a signature and its docblock.
  `getChildRequestTierMetadata` is SYNCHRONOUS and is called from a `.map`, so it
  cannot await the database read the club's zone needs; it now takes the season
  start as a parameter, and its docblock says why so that nobody quietly rederives
  it inside. The caller reads that value once for the whole list, which is also
  what stops two rows on one screen being judged against two different seasons —
  an age tier decides a price band. Splitting a three-field metadata helper away
  from the review service that is its only caller would put the parameter and the
  reason for it in different files.
  **Plus thirteen lines from #3123**, which is the same shape as this entry
  one level out. `formatMemberIdentityAge` now REQUIRES the club's day, so
  `findPotentialMemberMatches` and `replaceDateOfBirthWithAge` take it as a
  parameter and the list resolves the zone ONCE for both temporal questions it
  asks — the season start it already read, and the day. Most of the growth is
  the signature re-wrapping that one extra parameter forces on a nine-field
  inline object type, plus its docblock. An age LABEL decides which of two
  similar member records a reviewer is looking at, which is this screen's
  whole purpose, so two rows judged against two different days would defeat it
  exactly as two seasons would.

file: src/lib/admin-member-detail-service.ts
lines: 1697
reason: eighteen lines across two hoists plus their comments. The member payload
  now reads the club's current season ONCE before the parallel loads that consume
  it, and the age-tier restore branch shares one reference day between its two
  arms. Both hoists exist to stop the same page describing two different seasons
  three lines apart — the shape group D found on the admin dashboard — and the
  comments are what stop the next author inlining them back.
  **Plus five lines from #3104**, which is this entry's own follow-up rather than a
  separate concern: the date-of-birth decode became `parseCalendarDate` instead of
  `new Date` plus `isNaN`, because the old pair accepted `1990-02-31` and stored
  3 March, and accepted `0000-05-05`, which the corrected `computeAge` then throws
  on — a 500 where this branch already had the right answer, 422. Four of the five
  lines are the comment saying so. Recorded here because this gate measures
  against `main` and one file may hold only one allowance, so the whole 1675-to-
  1680 growth has to be one entry.
  **Plus seventeen more from #3123**, the third increment on this entry and
  the one that makes the hoist above pay twice. The single zone read now
  yields a second derived value — the club's day, computed once as the
  UTC-midnight `@db.Date` encoding — threaded to four consumers: the
  linked-guest bound, the partner-share lock prefix, the sweep and the hosting
  fan-out. Three of those run inside the transaction further down, holding the
  global cohort key, the affected lodge keys and the member lifecycle keys,
  where `INV-LOCK-004` forbids resolving the club timezone at all. Twelve of
  the seventeen lines are the comment saying so, which is what stops the next
  author computing the day twice from a zone that is already in hand.

file: src/lib/admin-members-service.ts
lines: 1750
reason: eight lines. The member listing pins one moment for the whole page and
  derives the club's season from it, and the age tier on a created member is
  judged against the club's season start. The comment states that `now` is pinned
  deliberately.
  **Plus nine lines from #3104**, the same one-line decode correction as the entry
  above plus its comment. It matters more in this file than anywhere else, and the
  comment says why: `createAdminMember` defaults `canLogin` from the age tier it
  computes two lines later, so a rolled or year-0 date could hand somebody a login
  off a band nobody chose. Same reason for being recorded here rather than in its
  own file: one allowance per path, measured against `main`.

file: src/lib/diagnostics/tools/packs/booking-evidence.ts
lines: 2178
reason: fifty-three lines, and they are the point of the change rather than
  overhead. ONE helper in this pack answered two different temporal questions — a
  booking's stored `checkIn`, and "now" — which is precisely what forced it to read
  a `Date`'s host-local components and made this pack's own evidence depend on
  where the container ran. It is now two named functions sharing one strict stored
  year-end resolution, each with a docblock saying which temporal kind it takes and
  why the other one is not the same question. The pack's existing docblock on the
  member-eligibility entry is also corrected: it claimed both entries went through
  one definition, which is no longer true and must not read as if it were, because
  the reason they may not is the whole finding. Splitting a diagnostics pack whose
  entries share a bounded read-only transaction and a SELECT-only grant allowlist
  is a real piece of work and cannot ride along with a season-year correction.
  **Plus five from #3123**: the `club-time/server` import and a four-line
  `today:` argument on `getBookingEditPolicy`, which no longer defaults it. A
  diagnostic reporting a booking as locked on the ENVIRONMENT's day would be
  describing a state the member never saw — which is the same class of
  wrongness the two-questions-one-helper finding above is about, in the pack
  whose job is detecting it.

file: src/lib/membership-subscription-billing.ts
lines: 1456
reason: fifty-four lines, of which about forty-five are two comments. The FIRST is
  the most load-bearing thing in this pull request. Approving a membership
  application reaches `queueApprovedMembershipSubscriptionCharges` with no decision
  date, so the default decides which season an IMMUTABLE subscription charge and the
  Xero invoice queued from it are written against. Two things were wrong and only
  one was visible: the default came from `APP_TIME_ZONE` rather than the club's
  persisted zone, and the season was then read off that UTC-midnight value with
  host-local getters. The comment records both, and records the measurement that
  makes the obvious remedy WRONG — handing a club-derived date to a host-local
  reader was measured across a host x club matrix to take a self-consistent Denver
  deployment from zero wrong hours to a whole wrong day. Group A's own report named
  this file as the trap wearing an easy disguise. A note that lives anywhere but on
  these two lines is a note the next author will not read before "simplifying" them.

  The second comment, and the eight-line refusal under it, are a CONCURRENCY rule.
  `getTodayDateOnly()` was pure; resolving the club's zone is a `ClubTimeSettings`
  read, and both in-module callers that pass a transaction client hold
  `pg_advisory_xact_lock` on the season. They both already supply an explicit
  decision date, so the read never happens under that lock — but that was a
  coincidence, and the refusal makes it a contract a future caller cannot break
  silently. The reasoning has to sit on the branch it guards; in a separate file it
  is a rule nobody reads before adding the caller that breaks it.

file: src/lib/nomination.ts
lines: 2565
reason: four lines. Two season reads and one age-tier reference day move onto the
  club's zone; the growth is the line wrapping the multi-argument call needs.
  **Plus seventy lines from #3104**, and they close a defect the corrected age
  read opened in this very file. `approveMemberApplication` decoded a dependent's
  date of birth — a value from an unvalidated `Json` column, reachable from an
  UNAUTHENTICATED endpoint — with `new Date(...)` and no calendar check. Once
  `computeAge` gained its stored-calendar-day precondition, a malformed value threw
  a `RangeError` inside this function's `prisma.$transaction`, where the admin
  route classifies only `MembershipApplicationError`: a bare 500, on every retry,
  for an application that could then never be approved and that no admin screen
  can edit. The seventy lines are the write-path validation in
  `createMemberApplication`, the applicant's own guard, and the one-pass dependent
  decode whose single result feeds both the tier and the stored date.
  **The reasoning and the shared helpers were EXTRACTED rather than added here**,
  into the new `src/lib/member-application-date-of-birth.ts` — sixty-six lines
  that would otherwise have landed in this file, in a module small enough to be
  under budget on its own and with one dependency instead of this file's forty. It
  also breaks the `nomination.ts` ⇄ `member-application-mapping.ts` cycle for
  these three helpers rather than deepening it. What is left here is the
  validation at the call sites, which cannot move: it is where the decision to
  refuse is taken.
  **Plus thirteen from #3123**, and the pre-transaction zone read this entry
  already records is what pays for them: it now yields TWO answers instead of
  one, the season year and the joining fee's schedule day, necessarily from
  the same read. `getEffectiveJoiningFee` stops defaulting `asOf` from the
  environment, which picked the wrong `JoiningFee` schedule row for a club
  behind its container — and that row's `amountCents` lands on an IMMUTABLE
  invoice. The measured case quoted $100 where the club's own schedule said
  $250.

file: src/lib/notices.ts
lines: 716
reason: eight lines. Both audience resolvers take a caller-supplied `now`, which
  becomes a `fixedClubClock` rather than a value read with host-local getters, and
  three comment lines say that the pinnable moment is still pinnable.

file: src/lib/seasonal-membership-assignments.ts
lines: 1736
reason: twelve lines. Three functions read the club's current season once at the
  top rather than at each comparison, and the roll-forward shares one value between
  its "is the target the current season?" test, its age-tier reconcile reference day
  and its post-copy Xero trigger — a long run must not be able to answer that
  question differently at its start and its end. The comment says so.
  **Plus fifty-five from #3123**, the largest increment on this file and the
  one that makes "once per bulk operation" structural rather than
  conventional. `getSeasonalMembershipChangePreview`'s `now` becomes REQUIRED,
  and `clubCurrentSeasonYear` stops being optional — it was optional, and the
  Xero member import was not passing it, so that loop still made the per-row
  `ClubTimeSettings` read the parameter exists to prevent. With both required
  and both derived from the caller's single zone read, this function now
  performs no settings query on any path at all. `now` bounds four "still to
  come" reads, so it decides which bookings a membership-type change is
  reported as affecting. The rest is the same pre-transaction hoist in
  `saveSeasonalMembershipAssignment` — read above the preview re-derivation,
  because the preview TOKEN is verified against that re-derivation and the two
  must not differ for a reason nobody can see — and in
  `rollForwardSeasonalMembershipAssignments`, whose per-chunk transactions
  each take the global cohort key and every affected lodge key. About forty of
  the lines are two docblocks.

file: src/lib/xero-member-import.ts
lines: 1270
reason: one line. The season the import assigns comes from the club's calendar day.
  **Plus eleven from #3123.** The one zone read this entry records now also
  yields the club's DAY, because the seasonal preview called once per matched
  member requires both — and was defaulting the day from the environment,
  which on this path meant one uncached `ClubTimeSettings` query per member
  and a long import judging its first and last members against different days.

file: src/lib/xero-operation-outbox.ts
lines: 2476
reason: one line. The season stamped on a queued cancellation operation.
  **Plus ten from #3123**, nine of them a docblock. The entrance-fee enqueue
  takes `asOf` alongside the `seasonYear` this entry recorded, for the
  identical reason: it selects the `JoiningFee` row whose `amountCents` lands
  on an immutable invoice, and resolving it below a caller's open transaction
  would read `ClubTimeSettings` on the global client while that transaction
  holds its advisory locks.

file: src/app/api/admin/lodge/route.ts
lines: 462
reason: eight lines, added by the correctness review rather than by the migration.
  `ensureDefaultSeasonSubscriptionForNewMember` REQUIRES the club's season now
  instead of defaulting it, because its other caller passes a transaction client and
  a defaulted zone read would have opened a second pool connection on the global
  Prisma client from inside somebody else's transaction. This route holds no
  transaction, so both of its two call sites simply pass the value — and the growth
  is the comment saying why the parameter is required, which is the thing a future
  reader would otherwise make optional again to save these eight lines.
