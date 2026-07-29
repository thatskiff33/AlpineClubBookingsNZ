# Lodge Capacity Model

How a lodge's bookable capacity is decided, in every configuration. The single
source of truth is `getLodgeCapacityStatus` in `src/lib/lodge-capacity.ts`;
`getLodgeCapacity` returns just the number and every booking, availability,
finance, cron, and content-token path reads through it, so the rules below apply
uniformly.

## Two distinct quantities

- **Physical bed inventory** — `LodgeBed` rows in the lodge's `LodgeRoom`s,
  counted when the **Bed Allocation** module is on (`activeBedCount`). This is
  the set of beds guests are *placed into* by bed allocation.
- **Maximum sleeping capacity** — the per-lodge `LodgeSettings.capacity` value
  (editable on the lodge admin page). This is the *ceiling* on how many guests
  the lodge may sleep, independent of how many beds are installed.

A lodge can legitimately have more beds than it may sleep — e.g. extra beds
crammed into a room, but a lower whole-lodge cap for fire / consent / licence
reasons (#1653). Booking availability must respect the **ceiling**, while
bed allocation still places people across the **larger** physical bed set.

Double-bed shared occupancy (#1701) does **not** change the base figure. A
shared `DOUBLE` counts as **one** bed of `activeBedCount`, and availability
(`checkCapacityForGuestRanges`) counts guests against `getLodgeCapacity`,
never `BedAllocation` rows. What a shareable double adds is **partner-shared
headroom** on top of that base figure — see the dedicated section below
(#1745): extra admissions only the admin-initiated partner flow can use, so a
second occupant still cannot inflate what ordinary bookings see.

## Partner-shared double-bed headroom (#1745)

A shareable `DOUBLE` can sleep a second occupant (the primary's CONFIRMED
partner, #1742/#1744), so each active DOUBLE contributes one **partner-shared
slot** above the base capacity — **reserved and bounded**, not a blanket
ceiling bump:

- **Reserved:** only the admin-initiated partner-shared admission
  (`checkCapacityForPartnerSharedAdmission`, `src/lib/capacity.ts`) can use
  the slots; every public/member/system path keeps reading the unchanged
  base `getLodgeCapacity`. An ordinary guest can never be admitted into
  partner headroom. Initiation is admin-only (#1746): the admin edit-booking
  panel offers the confirmed partners of the booking's member guests as
  "partner (shares a double bed)" quick-adds (server-computed,
  `listBookingPartnerSharingCandidates` in `double-bed-sharing.ts`), and the
  modify/modify-quote routes accept the matching `partnerSharedGuests` flags
  from admins only — gated at route AND service, so the reserved slots are
  unreachable from member self-service. A rejected flag surfaces the check's
  reason verbatim and never falls back into the #1668 overbook confirm.
- **Bounded:** at most `activeDoubleBedCount` shared admissions per night.
  Each admitted sharer must hold a CONFIRMED partner link with a member
  staying every requested night (`mayShareDoubleBed` stays the single source
  of truth for the pair rule), and the partner must hold an ordinary,
  base-backed place: a sharer can never anchor another sharer, coverage from
  the same proposal must come from a non-sharing guest row carrying the
  partner's memberId, and otherwise coverage is read from the partner's
  capacity-holding bookings. Under those guards every shared admission maps
  to a distinct double, so a feasible placement always exists — though
  producing it stays the allocation board's job and may mean moving unlocked
  allocations. Known residual: a partner admitted above base via the #1668
  over-capacity override can anchor a sharer; combining the two admin
  overrides can exceed pairing feasibility (both are explicit admin acts,
  and forced overage otherwise only *shrinks* headroom — it counts as
  consumed shared slots).
- **Ceiling interplay (#1653):** an explicit `LodgeSettings.capacity` is a
  maximum *sleeping* capacity (fire/consent/licence) and binds people, not
  beds. Headroom is therefore
  `max(0, min(activeDoubleBedCount, capacity − activeBedCount))` when a
  capacity is set: a `capped_beds` lodge gets **no** partner headroom, and a
  capacity between `beds` and `beds + doubles` allows only the gap. With no
  explicit capacity, headroom = `activeDoubleBedCount`.
- **Resolution:** `getLodgePartnerSharedCapacityStatus`
  (`src/lib/lodge-capacity.ts`) returns the base status plus
  `activeDoubleBedCount` and `partnerSharedHeadroom`. It is a separate
  resolver so ordinary availability checks pay no extra query.

Per-night admission rule (owner decision, #1745): admit if a base slot is
free, OR the guest is an eligible partner-sharer **and**
`sharedSlotsUsed < partnerSharedHeadroom` for that night. Occupancy already
above the base ceiling counts as used shared slots.

**Stale-pair sweep interplay (#1756):** when a pair breaks (partner link
dissolved, member deactivated, ADULT→minor tier correction),
`sweepFuturePartnerSharedAllocations` removes the pair's future
`isSecondOccupant` *placements* — deliberately NOT the second occupant's
`BookingGuest` row, which stays on its booking in the awaiting-allocation
queue for an admin to resolve. Shared-slot accounting is occupancy-derived
(guest-nights above base), never `BedAllocation`-derived, so the sweep cannot
corrupt it: the swept guest keeps conservatively consuming their shared slot
(the same treatment as #1668 forced overage) until the admin removes them
from the booking or re-admits them. The reserved slot is therefore never
silently double-granted — a new couple's admission is refused while the
stale guest still occupies the headroom, and frees the moment the guest
leaves the booking — and `getLodgePartnerSharedCapacityStatus` (bed
inventory + ceiling) is untouched by the sweep by construction.

Two conservative implementation choices sit on top of that decided rule
(ratified via the #1745 PR review rather than the issue text): the ceiling
interplay above (an explicit capacity always wins, so a capped lodge gets no
headroom), and fail-loud sharers — a proposed sharer whose pair is not
CONFIRMED-linked, or whose partner misses any requested night, rejects the
whole proposal outright instead of silently falling back to an ordinary
slot the admin did not intend.

| Active beds | of which DOUBLE | Capacity set | Base figure | Partner headroom |
|---|---|---|---|---|
| 10 | 1 | unset | 10 (`configured_beds`) | 1 |
| 10 | 2 | 11 | 10 (`configured_beds`) | 1 |
| 10 | 2 | 10 | 10 (`configured_beds`) | 0 |
| 10 | 2 | 8 | 8 (`capped_beds`) | 0 |
| 0 (module off) | — | 30 | 30 (`capacity_override`) | 0 |

The admin lodge **Capacity** card shows the figure broken out — e.g.
"10 beds + up to 1 partner spot" — never a single combined number, so an
admin can see the extra is partner-only.

## Which bookings consume capacity (the holding population)

Orthogonal to *how much* capacity a lodge has is *which bookings consume it*.
The single source of truth is `capacityHoldingBookingFilter()` (per-row form:
`bookingHoldsCapacity()`) in `src/lib/booking-status.ts`; every availability,
occupancy, waitlist, bed-allocation, and stats query reads through it. A
booking holds capacity when:

1. Its status is naturally capacity-holding: `PAID`, `COMPLETED`, `CONFIRMED`,
   or `AWAITING_REVIEW`.
2. It is `PENDING` **and** is the converted booking of a `BookingRequest`
   (accepted-but-unpaid quote / directly-approved request, #1254 refining
   #737). Generic `PENDING` stays non-holding and bumpable.
3. It is `PAYMENT_PENDING` **and** carries an **admin capacity hold**
   (#1764): `Booking.adminCapacityHoldAt` is set. A Full Admin / Booking
   Officer reserved the beds while the member arranges payment, without
   faking a payment or changing the booking's real status.

The admin hold (clause 3) is deliberately **status-scoped**: a cancelled or
expired booking with a stale hold flag can never hold beds, and when the
booking pays (moving into clause 1) it is counted exactly once — the clauses
are OR'd, never summed. Placing a hold runs under the per-lodge advisory
capacity lock with a capacity re-check (the #1366 pattern); an over-capacity
hold requires the explicit overbook confirm, mirroring force-confirm. The
hold is released by Admin Unhold (only until the booking holds naturally),
and every cancel path — member/admin cancel, group-child cancel, settlement
reaper, Internet Banking hold expiry, capacity-failed settlement — clears the
hold fields via the shared `RELEASE_ADMIN_CAPACITY_HOLD_UPDATE` fragment, so
no orphaned hold records survive a cancellation. Both hold and unhold write
audit rows (`booking.admin_capacity_hold.*`).

## Resolution

Effective capacity is decided in this order:

1. **Bed Allocation on, ≥1 active bed** → the beds are the inventory and the
   capacity value is a ceiling. Effective capacity = **`min(activeBedCount,
   capacity)`**:
   - capacity unset, or ≥ bed count → `activeBedCount` (source
     `configured_beds`).
   - capacity set below bed count → `capacity` (source `capped_beds`); the
     surplus beds stay available for allocation but cannot be booked into.
2. **Bed Allocation off, or on with no active beds** → the per-lodge
   `LodgeSettings.capacity` (source `capacity_override`).
3. **Neither** → **0** (source `unconfigured_lodge`), for **every** lodge
   including the default. A freshly created (or un-backfilled) lodge is
   unbookable rather than overbookable until configured.

**DB-only capacity (#1982).** The DB is the *sole* runtime source of a lodge's
booking capacity — `club.json` is no longer read at runtime. The default lodge
carries an **explicit** `LodgeSettings.capacity`, backfilled from the current
`club.json` bed total by the boot-time config self-heal
(`src/lib/config-self-heal.ts`, epic #1943 C2 mechanism), so it normally
resolves via step 2. `club.json beds[]` survives only as a **seed template**
(the "import rooms & beds from config" affordance and the admin lodge-settings
"config suggests N beds" hint). A default lodge that still resolves to 0 at
step 3 is genuinely unconfigured (its boot self-heal was skipped — e.g. a
non-primary `club.json`); the setup-readiness **Club Config** check flags it
loudly (a warning) rather than handing it phantom capacity that could silently
overbook.

The self-heal backfill is **gated**: it fills the default lodge's null capacity
only when the lodge would *otherwise resolve to 0* (Bed Allocation off, or on
with zero active beds). When Bed Allocation is **on with active beds**, a null
capacity is the deliberate "no ceiling — use the bed count" intent (step 1), so
the heal leaves it null rather than writing the config bed total as a **capping
override** that would silently reduce the lodge to `min(beds, total)`. The
backfilled row is also linked to the default lodge, so its capacity never leaks
to an additional lodge that lacks its own row. `prisma/seed.ts` seeds the same
default-lodge capacity (create-only, null-scoped fill) so a freshly seeded DB is
immediately bookable, matching a booted DB.

Known residual (deliberate trade-off): a transient module-flags read error at
boot resolves as "Bed Allocation off", so a module-ON lodge with a deliberate
null capacity could be healed with a capping override on that one boot. The
failure direction only ever *reduces* capacity (never overbooks) and an admin
can clear it by setting the capacity explicitly; degrading read errors to
"skip healing" instead would reopen the cold-boot capacity-0 outage this
mechanism exists to prevent.

Only an **explicit** per-lodge capacity acts as a ceiling. The unconfigured
fallback (0) is never a ceiling, so enabling Bed Allocation on a lodge keeps
using the bed count unless a capacity is set.

## Scenario table

| Bed Allocation | Active beds | Capacity set | Effective capacity | `source` |
|---|---|---|---|---|
| Off | — | 30 (default lodge, self-healed or admin-set) | 30 | `capacity_override` |
| Off | — | unset (any lodge, un-backfilled) | 0 | `unconfigured_lodge` |
| On | 0 | 30 | 30 | `capacity_override` |
| On | 0 | unset (any lodge) | 0 | `unconfigured_lodge` |
| On | 40 | unset | 40 | `configured_beds` |
| On | 40 | 40 | 40 | `configured_beds` |
| On | 40 | 50 (≥ beds) | 40 | `configured_beds` |
| On | 40 | 30 (< beds) | **30** | `capped_beds` |

## Admin surface

On the lodge admin page (`/admin/lodges/[id]`) the **Capacity** card shows the
resolved figure and its `source` — with any partner-shared headroom broken
out (`"10 beds + up to 1 partner spot"`, plus a short partner-only
explainer; #1745) — and the capacity field warns live when the value entered
is below the active bed count (it will cap the lodge). The allocation board
still shows all physical beds; a capped lodge simply leaves some beds
unbooked.

## Exceeding the ceiling (admin overbook overrides)

The resolved figure is a hard block for members: no member-facing path can
create or grow a booking past it. Admins can exceed it only through an
explicit, audited confirmation, via two distinct contracts:

The **warn-and-confirm contract** (`OverCapacityConfirmationRequiredError` →
409 `OVER_CAPACITY_CONFIRM_REQUIRED` → resubmit with
`confirmOverCapacity: true`, `capacityOverridden` audited):

- **admin date-edit override** (#1668) — `booking-modify-plan` /
  date-modification service under `adminOverride`;
- **admin on-behalf create** — retroactive (#1695) and forward-dated
  (#1767) creates on `/admin/book`, with one carve-out: a create that
  opted into the waitlist fallback keeps the capacity-exceeded outcome and
  waitlists instead. (The former v1 carve-out that hard-blocked a non-member
  hold-eligible (PENDING) party was retired by #1771 — the persisted override
  is now honoured by the hold cron, so that overbook is admitted and marked.)

The **explicit-overbook-flag contract** (409 `CAPACITY_EXCEEDED` +
`overbookDates`, resubmit with the overbook flag; separate audit actions):

- **confirm-pending-guests** on the booking detail page (#1366, flag under
  the advisory-locked re-check);
- **waitlist force-confirm** — "Confirm Anyway (Overbook)" on
  `/admin/waitlist` (`allowOverbook`, audited as
  `waitlist.force_confirmed_overbook`);
- **admin capacity-hold** — placing a hold over the ceiling (#1764,
  `allowOverbook`, audited as `booking.admin_capacity_hold.placed_overbook`).

Partner-shared admissions (#1745/#1746) are *not* overrides — they consume
reserved headroom and reject rather than falling back into a confirm.

### Exclusive whole-lodge hold — a non-bypassable block (ADR-001, #118)

A capacity-holding booking with `Booking.wholeLodgeHold = true` reserves the
whole lodge for the nights it spans (`[checkIn, checkOut)` — the checkout day is
excluded, so back-to-back handovers stay correct). This is the capacity engine's
first non-arithmetic rule and it sits *above* both override contracts:

- **Member parity (ADR-001 decision 6):** a held night is reported exactly like
  a genuinely full lodge. `checkCapacity` / `checkCapacityForGuestRanges` flag
  the night `wholeLodgeHeld` and pin its `availableBeds` to **0** (never
  negative), and force the result's `available` to `false`. Members and the
  public never see an exclusive-specific message — same no-space / waitlist path
  as a full lodge.
- **Not override-bypassable (ADR-001 decision 5):** because held nights are
  pinned to 0 they never enter `overCapacityNights()`, so the warn-and-confirm
  override cannot list them as confirmable. An admin who *does* confirm the
  over-capacity override onto a held night is refused with the non-confirmable
  `WholeLodgeHoldBlockedError` (409 `WHOLE_LODGE_HOLD_BLOCKED`, carrying the
  blocked nights). To add anyone, the admin must first remove or adjust the hold.
  The same block applies to the partner-shared admission path.

Enforcement lives in `capacity.ts` (the `wholeLodgeHeld` flag) and
`over-capacity-confirmation.ts` (`wholeLodgeBlockedNights`,
`WholeLodgeHoldBlockedError`). It covers **every NEW-admission path**:

- **Member create / self-serve** — refused via `available === false` (the held
  night presents as full: booking-create's member branch, the modify services'
  non-override branch, waitlist offer + accept, booking-request /
  school-booking-request accept).
- **Admin over-capacity confirm** — `booking-create` (both branches), the date
  modification service (date-change + shift), and `booking-modify-plan` (batch +
  modify) throw `WholeLodgeHoldBlockedError` on a confirmed override.
- **Admin `allowOverbook` routes** — `force-confirm`,
  `confirm-pending-guests` (both the $0 and charge branches), and `capacity-hold`
  return a 409 `WHOLE_LODGE_HOLD_BLOCKED` (with `blockedNights`) **regardless of
  `allowOverbook`**, before any status advance or charge.
- **Partner-shared admission** (`checkCapacityForPartnerSharedAdmission`) rejects
  held nights.
- **Availability calendars** — `checkCapacityForGuestRanges` (day view) and
  `getMonthAvailability` (month calendar, `/api/availability`) both report a held
  night as full, so a held-but-not-full night is indistinguishable from a
  genuinely full lodge on public surfaces (decision 6).

**Pre-existing overridden settlements are NOT refused.** A booking deliberately
admitted above the ceiling (`bookingHasCapacityOverride`) may later have a hold
placed over its nights; its settlement paths (payment-reconciliation,
cron-confirm-pending, switch-to-internet-banking, charge-saved-method,
payment-link, xero-inbound invoice-paid-effects, group-settlement) still settle
it. Per ADR-001 decision 1 (conflicts allowed, surfaced, manually resolved — no
auto-displacement) an already-admitted booking is not a new admission, so the
hold does not retroactively block it; the booking officer resolves the conflict.

Setting a hold (#121) has no empty-lodge precondition — conflicts are allowed,
surfaced, and resolved manually (ADR-001 decision 1).

**Conflict surfacing (#119, admin-only).** Because conflicts are resolved by
hand, they must be obvious to the officer — in both directions, and never to
members/public (decision 6):

- `findOverlappingCapacityHoldingBookings(db, { lodgeId, checkIn, checkOut,
  excludeBookingId })` (`capacity.ts`) reuses the overlap window +
  `capacityHoldingBookingFilter` to list the existing capacity-holding bookings
  overlapping a hold. The admin exclusive-hold route and the school approval
  return these `conflicts` (and audit the count/ids); the booking detail page's
  Admin-tools control lists them. Setting/approving still succeeds.
- The admin bookings list and the bed-allocation board badge any ordinary
  booking that overlaps a hold (`overlapsExclusiveHold`), via the pure
  `bookingsOverlap` / `sameLodgeNullTolerant` helpers.
- `getLodgeHeldNights(lodgeId, checkIn, checkOut)` (`capacity.ts`) is the admin
  companion to `getLodgeCapacityStatus` (which takes no date range) for
  reporting which nights in a range are whole-lodge-held.

**Bed-allocation short-circuit (#120, admin-only).** A held booking implicitly
occupies the whole lodge, so it needs no per-bed allocation. The bed-allocation
dashboard excludes a held booking's guest-nights from the awaiting-allocation
set and from the planner (so a hold never reads as an allocation gap / stuck
state), and surfaces it via the `exclusiveHolds` payload as a distinct board
banner instead. The admin bookings list reports a held booking's bed-state as
`complete`. No `BedAllocation` rows are generated or demanded for a held
booking.

The lifecycle auto-allocator enforces the same rule (#2285): keyed on
`wholeLodgeHold` (not status), `reconcileBedAllocationsForBooking` prunes ALL
of a held booking's allocation rows (whole-booking sweep — legacy rows an
older lifecycle created self-heal on any reconcile, no data migration) and
never feeds a held booking to the planner. The admin exclusive-hold toggle
reconciles on both directions inside its transaction: setting the hold prunes
the booking's rows; releasing it re-plans the guests like any ordinary
lifecycle change. A school approval that grants exclusivity runs the same
prune after stamping the hold on the converted booking. The board/lifecycle
agreement is tested in
`src/lib/__tests__/held-booking-allocation-agreement.test.ts`.

Accepted consequence (ADR-001 amendment, #2285): because a held booking owns no
rows and neither planner synthesises its nights as blocking occupancy, a held
group's beds are **not** modelled as occupied when other bookings are planned —
an overlapping booking the officer chose to keep (decision 1 never refuses one)
can be auto-placed onto beds the held group is physically using. Overlaps stay
officer-resolved, surfaced when the hold is set (#119/#177); whether to model
held nights as blocking occupancy instead is the open decision #2317.

Setting a hold also drops the booking out of the requested-room lock (#776):
that lock is "this booking has at least one APPROVED `BedAllocation` row", and
the prune removes the approved rows along with the rest, so a member's requested
room becomes editable again. That is the intended state — with no allocated beds
there is nothing for the lock to protect — and it persists after the hold is
cleared until an admin approves the re-planned beds. The removed rows (including
which were approved) are listed in the hold's audit entry so the placement can be
rebuilt by hand.

### Persisted capacity override (#1771)

Every over-capacity admission above **persists** the decision on the booking:
`Booking.capacityOverriddenAt` (when) and `capacityOverriddenByMemberId` (the
acting admin). The marker records "this booking is a deliberate overbook on its
**current** nights", so it is set when the override fires and **reconciled**
wherever a booking's capacity is re-evaluated against a new footprint. The
predicate `bookingHasCapacityOverride(booking)` reads it.

**Set-sites** (stamp on the over-capacity path only): `booking-create`
(#1668/#1695/#1767 pre-create + $0/credit-covered branches), waitlist
force-confirm (#1668/waitlist), confirm-pending-guests ($0 and priced gates,
#1366), and admin capacity-hold (#1764). These are **one-shot admissions** — the
booking's nights are fixed at the moment they run, so the stamp is set once and
never needs clearing. The date and batch modification services (#1668) instead
**reconcile** the marker: they re-run the capacity check against the new range,
so they re-stamp when the new nights are still an admin-confirmed overbook and
**clear** any prior stamp when the modification moved the booking back within
capacity. Without that clear, a booking overbooked on its old nights and then
modified to an in-capacity range would keep a stale flag that wrongly suppressed
a legitimate cancel once the new nights filled. The marker is **not** cleared on
cancel — a cancelled booking never re-enters a re-check, so the audit fact is
preserved. For a **mixed-party split** create whose member guests alone overflow,
the provisional non-member child booking (#738) inherits the same override as
its member parent — otherwise the parent would survive payment while the
hold cron silently bumped the unstamped child, a partial-drop against an
explicit admin overbook.

**Read-sites** (honour it → settle/proceed instead of cancel/refund/409/bump):
`markBookingPaymentSucceeded` (settlement), `createPaymentIntentForPaymentLink`,
the non-member-hold cron (`cron-confirm-pending`), `charge-saved-method`,
`switch-to-internet-banking`, the Internet Banking invoice-paid reconcile
(`xero-inbound/invoice-paid-effects`), and group settlement (defensive). Each
falls through to the booking's correct terminal state (PAID / CONFIRMED /
payment proceeds) and logs the skip.

**DRAFT-scoped exemptions** (documented, no code): the capacity re-checks in
`create-payment-intent` and `confirm-draft` run only while the booking is DRAFT,
and #1767 blocks saving a DRAFT over capacity, so a DRAFT can never carry an
override — honouring it there would be dead code.

This fixes the former limitation where a *priced* overridden booking
self-destructed (cancel + refund / 409 / bump) when payment landed while the
lodge was still over capacity on its nights. ($0 and credit-covered overridden
creates always settled at create time and were never affected.)

## Behaviour change (introduced with #1653)

Previously, when Bed Allocation was on with beds configured, an
`LodgeSettings.capacity` value was **ignored** — the bed count always won. It is
now honoured as a ceiling. A lodge that had both beds configured **and** a
capacity set *below* its bed count will see its bookable capacity drop to that
value. See `docs/UPGRADING.md` for the operator check.

To find affected lodges before upgrading (read-only):

```sql
SELECT r."lodgeId",
       COUNT(b.*) FILTER (WHERE b.active) AS active_beds,
       s.capacity
FROM "LodgeRoom" r
JOIN "LodgeBed" b ON b."roomId" = r.id
LEFT JOIN "LodgeSettings" s
  ON s.id = r."lodgeId" OR (s.id = 'default' AND (s."lodgeId" IS NULL OR s."lodgeId" = r."lodgeId"))
GROUP BY r."lodgeId", s.capacity
HAVING s.capacity IS NOT NULL
   AND s.capacity < COUNT(b.*) FILTER (WHERE b.active);
```

Any row returned is a lodge whose capacity will now be capped below its bed
count. Confirm that is intended (it usually is — that is the point of #1653).
