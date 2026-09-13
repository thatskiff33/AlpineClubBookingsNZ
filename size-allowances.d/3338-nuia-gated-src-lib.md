# File-size allowances for #2800 (Type Safety stage E3, gated tranche)

Twenty-eight already-oversized modules gain a few lines each because
`noUncheckedIndexedAccess` made an indexed lookup's missing case explicit and
the code now handles it rather than assuming it away. Across the whole tranche
that is 1,344 added lines against 549 removed, and 394 of the added lines are
comments — the reasoning for why a lookup cannot miss, or what the code does
when it does, which is the part a reviewer and the next reader actually need.

Splitting any of these is a real refactor with its own issue and its own review,
and doing it inside a type-safety stage would bury a behaviour-preserving
decomposition inside a compiler change — the opposite of how this repository
splits files (`docs/MAINTENANCE.md` -> "Refactor history and split guidance").
Stage E4 (#2801) does not touch these files, so this is the one time they grow
for this programme.

The shapes behind the growth are the same three everywhere, and each costs a
guard plus the sentence that says why it is there:

- an "exactly one match" length check becomes a first-with-no-rest destructure,
  so the branch holds the row instead of a count that licenses a later read;
- a pricing breakdown indexed by a guest's position is read once per guest and
  refused when absent, in the terms #3031 and #3167 already set for a per-night
  amount — there is no default in a money path that is not invented money;
- a stay envelope derived from a night list reads both ends where the range is
  built, keeping the same answer when there is no night (INV-DATE, half-open).

file: src/lib/bed-allocation.ts
lines: 3802
reason: the largest single entry, and the only one over a hundred lines. The
  blossom matching in the family-cohesion planner reads five dense
  vertex-indexed vectors; they are read through one accessor that names an
  out-of-range read instead of letting `undefined` flow on as the next vector's
  index, and the matcher now returns each guest joined to its partner rather
  than a vertex array the caller reads back by position. That accessor and its
  docblock, plus the reasoning at each of the other twelve sites, is the bulk of
  the addition. Splitting the planner is #2958-shaped work on the module the
  whole capacity story runs through, and it does not belong in a compiler stage.
  The accessor's docblock also records why these three refusals do NOT go
  through the planner's `onInvariantViolation` channel (#2656), because a
  reviewer asked and the next reader will too.

file: src/lib/booking-edit-guest-ranges.ts
lines: 1982
reason: each existing strand now carries its own sold-price map instead of a
  parallel array read by position, and four party-pricing slices are read once
  and refused when absent. The money rule they are refusing under is #3031's,
  stated in this file already.

file: src/lib/member-merge.ts
lines: 2875
reason: ten inline `as unknown as Record<string, …>` delegate lookups collapse
  into one `mergeDelegate` with the reasoning for its refusal stated once
  (`INV-SSOT`); four `Promise.all` result arrays now carry their spec. Net of
  the ten deleted inline casts this is a small addition for a real consolidation.

file: src/lib/booking-modify-plan.ts
lines: 3012
reason: three write loops iterate `entries()`, and the two places a position
  then indexes the price breakdown refuse rather than default. The refusal
  belongs beside the #3031 comment block that already states the rule for the
  per-night vector one level down.

file: src/lib/booking-request.ts
lines: 2921
reason: the approval pairs each planned guest with the held row it rewrites
  before writing any of them, with the note saying why the pairing is
  load-bearing — the same hazard the `createMany` comment above it describes.

file: src/lib/booking-exception-request-service.ts
lines: 2279
reason: the proposal envelope reads both ends of its night list and each added
  guest's resolved range is read once; an unresolved range refuses rather than
  freezing a party the officer would approve blind.

file: src/lib/payment-recovery.ts
lines: 3135
reason: twelve lines. The retry schedule's clamped step carries NO numeric
  fallback: a zero would be an immediate retry, the worst wait this function
  could invent, and any other number would be a backoff nobody configured. The
  schedule's length is asserted at module load, so an empty one cannot ship.

file: src/lib/booking-batch-modification-service.ts
lines: 2494
reason: five lines. Each guest carries its own echoed nights, so the rate vector
  and its dates cannot drift from the guest they describe.

file: src/lib/booking-date-modification-service.ts
lines: 2213
reason: the guest's priced row is read once at the top of the write loop and
  reused by the four places that had each indexed the breakdown again, and the
  refusal sits ABOVE the parked condition rather than inside it. The parked
  path is the reason: it takes its amounts from the stored rows, but the night
  SET it writes still comes from the breakdown, and the `deleteMany` above has
  already removed the strand's history by then — so tolerating a missing row
  there would delete the sold-price evidence the park exists to preserve. The
  person-night guard refuses the same condition for the same reason: a guest
  counted on fewer nights than they hold is a clash it cannot see.

file: src/lib/adult-member-hosting-review.ts
lines: 4508
reason: four lines. The same-owner coverage window reads both ends of its night
  list where the envelope is derived.

file: src/lib/bed-allocation-move.ts
lines: 1441
reason: two lines. Both hold loads read both ends of the changed nights, and the
  destination's sole occupant is destructured rather than indexed twice.

file: src/lib/booking-create.ts
lines: 2038
reason: eleven lines. Promo evaluation reads each guest's priced row once and
  refuses an unpriced guest, which is #3167's rule stated where the money leaves
  the breakdown.

file: src/lib/booking-exception-approval.ts
lines: 1111
reason: sixteen lines across the party window, the frozen guest's stay range and
  the normalized-guest pairing, each with the sentence saying what absence means
  there.

file: src/lib/booking-guest-removal-service.ts
lines: 1380
reason: twenty lines. The reprice and the per-guest write each read that guest's
  breakdown row once and refuse when it is absent, under #3031.

file: src/lib/booking-request-quotes.ts
lines: 1765
reason: six lines. The single-option quote price comes from a first-with-no-rest
  read of the option list.

file: src/lib/finance-booking-metrics.ts
lines: 1292
reason: seven lines. The pipeline series refuses a date with no daily metric
  rather than charting a hole.

file: src/lib/member-lifecycle-actions.ts
lines: 1754
reason: three lines. Each delete-blocker spec carries its own count.

file: src/lib/membership-subscription-billing.ts
lines: 1529
reason: nine lines. The per-family branch reads the member's first family where
  the MISSING_FAMILY exception is already raised, and the invoiceable-entry drop
  is a filter rather than a splice over a list it is simultaneously indexing.

file: src/lib/membership-type-policy.ts
lines: 1349
reason: five lines. The refusal message reads its first block where the no-block
  sentence is already returned, so the season the closing sentence names comes
  from a value the function holds.

file: src/lib/waitlist.ts
lines: 1463
reason: eighteen lines. The offer reprice pairs each booking guest with its
  priced row and its night rows in one pass, keeping the "built first, before
  any write" ordering this function's own comment says is load-bearing.

file: src/lib/xero-inbound/credit-note-repairs.ts
lines: 992
reason: twelve lines. Four "exactly one match" checks become first-with-no-rest
  reads, so the repair holds the payment or the credit row rather than a count.

file: src/lib/xero-membership-sync.ts
lines: 1741
reason: nine lines. The subscription-invoice ranking reads its first match once
  — it is both the legacy single-code answer and the ranking's seed.

file: src/lib/xero-hardening-report.ts
lines: 1093
reason: seven lines. A duplicate canonical-link group carries the representative
  link it was filtered on.

file: src/lib/xero-applied-credit-deallocation.ts
lines: 997
reason: four lines. The sole unknown allocation is read where its amount is
  compared.

file: src/lib/xero-member-grouping-resync.ts
lines: 798
reason: four lines. The scalar fingerprint back-map reads the single tier
  itself; the three fingerprint shapes are unchanged.

file: src/lib/xero-contact-groups.ts
lines: 856
reason: three lines. A membership row for an unexpected contact id creates its
  list rather than being dropped, which would under-report a membership.

file: src/lib/xero-contacts.ts
lines: 1917
reason: twelve lines. The email search still tests the RESPONSE for a contact
  rather than testing that contact for truthiness, because the two differ in
  the direction that matters: falling through on a non-empty response would
  reach the create path and mint a second Xero contact for a member who already
  has one.

## Re-measured after the fourth `main`-into-epic sync

Six of the numbers below moved, and none of them because this tranche changed.
Bringing `main` in composed #3219's final-price extraction with this tranche's
growth on the same six files, so each is a few lines longer than either change
left it: `booking-batch-modification-service.ts` 2451, `booking-create.ts` 1990,
`booking-date-modification-service.ts` 2180, `booking-edit-guest-ranges.ts` 1982,
`booking-guest-removal-service.ts` 1355, `waitlist.ts` 1441. Measured off the
merged tree rather than added up.

`3219-review-settlement-reprices-booking.md` names the same six and needs no
change: it merged to `main`, so it is part of the base this gate measures
against and is inert. That is worth stating because it is NOT how it looks
mid-merge — with the merge staged but uncommitted the base is still the old
merge point, both fragments read as live, and the gate correctly reports six
files declared twice. Committing the merge moves the base to `main`'s tip and
the collision disappears. Resolve it after committing, not before, or you will
delete an entry that was never in conflict.
