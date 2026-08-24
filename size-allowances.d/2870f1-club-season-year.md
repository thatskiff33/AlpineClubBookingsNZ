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
lines: 384
reason: one line, and the same import swap as above.

file: src/app/api/admin/members/export/route.ts
lines: 511
reason: four lines. The export's "current season" is pinned to one moment for the
  whole file rather than re-read per row, and the three comment lines say why the
  moment is pinned — which is the property a future reader is most likely to undo
  by inlining a fresh clock read into the loop.

file: src/app/api/admin/members/import/route.ts
lines: 765
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
lines: 1594
reason: twenty lines, and most of them are a signature and its docblock.
  `getChildRequestTierMetadata` is SYNCHRONOUS and is called from a `.map`, so it
  cannot await the database read the club's zone needs; it now takes the season
  start as a parameter, and its docblock says why so that nobody quietly rederives
  it inside. The caller reads that value once for the whole list, which is also
  what stops two rows on one screen being judged against two different seasons —
  an age tier decides a price band. Splitting a three-field metadata helper away
  from the review service that is its only caller would put the parameter and the
  reason for it in different files.

file: src/lib/admin-member-detail-service.ts
lines: 1675
reason: eighteen lines across two hoists plus their comments. The member payload
  now reads the club's current season ONCE before the parallel loads that consume
  it, and the age-tier restore branch shares one reference day between its two
  arms. Both hoists exist to stop the same page describing two different seasons
  three lines apart — the shape group D found on the admin dashboard — and the
  comments are what stop the next author inlining them back.

file: src/lib/admin-members-service.ts
lines: 1734
reason: eight lines. The member listing pins one moment for the whole page and
  derives the club's season from it, and the age tier on a created member is
  judged against the club's season start. The comment states that `now` is pinned
  deliberately.

file: src/lib/diagnostics/tools/packs/booking-evidence.ts
lines: 2105
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

file: src/lib/membership-subscription-billing.ts
lines: 1437
reason: thirty-five lines, of which about thirty are one comment — and that comment
  is the most load-bearing thing in this pull request. Approving a membership
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

file: src/lib/nomination.ts
lines: 2452
reason: four lines. Two season reads and one age-tier reference day move onto the
  club's zone; the growth is the line wrapping the multi-argument call needs.

file: src/lib/notices.ts
lines: 716
reason: eight lines. Both audience resolvers take a caller-supplied `now`, which
  becomes a `fixedClubClock` rather than a value read with host-local getters, and
  three comment lines say that the pinnable moment is still pinnable.

file: src/lib/seasonal-membership-assignments.ts
lines: 1667
reason: twelve lines. Three functions read the club's current season once at the
  top rather than at each comparison, and the roll-forward shares one value between
  its "is the target the current season?" test, its age-tier reconcile reference day
  and its post-copy Xero trigger — a long run must not be able to answer that
  question differently at its start and its end. The comment says so.

file: src/lib/xero-member-import.ts
lines: 1231
reason: one line. The season the import assigns comes from the club's calendar day.

file: src/lib/xero-operation-outbox.ts
lines: 2453
reason: one line. The season stamped on a queued cancellation operation.
