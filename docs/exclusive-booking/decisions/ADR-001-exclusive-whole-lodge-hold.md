# ADR-001: Exclusive (whole-lodge) booking hold

**Status:** Accepted / Implemented (shape owner-approved 2026-07-13;
implemented on `feature/lobby-display-v2` via #117–#122, merged 2026-07-14).
Amended by the **#2285 follow-up (2026-07-29)**: the bed-allocation
short-circuit below is now enforced by the lifecycle writer as well as the
board, and its accepted consequence for cross-booking planning is recorded.

**Risk:** Critical (booking capacity + availability). Requires high/xhigh-effort
implementation, adversarial capacity tests, and owner review before merge.

## Context

A booking can need **sole occupancy of a lodge** — most commonly a school or
club group — such that no other beds may be booked for its nights **even if
beds are theoretically free**. Today there is no such concept:

- **Capacity is pure bed arithmetic** (`src/lib/capacity.ts`,
  `checkCapacityForGuestRanges`): per night, `available = lodgeCapacity −
  occupiedBeds − proposedBeds`; a booking is admitted if `available ≥ 0` across
  its nights, under a per-lodge capacity lock. A 30-guest school in a 40-bed
  lodge leaves 10 beds bookable by anyone else.
- The **display "whole lodge" is a display-time heuristic only**
  (`src/lib/lodge-display-state.ts`): sole-occupancy-on-nights + (organisation
  or ≥ `WHOLE_LODGE_MIN_GUESTS`=8). It infers from live bookings and has no
  effect on booking or capacity.

We want an **explicit, intentional** flag — independent of headcount and bed
allocation — that reserves the whole lodge and blocks further admissions.

## Decision

Introduce an explicit **exclusive hold** on a booking. It is a booking-model
concept (not display-only); the display reads it.

### Owner decisions (2026-07-13)

1. **Conflicts are allowed, surfaced, and resolved manually.** Exclusivity can
   be *requested or set even when other bookings already overlap those nights.*
   The system does **not** auto-displace or refuse; it makes the conflict
   **obvious** to the booking officer, who declines or negotiates. No
   displacement engine.
2. **Two entry points.** A requester (school/group) can **request** exclusivity
   as part of a booking request; an admin can **set** exclusivity on **any**
   booking directly. The underlying flag is booking-generic — "school" is the
   primary front-door wording, re-usable/re-wordable for other groups.
3. **Pricing unchanged.** Per-guest pricing/quoting is untouched. (A separate,
   independent idea — rendering a whole-lodge invoice as a single line rather
   than a per-person breakdown — is out of scope here.)
4. **The flag is authoritative for the display.** The display's `wholeLodge`
   treatment is driven by the flag; the ≥8/sole-occupancy heuristic is demoted
   to a fallback (or retired once the flag is in use).
5. **The hold blocks new admissions even against an admin over-capacity
   override** (confirmed). The whole point is "no other beds even if capacity
   exists," so an over-capacity override must not punch into a held lodge; to add
   anyone, an admin removes/adjusts the hold.
6. **Indistinguishable from a full lodge to everyone but admins** (confirmed).
   Members and the public are **never told** a lodge is exclusively held — the
   held nights simply present as **no availability**, exactly as if every bed
   were occupied. All member-facing behaviour is identical to a genuinely full
   lodge (same "no space" messaging, same **waitlist** behaviour, same emails —
   nothing is special-cased). The exclusive nature is visible **only** on
   admin surfaces (decision 1 / conflict surfacing).

   **Amended 6 Oct 2026 (#3474) for clubs running the member lodge roster.**
   The roster lists who is staying, so beside the calendar a held night read
   as "no beds free, six people listed" and the hold was deducible by
   subtraction. The owner decided to show it rather than leave it to be
   inferred: the roster states the held nights as "reserved for a private
   booking", naming nobody and not saying whose booking it is (`INV-PRIV-017`).
   The calendar, the waitlist and every other member surface are unchanged,
   and a club without the roster module keeps this decision exactly as
   written.

### Model

- `Booking.wholeLodgeHold: Boolean @default(false)` — the authoritative flag.
  Additive, nullable-safe migration (expand-only). Fits the existing pattern of
  admin capacity fields on `Booking` (`adminCapacityHoldAt`,
  `capacityOverriddenAt`).
- `BookingRequest.exclusivityRequested: Boolean @default(false)` — the request
  path; an admin approving the request may set `wholeLodgeHold` on the resulting
  booking.
- Set-by and set-at audit fields (who/when), mirroring the capacity-override
  audit pattern, since this is an admin capacity action.

### Capacity rule (two-sided, in the capacity lock)

- **Admitting a NEW booking:** if any capacity-holding booking overlapping a
  night has `wholeLodgeHold = true`, that night is **hard-blocked** — `available
  = 0`, presented to the booking user **exactly as a full lodge** (no exclusive
  message; decision 6). The reason is known internally (for admin surfacing) but
  never surfaced to members/public, and the block is **not** bypassable by the
  over-capacity override (decision 5).
- **Setting the hold:** allowed regardless of existing overlaps (decision 1).
  No empty-lodge precondition; no auto-displacement.
- **Member-facing parity:** waitlist, availability calendars, "no space"
  messaging and emails behave identically to a genuinely full lodge — the hold
  changes *availability*, not the member experience.

### Conflict surfacing (decision 1 is only useful if conflicts are obvious)

- When an admin sets/approves exclusivity over existing overlapping bookings:
  a prominent warning listing the conflicting bookings.
- On the ordinary bookings/bed-allocation admin views: existing bookings that
  overlap an exclusive hold are visibly flagged.
- Capacity status (`getLodgeCapacityStatus`) reports the affected nights as
  exclusively held.

### Bed allocation

- Short-circuit per-bed allocation for an exclusive hold: the group implicitly
  occupies all rooms/beds; no individual bed assignment. The bed-allocation UI
  and lifecycle special-case (or skip) these bookings.

### Display

- `buildDisplayState` sets `wholeLodge` from `booking.wholeLodgeHold`
  (authoritative). The existing heuristic remains only as a fallback for
  un-flagged bookings, or is retired. No change to the occupancy-grid module
  (it already renders `wholeLodge`).

## Consequences

- A small group (e.g. 12 in a 40-bed lodge) can be a true whole-lodge booking
  when flagged — the display and capacity both respect intent, not headcount.
- The booking officer carries the conflict-resolution responsibility by design;
  the system's contract is *visibility + blocking new admissions*, not
  automated displacement.
- The capacity engine gains its first non-arithmetic rule; this is the highest-
  risk surface and needs the most test coverage (concurrent admissions,
  handovers on the hold's edges, edits to the hold's dates, override attempts).

## Security / safety considerations

- **Capacity integrity:** the two-sided rule must run inside the existing
  `acquireLodgeCapacityLock` so a hold and a concurrent admission cannot race.
  A hold set concurrently with an in-flight admission must resolve
  deterministically (lock-serialised). *(Residual, #186: cancel paths serialise
  on the club-wide key, disjoint from the per-lodge hold key, so a cancel can
  clear the hold without ever contending on that lock; the hold-set write is
  therefore a compare-and-set — an `updateMany` re-checking `capacityHoldingBookingFilter`
  at write time — so set-vs-cancel converges in either commit ordering and no
  stale hold is ever planted on a terminal, non-capacity-holding row.)*
- **Authorisation:** setting/clearing an exclusive hold is an admin capacity
  action — gate it like the over-capacity override (admin/full-admin), audited.
  A member request only sets `BookingRequest.exclusivityRequested`, never the
  booking flag directly.
- **No silent data effects:** setting a hold never cancels or mutates existing
  conflicting bookings; it only blocks *new* admissions and surfaces conflicts.
- **Privacy:** unchanged — the display still withholds individual names for a
  whole-lodge booking, showing only the group/organisation label + headcount.
- **Money adjacency:** pricing is unchanged, but because this governs who can
  book, it is money-adjacent and owner-reviewed before merge.

## Implementation surface (for the epic)

1. Schema + migration: `Booking.wholeLodgeHold` (+ audit),
   `BookingRequest.exclusivityRequested`; ledger row. ✅ #117
2. Capacity engine: hard-block new admissions on held nights; settable over
   conflicts; not override-bypassable. ✅ #118
3. Conflict surfacing: admin warnings both directions; capacity-status
   reporting. ✅ #119
4. Bed-allocation short-circuit for holds. ✅ #120
5. Request path (requester asks) + admin toggle (set on any booking) — API + UI.
   ✅ #121
6. Display: `wholeLodge` from the flag; heuristic → fallback. ✅ #122
7. Tests (capacity crown-jewel coverage), docs, full gate.

### Conflict surfacing — as built (#119, admin-only)

Both directions, and nothing member/public-facing (decision 6):

- **Setting/approving a hold.** `findOverlappingCapacityHoldingBookings`
  (`src/lib/capacity.ts`) reuses the capacity engine's overlap window +
  `capacityHoldingBookingFilter` to list the existing capacity-holding bookings
  overlapping the hold's nights. The admin exclusive-hold route
  (`.../exclusive-hold/route.ts`) and the school approval
  (`approveSchoolBookingRequest`) both return these `conflicts` and record the
  count/ids in the audit row. The set/approval still SUCCEEDS (decision 1).
- **The ordinary booking's side.** The member/admin booking detail page
  computes the same conflicts server-side (admin-gated) and the Admin-tools
  exclusive-hold control lists them; the admin bookings list and the
  bed-allocation board badge any ordinary booking that overlaps a hold
  (`overlapsExclusiveHold`). Uses the pure `bookingsOverlap` /
  `sameLodgeNullTolerant` helpers.
- **Capacity-status reporting.** `getLodgeHeldNights(lodgeId, checkIn, checkOut)`
  (`src/lib/capacity.ts`) is the admin companion to `getLodgeCapacityStatus`
  (which takes no date range): it reports which nights in a range are
  whole-lodge-held, reusing the engine's hold-night span logic.

### Bed-allocation short-circuit — as built (#120, admin-only)

A held booking implicitly occupies the whole lodge, so it needs no per-bed
allocation. In `getBedAllocationDashboard` (`src/lib/bed-allocation-board.ts`)
a held booking's guest-nights are excluded from `unallocatedGuestNights` and
never fed to the planner (so a hold can never register as an allocation gap /
stuck state), and it is represented distinctly via the additive
`exclusiveHolds` payload field (rendered as an "Exclusive whole-lodge hold — no
per-bed allocation needed" board banner). The admin bookings list's per-booking
bed-state also reports a held booking as `complete`. No `BedAllocation` rows are
generated or demanded for held bookings.

- **#2285 follow-up (2026-07-29) — the lifecycle half now enforces the rule too.** As
  originally built, only the board honoured this short-circuit; the lifecycle
  auto-allocator (`reconcileBedAllocationsForBooking` /
  `autoAllocateMissingBedNights`, `src/lib/bed-allocation-lifecycle.ts`) had no
  `wholeLodgeHold` awareness and kept creating real `BedAllocation` rows for
  held bookings — rows the board deliberately hid. The rule itself is
  unchanged; the lifecycle now implements it, keyed on the flag (not status —
  a held booking sits in an ordinary bed-allocatable status): reconcile
  **prunes** all of a held booking's allocation rows (whole-booking sweep, so
  legacy rows self-heal on any reconcile with no data migration) and never
  feeds a held booking to the planner. The admin exclusive-hold toggle route
  reconciles on **both** directions inside its transaction — setting the hold
  prunes the rows, releasing it re-plans the guests — so a released hold
  leaves the booking in a coherent, ordinary allocation state. A school
  approval that grants exclusivity runs the same flag-keyed reconcile after
  stamping the hold (a held conversion otherwise preserves pre-assigned beds
  across the guest swap, #1254 — wrong once whole-lodge-held). The two paths
  are locked in agreement by
  `src/lib/__tests__/held-booking-allocation-agreement.test.ts`.
- **#2251 follow-up — the MANUAL write paths enforce it too, and only for the
  held booking's own guests.** The short-circuit previously lived only in the
  read paths and the lifecycle, so an admin could still hand-place a held
  booking's guest on a bed; the row was accepted and then swept by the next
  reconcile. `assertGuestAndBedForAllocation` (`src/lib/bed-allocation-placement.ts`)
  is now the chokepoint for all three manual paths — single-night board
  placement, the bulk multi-night drop, and range assignment — and refuses a
  whole-lodge-held booking outright. Range assignment reports it as its own
  refusal category instead of a bare error: because a held booking owns no
  per-bed rows at all, the **whole range** is refused, and the free-nights
  action has nothing to offer.
  **Scope is unchanged and deliberate:** this refusal applies to the HELD
  booking's own guests only. An ORDINARY booking whose nights overlap someone
  else's hold is still allocatable by every path (planner, auto-allocator,
  manual single/bulk/range) — decision 1's never-refuse posture means the hold
  surfaces those bookings as `conflicts` for the officer, and the board badges
  them `overlapsExclusiveHold`, rather than blocking them. A range assign that
  refused on another booking's hold would have made this one endpoint stricter
  than the rule enforced anywhere else. **Open question for the owner:** should
  another booking's hold hard-block manual placement everywhere? If so it needs
  an amendment here plus enforcement at the chokepoint, the planner and the
  lifecycle together — today it blocks nowhere, consistently. This is the manual
  half of the same question #2317 asks of the planners (whether held nights are
  modelled as blocking occupancy).
  **Answered (owner, 1 Aug 2026, #2317): yes for the planners, no for the manual
  paths.** The automatic paths now treat a hold's nights as occupied (see the
  #2317 amendment below); manual placement keeps its never-refuse posture,
  because decision 1 makes the officer the one who resolves an overlap and a
  hard block would remove that path. The asymmetry is deliberate, not an
  oversight: the board no longer *offers* a held bed, but it still *accepts* one
  when the officer insists.

- **~~Accepted consequence of the short-circuit (#2285 follow-up, 2026-07-29):
  a held booking's nights are NOT modelled as occupied for OTHER bookings'
  planning.~~ SUPERSEDED by #2317 (owner decision, 1 Aug 2026) — see the
  amendment below.** As originally built, this ADR said a held group implicitly
  occupies every bed but expressed that occupancy only through the capacity rule
  (which blocks new admissions) — never as `BedAllocation` rows, and neither
  planner synthesised it. Before #2285 the rows the lifecycle wrongly created for
  held bookings gave the planners an accidental, undocumented occupancy signal;
  removing them removed that signal too. Two effects followed and were accepted
  at the time: an overlapping booking admitted by an officer (decision 1 never
  refuses, so overlaps exist by design) could be auto-placed onto beds the held
  group is physically using, and the cross-booking age-mix invariant (#1768,
  "Bed Allocation Lifecycle" in `docs/STATE_MACHINES.md`) could not see the held
  group's minors.

- **Amendment (#2317, owner decision 1 Aug 2026, option (a)): both planners
  model a hold's nights as unattributed, non-displaceable occupancy.** A
  blocking whole-lodge hold now contributes EVERY active bed of its lodge on
  EVERY held night to both planners' `occupiedBedNights` — the admin board
  (`getBedAllocationDashboard`) and the lifecycle auto-allocator
  (`autoAllocateMissingBedNights`) — while still creating no `BedAllocation` row
  anywhere. Source of truth: `src/lib/exclusive-hold-occupancy.ts`, which mirrors
  `custodian-occupancy.ts`.
  - The rows are #1768 "unknown occupant" rows (null booking, null guest). That
    one choice is what makes the occupancy **unattributed** — no name, no booking
    id, no age tier reaches the planner, which matters because a hold can begin
    life as a PUBLIC school request — and **non-displaceable**: the planner only
    registers an evictable occupant for rows naming both a booking and a guest,
    so no `MOVE` or `UNALLOCATE` has anything to target.
  - That protects the ROW. The BED-NIGHT needs one thing more, because decision
    1 guarantees a real `BedAllocation` row can share it — the hold prune sweeps
    only the held booking's own rows, and manual placement stays open — while
    planner occupancy is keyed `bedId:stayDate`. The planner therefore pins
    every null-booking bed-night as permanently occupied, so #1677
    whole-booking eviction releases the evicted booking's claim and never the
    hold's, and no room is sized as feasible off rows whose eviction frees
    nothing. Without that, displacing the co-located booking would have handed
    a held bed to a capacity-holding adult.
  - A tierless unknown occupant counts as an ADULT, so the #1768 age-mix
    invariant now treats a held lodge's rooms conservatively rather than being
    blind to the held group. The second accepted effect above is closed.
  - **The blocking predicate is the capacity engine's own** —
    `wholeLodgeHold` AND `bookingHoldsCapacity()` /
    `capacityHoldingBookingFilter()` over the same lodge, which is
    `getLodgeHeldNights`'s population.
    A planner can therefore never report a night as held that admission would
    let a booking into, and a stale hold flag on a booking that stopped holding
    capacity blocks nothing in either place. This is deliberately NOT the #2285
    short-circuit's predicate (the raw flag), which answers a different question:
    "may this booking own per-bed rows?". Where a lodge cannot be resolved for a
    hold or a room the planner treats the night as held — the conservative
    direction, and a dead branch anyway (both columns are NOT NULL).
  - **Effect on the officer:** an overlapping booking the officer chose to keep
    now sits in the awaiting-allocation list on the held nights instead of being
    quietly placed into a bed the held group is sleeping in. More red on the
    board, for a clash the officer was already shown when the hold was set —
    which is the point. What they read is the existing exclusive-hold banner
    plus the **Overlaps exclusive hold** chip; `NO_BED_AVAILABLE` is the
    planner's internal reason code and is not rendered anywhere, the bed grid
    does not mark held cells, and the banner comes from the board's booking
    load (guest row required) rather than the unfiltered blocking query. Adding
    a per-cell rendering or a per-night reason is deliberately out of scope
    here: this decision is about what the planners DO, not about new board UI.
  - **Manual placement is unchanged, deliberately.** Decision 1 admits overlaps
    on purpose and hands them to the booking officer to resolve by hand
    (#119/#177); hard-blocking a manual placement would remove the very
    resolution path this ADR requires. The open question in the #2251 note above
    ("should another booking's hold hard-block manual placement everywhere?")
    therefore stands answered **no** for now: the automatic paths stop guessing,
    the officer keeps the override.
  - Both writers re-read the live holds on the client that is about to write,
    mirroring the custodian re-filter — the unallocatable-booking re-check
    cannot cover a hold set on somebody ELSE's booking. Every placement
    transaction the code opens itself takes the per-lodge advisory lock as its
    first statement; a reconcile inside a caller's transaction, and the
    lifecycle's common no-displacement path (which opens none), rely on the
    re-read alone — the same posture #2286 chose for custodian holds. A
    displacement is applied only when the re-checked payload still claims the
    bed-night it frees, so a partial drop can no longer evict a provisional
    booking for an allocation that is never written. Guards:
    `src/lib/__tests__/exclusive-hold-planner-occupancy.test.ts` and the
    whole-lodge entries in
    `src/lib/__tests__/custodian-write-path-contract.test.ts`.

## Post-implementation decisions (owner, 2026-07-14)

Recorded as the children landed, to keep the design of record accurate:

- **Routing: fork-only.** The exclusive whole-lodge hold is a fork-specific
  feature and is **not** contributed upstream. It rides `feature/lobby-display-v2`
  with the other work but is excluded from any upstream PR.
- **Requester surface: school booking path only.** The member-facing
  "request exclusive use" control is exposed **only** on the school
  booking-request path (`BookingRequest.exclusivityRequested`), not on the
  general booking-request or ordinary member booking flows. Admins can still
  set/clear `Booking.wholeLodgeHold` on **any** booking (the flag is
  booking-generic; only the request front-door is school-scoped for now).
  - **SUPERSEDED 2026-07-30 (owner decision D11, issue #2263) — a signed-in
    member may now ask too; the ANONYMOUS door still may not.** A second
    front-door is added: `POST /api/booking-requests/whole-lodge`, behind an
    active-session guard, reachable from a card on Book a Stay leading to
    `/book/whole-lodge`. The four-step booking wizard is untouched. What is
    superseded is only the *school-only* scope of the ask. Everything else about
    exclusivity is unchanged: the flag on the request is still nothing but the
    ASK; only an approving admin turns it into `Booking.wholeLodgeHold`; the
    approval runs through the same `school-booking-request.ts` machinery so the
    lock ordering, hold stamping, bed-allocation prune (#2285) and post-commit
    conflict surfacing exist in one place; and decision 1 (never refuse, never
    displace) is untouched. The anonymous public GENERAL door remains unable to
    set the flag at all — an unauthenticated stranger who could would be asking
    the club to sterilise every bed on a date of their choosing.
    - **Decision 6 (no member or public disclosure) is restated as UNCHANGED,
      and is now enforced by test rather than by care.** The member front-door
      shows no availability calendar, no capacity pre-check, no price and no
      quote, and returns ONE frozen acknowledgement body for every schema-valid
      submission. The submit handler issues no availability, occupancy, season
      or pricing query at all, so uniformity is structural rather than padded.
      A Playwright spec (`e2e/whole-lodge-request.spec.ts`) submits the same
      payload against three seeded worlds — clear, ordinarily full, and
      exclusively held — from three member sessions and compares the response
      **bytes as buffers**. "My requests" reduces every internal status to one
      of four words, and a member-origin decline persists no officer note and
      emails one fixed generic sentence.
    - **The pinning test is replaced, not deleted.** The former
      `booking-request.test.ts` pin ("the whole-lodge request front-door is
      school-only (#121)") is replaced in the same change by a pair: a
      behavioural test that the public GENERAL create path still persists no
      `exclusivityRequested` key and no member attribution, and an AST
      source-scan (`src/lib/__tests__/exclusivity-request-write-sites.test.ts`)
      asserting the set of files that WRITE the flag is exactly the two
      sanctioned doors. The behavioural half cannot see a third door somebody
      adds later; the scan is what does.
    - **Retention (owner decision OD-B).** Member-origin `DECLINED` and
      `CANCELLED` (member-withdrawn) requests both purge on the existing 90-day
      Privacy Act clock, so "My requests" is a bounded history and its UI copy
      says so.
    - **Placeholder rate class (owner decision OD-A).** The member's party is
      unnamed placeholder guests, which price at NON-MEMBER rates at approval
      (`hasNonMembers: true`) as the conservative revenue default.

      **How a placeholder becomes a member-rated guest: REMOVE AND RE-ADD.**
      OD-A was ticked on the understanding that guests "re-rate per-guest as
      names and links are edited in". Review found that no in-place path exists:
      the guest-edit engine (`buildBookingModifyPlan`, `src/lib/booking-modify-plan.ts`)
      accepts `guestUpdates` for NAMES ONLY and refuses outright when the guest
      `isMember` or carries a `memberId` — member linkage cannot be changed on an
      existing guest row at all, by design (renaming must never be able to
      quietly transfer who a booking is for). So an officer converts a
      placeholder by **removing it and adding the real member as a new guest**
      (`removeGuestIds` + `addGuests` in the same batch modification), which
      prices the added guest at their own rate and settles the difference through
      the ordinary `BookingModification` refund/re-charge path. Renaming a
      placeholder alone does NOT re-rate it, and that is correct — a rename does
      not change who the person is for rate purposes.

      A first-class "link placeholder → member with in-place re-rate" is a
      separate, owner-scoped piece of work (it widens the money surface of the
      modify engine and deliberately reverses that refusal); it was filed as its
      own `needs-decision` issue (#2337).

      **UPDATE — 2 Aug 2026 (#2337, owner decision 1 Aug 2026): the in-place link
      is now BUILT, and remove-and-re-add is no longer the only route.** The owner
      chose to build the first-class "link this placeholder to a member" action,
      quote-first. It is a NEW sibling operation, not a loosened rename: the rename
      refusal above (`booking-modify-plan.ts:250-252`) is untouched — a rename
      still cannot reach isMember/memberId/rateMembershipTypeId. The link is a new
      `linkGuestToMember` input resolved by `resolveGuestMemberLinks`, gated
      narrowly to **admin/officer actors, MEMBER whole-lodge bookings only
      (`isMemberWholeLodgeBooking` — never a SCHOOL whole-lodge booking, whose
      negotiated flat-split price must not be disturbed), and UNLINKED
      placeholders only (never member→member)**, and reusing the full member-add
      eligibility (subscription/membership-type/night-conflict/family-boundary +
      MG2/MG3 consent). The linked row enters pricing with the member identity and
      its booked non-member `lockedNightPrices` cleared, so it re-rates at the
      member rate; the delta settles through the ordinary `BookingModification`
      refund/re-charge path, quoted first (the officer sees old price, new price,
      delta, and how it settles before committing). A member whole-lodge booking
      is "quote-priced" (its placeholders were flat-split at approval), so a
      link-only request is exempt from the standard quote-priced edit block — the
      link IS the sanctioned re-rate. A `GUEST_MEMBER_LINK` modification records
      the identity change. Remove-and-re-add still works and settles identically;
      the link is the one-click equivalent.

      Two further fences (#2337, review):
      **(1) pre-stay only.** The in-place link is refused once a booking is
      IN-PROGRESS (a mid-stay edit prices through `buildInProgressGuestRangePlan`,
      which is fed the ORIGINAL guests rather than the link-modified pricing rows,
      so the re-rate would silently settle $0 while stamping the member). Both the
      apply path (`resolveTargetDates`) and the quote route refuse it with the same
      `GUEST_MEMBER_LINK_IN_PROGRESS_MESSAGE`, so the officer sees the refusal in
      the preview and is pointed at remove-and-re-add, which DOES settle correctly
      mid-stay. Admin override is NOT the escape hatch — an override edit is
      date-only and rejects `linkGuestToMember`. A mid-stay in-place re-rate could
      be a future enhancement if the owner wants it.
      **(2) one member, one row.** `resolveGuestMemberLinks` refuses a link whose
      member is ALREADY on the booking (a prior committed link, or a member guest
      placed at approval), so the same person can never be billed the member rate
      twice. On the apply path `booking.guests` is the post-lock re-read, so that
      check doubles as the in-transaction re-check that closes a concurrent
      double-link.

      No
      `nonMemberHoldUntil` is stamped: the hold clock belongs to the PENDING
      non-member path, and arming a bump clock against a CONFIRMED booking that
      holds the whole lodge would point it at the one booking that must never
      be bumped (school parity — a school booking is `hasNonMembers` with no
      hold clock either).
- **Group B (pre-existing overridden settlements) — left proceeding, revisitable.**
  #118 deliberately does not hard-block the payment-settlement paths for a
  booking that was admitted over-capacity *before* a hold was later placed over
  it (decision 1: pre-existing conflicts are surfaced and resolved manually, not
  auto-displaced). This is the current behaviour by choice; revisit with
  operator feedback if a hold should also block those settlements. Documented in
  `src/lib/payment-reconciliation.ts` and `docs/CAPACITY_MODEL.md`.
  - **#177 follow-up — the blind spot is now surfaced (settlement unchanged).**
    An overridden booking that is *not yet capacity-holding* (chiefly an
    overridden `PAYMENT_PENDING`, which holds no capacity without an admin
    capacity hold, #1764) was invisible to the set-time conflict list yet still
    settles onto the held nights under this carve-out. Set-time conflict
    surfacing now additionally lists these overridden-but-not-holding overlaps,
    marked `overridden: true` ("overridden, not yet holding"), via
    `findOverlappingOverriddenNonHoldingBookings` (`src/lib/capacity.ts`) — a
    *separate* query so the capacity-holding conflict list's contract is
    unchanged for its other callers. Never-refuse and the settlement carve-out
    itself are unchanged; the officer just sees the future settle up front.
- **Custodian bed holds never contend with a whole-lodge hold (2026-07-30,
  #2286).** A `HutLeaderAssignment` may now hold one bed for a season with no
  booking anywhere (docs/CAPACITY_MODEL.md). Under decision 2 above, an
  exclusive hold reserves the **bookable** lodge; the custodian's bed sits
  outside that pool, so the two never conflict in either direction. Setting a
  hold runs no custodian check, and the set-time conflict lists
  (`findOverlappingCapacityHoldingBookings` /
  `findOverlappingOverriddenNonHoldingBookings`) inspect bookings only, so a
  custodian can never appear in them. Creating or extending a custodian hold
  over already-held nights is equally conflict-free. Capacity subtracts the
  custodian bed on both sides: on a held night the decision-6 pin still presents
  a full lodge (`occupied + available === capacity` holds), and on the hold's
  own admission path the group's headcount is checked **with** the custodian
  counted, so an over-size group surfaces as over-capacity for explicit admin
  confirmation instead of silently displacing the custodian. The hard block
  against other admissions on held nights (decision 5) is unchanged.

- **Stale hold on terminal transition — released (#177).** Every terminal
  status flip that already spreads `RELEASE_ADMIN_CAPACITY_HOLD_UPDATE` now also
  spreads `RELEASE_WHOLE_LODGE_HOLD_UPDATE`, clearing
  `wholeLodgeHold`/`wholeLodgeHoldAt`/`wholeLodgeHoldByMemberId`. Enforcement is
  status-scoped so a stale flag never blocked capacity, but a cancelled-then-
  reinstated booking would otherwise silently re-arm its old hold with a stale
  actor/audit trail. Where the transition runs with audit context (the
  `booking-cancel.ts` funnel) a `booking.exclusiveHold.released` audit is
  recorded; the cron/group-cancel bulk transitions clear the field best-effort
  without a per-booking audit, exactly as the capacity-hold sibling does.
