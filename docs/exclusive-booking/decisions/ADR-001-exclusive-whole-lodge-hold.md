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
allocation. In `getBedAllocationDashboard` (`src/lib/admin-bed-allocation.ts`)
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

- **Accepted consequence of the short-circuit (#2285 follow-up, 2026-07-29):
  a held booking's nights are NOT modelled as occupied for OTHER bookings'
  planning.** This ADR says a held group implicitly occupies every bed, but that
  occupancy is expressed only through the capacity rule (which blocks new
  admissions) — never as `BedAllocation` rows, and neither planner synthesises
  it as blocking occupancy. Before #2285 the rows the lifecycle wrongly created
  for held bookings gave the planners an accidental, undocumented occupancy
  signal; removing them removed that signal too. Two effects follow and are
  accepted: an overlapping booking admitted by an officer (decision 1 never
  refuses, so overlaps exist by design) can be auto-placed onto beds the held
  group is physically using, and the cross-booking age-mix invariant (#1768,
  "Bed Allocation Lifecycle" in `docs/STATE_MACHINES.md`) cannot see the held
  group's minors, so it cannot protect against mixing them with another
  booking's adults. Both remain **officer-resolved**, consistent with decisions
  1 and the conflict-surfacing work in #119/#177: the officer is shown every
  overlapping booking when the hold is set and resolves it manually. Modelling
  held nights as blocking occupancy in both planners is tracked as the separate
  `needs-decision` follow-up #2317 rather than assumed here.

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
