# File-size allowances for #2800 (UTILITY tranche)

Every entry below is the same shape of change: a `noUncheckedIndexedAccess`
site gets a named guard, a length-checked destructure, or a short comment
citing the invariant that makes the guard unreachable, in place of an
unchecked array/regex/Record index read. None of these files gained new
behaviour; each grew by the few lines a guard or a restructured loop costs
in the function it already belonged to. Splitting any of them is
#2958-shaped work — out of scope for a type-safety migration stage — and
the guard has to sit next to the read it protects, so lifting it out would
separate the rule from its reason.

file: src/lib/club-theme-schema.ts
lines: 958
reason: the same named-refusal migration (a shared `must()` guard from an
  earlier commit on this same lane) as the rest of this file -- four
  mandatory regex capture groups and a fixed-length neutral-ramp read, each
  guarded beside the read it protects rather than asserted away.

file: src/lib/group-booking.ts
lines: 1883
reason: the non-member join's nested guest-create payload is now validated
  at this call site (stayStart/stayEnd proven non-undefined, throwing on a
  gap) because the type actually originates in buildGuestCreateData
  (booking-create-guests.ts), which is outside this tranche -- fixing it
  here is the only option that isn't a cast.

file: src/lib/admin-bookings-service.ts
lines: 1373
reason: four guarded reads (the first/last row of a non-empty page batch,
  a length-guarded month-string split used twice, and a bed-warning
  group's first allocation) plus their explanatory comments, each beside
  the read it protects.

file: src/lib/admin-members-service.ts
lines: 1754
reason: one guarded read of a Promise.all-built, 1:1-with-textMatches
  depth array inside a display-only ineligibility explanation, plus the
  comment explaining why the gap is unreachable.

file: src/lib/backup.ts
lines: 727
reason: an explicit undefined check on three parsed smoke-test counts
  before Number.isFinite, so the type sees what the runtime check already
  covered.

file: src/lib/config-transfer/categories/club-settings.ts
lines: 1145
reason: two named refusals (an empty delegate-name character, a missing
  Prisma client delegate) that turn a config-authoring mistake into a
  loud, diagnosable error instead of a silent undefined read.

file: src/lib/config-transfer/categories/site-content.ts
lines: 955
reason: one guarded mandatory regex capture group in the image-id
  extractor, with the comment recording why the group can't be absent.

file: src/lib/deploy/warmup-run.ts
lines: 892
reason: two guarded reads (a mandatory regex capture group in the CSP
  inline-script scan; a worker-pool's per-index route read against its own
  loop bound), each with the invariant that makes it unreachable.

file: src/lib/email-message-renderer.ts
lines: 950
reason: two regex-token extractors switched from `.filter(Boolean)` (which
  drops undefined at runtime but not in the type) to an explicit
  `token is string` predicate, plus the comment explaining why.

file: src/lib/group-cancel.ts
lines: 922
reason: the refund-planning branch's first-child read now throws a named
  error on a violated count invariant instead of silently computing zero
  refunds for paid children -- a money-path guard earns its explanation.

file: src/lib/induction-baseline.ts
lines: 906
reason: validateActiveTemplate reads the exactly-one template the length
  check above it already guarantees, with a named refusal restating that
  guarantee; this also cleared a follow-on return-type mismatch.

file: src/lib/lodge-display-state.ts
lines: 1010
reason: reduceName's surname-initial branch reads the guaranteed-non-empty
  first character once instead of indexing it twice.

file: src/lib/member-application-mapping.ts
lines: 1142
reason: the person/suggestion pairing is now built as one array of
  {...person, suggestions} objects in a single Promise.all pass, replacing
  a same-length array read back by position -- a few extra lines to remove
  the index correlation entirely.

file: src/lib/member-csv-import.ts
lines: 1078
reason: four guarded reads across the hand-rolled CSV parser and date
  parser (the character-loop's own bound, the header record's absence as
  its own emptiness check, two named month capture groups), each beside
  the read it protects.

file: src/lib/member-guest-email-notes.ts
lines: 824
reason: composeGuestNightsLabel's adjacent-pairs walk and its guarded
  first/last night reads replace three unchecked array indexes with their
  explanatory comments.

file: src/lib/nomination.ts
lines: 2601
reason: the largest of this tranche's guards -- one array of
  {familyMember, familyDecision, dependentDayOfBirth, dependentDateOfBirth}
  pairs replacing three parallel-array reads inside the family-member
  approval loop, plus two smaller named refusals -- in a membership
  approval transaction where each guard's reasoning has to be legible on
  its own.

file: src/lib/promo.ts
lines: 1899
reason: one call-site type predicate proving what filterGuestsByIndexes'
  `.filter(Boolean)` already guarantees at runtime, fixed here because the
  shared helper in promo-guest-scope.ts is outside this tranche.

<!-- src/lib/public-page-content-tokens.ts was declared here at 771 LOC until
#3325 routed its money label through `formatCents` and the file fell back
under its ceiling; the ratchet refuses an allowance a change no longer needs. -->
