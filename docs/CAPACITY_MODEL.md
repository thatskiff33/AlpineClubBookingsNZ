# Lodge Capacity Model

How a lodge's bookable capacity is decided, in every configuration. The single
source of truth is `getLodgeCapacityStatus` in `src/lib/lodge-capacity.ts`;
`getLodgeCapacity` returns just the number and every booking, availability,
finance, cron, and content-token path reads through it, so the rules below apply
uniformly.

Every "night" in this document is an NZ lodge night as defined by the
normative stay-boundary invariant in
[`docs/invariants/booking-dates-and-capacity.md`](invariants/booking-dates-and-capacity.md#the-stay-boundary-midday-nz-to-midday-nz-normative);
the consequence used throughout this document is that a departure date is
never an occupied night on any capacity or availability surface (day view,
month calendar, holds, or allocation).

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
the lock-held partner-share sweep removes the pair's future
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

## How occupancy is counted: one calculation, four terms (#2681)

*Which* bookings consume capacity (above) is one question. *How many beds are
occupied at this lodge on this night* is the other, and it has exactly one
implementation: **`computeNightOccupancy()` in `src/lib/capacity.ts`**.

Until #2681 it had five, and they had drifted. Four near-identical copies lived
in `capacity.ts` itself and a fifth in the capacity-warnings cron, which was
missing three of the four terms; a sixth copy in the custodian write path was
missing one. Every term below is now summed in one place, and
`src/lib/__tests__/night-occupancy-census.test.ts` fails the build if a term is
dropped from it or if a seventh copy appears.

### The terms

| # | Term | Added by | What it counts |
|---|---|---|---|
| 1 | Booked guest nights | #713 / #1254 | The capacity-holding bookings overlapping the night at this lodge, counted through each guest's **explicit night set** so a sparse, non-contiguous stay is not counted on its gap nights. The query must load `guests: { include: { nights: true } }`; with plain `guests: true` the guest falls back to the `stayStart`/`stayEnd` envelope and the gap nights are counted. |
| 2 | Custodian bed holds | #2286 | A bed held for a season by a hut-leader assignment. No booking, no guest row, so it is invisible to term 1. |
| 3 | Policy-exception reservations | #2525 | Beds a **HELD** booking-policy exception request has provisionally reserved. Read under the same per-lodge capacity lock the claim is written under. |
| 4 | Whole-lodge holds | ADR-001 / #118 | A capacity-holding booking that holds the lodge exclusively. Returned as a per-night **flag**, not folded into the number, because what a held night should *look like* is the one thing the callers genuinely differ on. |

### Who counts what

Every surface that goes through `computeNightOccupancy()` takes terms 1-3
together — none of them takes some and not others. What varies among those
surfaces is only what each does with term 4. (The admin utilisation report is
the one occupancy-shaped surface that does *not* go through the calculation; it
is listed last for exactly that reason.)

| Surface | Terms 1-3 | Whole-lodge hold (term 4) | Why |
|---|---|---|---|
| `checkCapacity` | **Yes** | `occupiedBeds` pinned to `lodgeCapacity`, `availableBeds` pinned to 0 | A member reading this payload (#155) must not be able to tell a held night from a genuinely full one (decision 6) |
| `checkCapacityForGuestRanges` | **Yes** | `availableBeds` pinned to 0; `occupiedBeds` **not** pinned | Its `occupiedBeds` is existing occupancy *plus the proposal being tested*; pinning would discard the proposal. Every consumer reads `availableBeds` / `wholeLodgeHeld` |
| `checkCapacityForPartnerSharedAdmission` | **Yes** | `availableBeds` pinned to 0 and surfaced as a refusal `reason` | A hold is not bypassable by any admin override (decision 5) |
| `getMonthAvailability` | **Yes** | Reported as a full lodge | A held-but-not-full night on the public calendar would otherwise leak the hold |
| Capacity-warnings cron | **Yes** | Reported as a full lodge, so the warning fires | An exclusive hold leaves no bookable bed, however small the holding group is |
| Custodian bed-hold write path (`validateCustodianBedHold`) | **Yes** | **Deliberately not pinned** | Policy, not arithmetic: a hold and a custodian bed do not block each other in either direction (see "Whole-lodge holds and custodian beds do not block each other" below). Pinning would refuse a hut leader a bed the club intends them to occupy |
| Admin reports `occupancyByDate` | **Term 1 only** | Not counted | Utilisation measures how much the lodge was *booked*; see the custodian table below |

The nightly capacity-warnings cron is the surface this inventory exists for. It
was the one that fell behind, and the reason it fell behind is that only the
custodian term (#2286) had a "who counts what" table naming it. #2525 had none,
and #2525 is the term that was missed.

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
(`src/lib/config-self-heal-steps.ts`, epic #1943 C2 mechanism; the runner
stayed in `config-self-heal.ts` when #2989 split the step definitions out), so it normally
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

The custodian never changes this table: a bed held for a custodian stays an
active bed and stays in the ceiling. It is subtracted per night on the
occupancy side instead — see the section below.

## Custodian bed holds — a dated occupancy, not a smaller lodge (#2286)

A `HutLeaderAssignment` may carry an optional `bedId`. With one, the assignment
is a **custodian bed hold**: for the night of every covered date that bed is out
of the bookable pool and out of the allocatable pool, with **no `Booking` and no
`BedAllocation` row anywhere**. Without one — including every row the
`hut-leader-auto-assign` cron creates — the assignment is a role only and has
**zero** capacity effect.

**Night semantics.** The hold covers `startDate <= night <= endDate`,
**inclusive** — matching the existing hut-leader coverage semantics. This is
deliberately not the half-open `[checkIn, checkOut)` booking envelope: a
booking's `checkOut` is a departure morning, an assignment's `endDate` is a
covered day. (The
[stay-boundary invariant](invariants/booking-dates-and-capacity.md#the-stay-boundary-midday-nz-to-midday-nz-normative)
names this as its deliberate custodian exception.)

**Counted as an occupant, not as a smaller ceiling.** The engines do
`occupiedBeds += custodianCount(night)` rather than reducing `lodgeCapacity`.
The arithmetic for `availableBeds` is identical, but this keeps
`occupiedBeds + availableBeds === lodgeCapacity` true on every night (the #155
payload contract) and makes every `capacity - occupied` consumer correct with no
consumer change. It is also the right reading under a capped capacity
(`capped_beds` below): a licence cap is a sleeping cap, and the custodian
sleeps in the lodge. The arithmetic is a per-night **count**, never a boolean —
two custodians handing over on the same night, on different beds, subtract two.

**Who counts it, and who deliberately does not:**

| Surface | Custodian counted? | Why |
|---|---|---|
| `checkCapacity`, `checkCapacityForGuestRanges`, `checkCapacityForPartnerSharedAdmission`, `getMonthAvailability` | **Yes** | Every admission path and both calendars must see the bed as taken |
| Capacity-warnings cron | **Yes** | Its whole job is fullness; excluding the hold would under-fire the warning all season |
| Custodian bed-hold write path (`validateCustodianBedHold`) | **Yes**, other custodians only | The hold being created or edited is excluded and added once as `+ 1`, so a handover never double-counts one bed |
| Admin reports `occupancyByDate` | **No** | Utilisation measures *booked* usage, so the report reads slightly low during custodian season. Stated here so the gap is a decision, not a bug |

Since #2681 the first three rows — six surfaces in all, since the first row
lists four — get the term from the one `computeNightOccupancy()` calculation
rather than each building the counter themselves, so "who counts the custodian"
is a property of that function plus this table, not of six separate copies. Only
the last row, the admin utilisation report, still reads the population directly.

**Two accepted, deliberate imprecisions:**

1. *Partner-shared headroom overshoot.* `getLodgePartnerSharedCapacityStatus` is
   undated, so a custodian-held DOUBLE still counts toward
   `partnerSharedHeadroom`. An admin can therefore be admitted a sharer when
   zero physically shareable doubles remain. At **placement** level nothing can
   go wrong (a custodian bed has no primary allocation row to share, and the
   allocation guard sits in front); the overshoot is admin-only and analogous to
   the accepted #1668 over-capacity override.
2. *Room-mix side effect.* The custodian is fed to the bed planner as a #1768
   "unknown occupant" row, so their room reads as containing an out-of-booking
   adult. Auto-placement therefore keeps other bookings' unaccompanied minors
   out of that room for the whole season. This is conservative and correct — an
   unrelated adult really does sleep there.

**Whole-lodge holds and custodian beds do not block each other.** This is a
deliberate policy, and it is worth being exact about *why*, because the obvious
explanation is wrong.

The custodian's bed is **not** outside the held pool. `getLodgeCapacityStatus`
resolves capacity from every active bed, the custodian's included — the whole
#2286 design counts the custodian as an occupant of a capacity bed rather than
as a smaller ceiling — and `wholeLodgeHoldOccupiedBedNightsForPlanner` (#2317)
expands a hold across every active bed too, so on the planner the same bed-night
carries both.

What is true is that neither refuses the other. Setting a hold never lists a
custodian as a conflict, and a custodian hold can be created over held nights
and vice versa. On a held night the ADR-001 pin still presents a full lodge to
every member-facing surface; on the hold's own admission path the group's
headcount is checked *with* the custodian counted, so an over-size group
surfaces as over-capacity for explicit admin confirmation instead of silently
displacing them.

**The gap that leaves, stated rather than implied:** creating a custodian bed
hold over a night that is already exclusively held raises **no** warning, because
`validateCustodianBedHold` compares `occupancy + 1` against capacity and the
holding group's own headcount may be small. The officer is not told the lodge is
exclusively held for those nights. #2681 did not introduce this and did not
change it; whether that confirmation should mention held nights is an owner
decision.

### With the bed-allocation module OFF (#2286 review M11)

A hold created while `bedAllocation` was on **keeps counting** after the module
is turned off. That is deliberate, not an oversight: the module flag governs
which admin surfaces exist, not whether a person is asleep in a bed. Capacity
that silently un-reduced itself when a flag flipped would over-admit a lodge
whose custodian is still living in it.

So the off state is **recoverable rather than frozen**:

- the module gate on the hut-leaders write routes guards only the **set**
  direction — a new bed cannot be held while the module is off;
- the **clear** direction is deliberately module-check-free, and the
  *Release bed* control on the Hut Leaders page is rendered regardless, so a hold
  can always be undone (`custodian-hut-leaders-route.test.ts` pins both
  directions);
- the module-settings copy for `bedAllocation` states this, so an admin turning
  it off is told capacity stays reduced and where the way back is.

**Enforcement is application code, not a constraint.** Owner decision, 28 Jul
2026: every allocation chokepoint re-reads the live holds on the client that is
about to write, immediately before writing (`src/lib/custodian-occupancy.ts`),
and every placement transaction the app opens itself takes the per-lodge
advisory lock first so that read and the write serialise against the hold
writer. A chokepoint running inside a caller's transaction inherits that
caller's lock discipline and still re-filters at write time. A board warning
(`CUSTODIAN_BED_CONFLICT`) is the net and a write-path contract test is the
alarm. Representing the hold as nullable-FK `BedAllocation` rows was weighed and
rejected: it breaks the old colour on a runtime-hot table during a deploy drain,
needs a null-tolerance audit of ~30 read sites, and the lifecycle prune would
read custodian rows as orphans and silently delete them.

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
whole lodge for the nights it spans (`[checkIn, checkOut)` — the checkout day
is excluded, so back-to-back handovers stay correct per the
[stay-boundary invariant](invariants/booking-dates-and-capacity.md#the-stay-boundary-midday-nz-to-midday-nz-normative)).
This is the capacity engine's
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
- **The capacity-warnings cron** — reports a held night as a full lodge, so the
  nightly fullness alert fires (#2681). Before that it had no hold handling at
  all, and a lodge under an exclusive whole-lodge hold never triggered a warning.

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

**Held nights are blocking occupancy in both planners (#2317).** A held booking
owns no `BedAllocation` rows, so until #2317 a held lodge looked to the planners
like a lodge full of free beds and an officer-kept overlapping booking could be
auto-placed onto beds the held group was physically using. Owner decision, 1 Aug
2026 (option (a)): both planners now synthesise the hold as **unattributed,
non-displaceable** occupancy — every active bed of that lodge, every held night —
still without creating a single row.

- **Unattributed and non-displaceable by construction.** The synthesised rows
  are #1768 "unknown occupant" rows (null booking, null guest), exactly like a
  custodian bed hold. No name, no booking id and no age tier reaches the planner
  — a hold can start life as a public school request — and there is no row for a
  `MOVE`/`UNALLOCATE` to target, so no planner action can shift a hold. A
  tierless unknown occupant counts as an adult, so the #1768 room-mix guard
  treats a held lodge conservatively: another booking's unaccompanied minors are
  kept out of rooms an unrelated group is sleeping in.
- **Non-displaceable is a property of the bed-NIGHT, not just of the row.** A
  real `BedAllocation` row can legitimately share a held bed-night — ADR-001
  decision 1 never refuses the overlapping booking, the hold prune sweeps only
  the held booking's own rows, and manual placement is deliberately open — and a
  hold owns no row for the planner to count, so nothing about the co-located
  booking's eviction tells the planner the bed is still taken. The planner
  therefore pins every null-booking bed-night as permanently occupied: evicting
  the co-located booking releases that booking's claim and never the hold's, and
  a room is never sized as feasible off rows whose eviction frees nothing. The
  same applies to custodian bed holds (#2286).
- **The same hazard exists between two REAL rows (#2656).** A shared DOUBLE
  (#1701) holds two occupant rows on one bed-night, and they may belong to two
  DIFFERENT bookings — that is the whole point of the partner-link rule. Until
  #2656 the planner's occupant view was keyed `bedId:stayDate` like its
  occupancy set, so the second row overwrote the first (one map entry, two
  database rows) and evicting either booking released the WHOLE bed-night while
  the other booking's row was untouched in the database. The planner then
  allocated a capacity-holding booking onto an occupied double: silently skipped
  at write time if the survivor was the primary (a booking displaced and audited
  for nothing, the guest-night neither placed nor reported), or written in
  beside the survivor if it was the second occupant — a stranger in a double
  with no `MemberPartnerLink`, exactly what `mayShareDoubleBed()` exists to
  prevent. Reachable only through `prioritizeCapacityHolding` (the lifecycle
  auto-allocation path), and non-deterministic, because the row order came from
  an unordered query.

  **The planner now keeps occupant IDENTITY and bed-night CAPACITY apart.**
  Capacity stays one entry per physical bed-night keyed `bedId:stayDate`, and it
  is released only when the LAST occupant of that bed-night leaves. Identity is
  keyed `bedId:stayDate:bookingGuestId` — one entry per occupant row, because
  `@@unique([bookingGuestId, stayDate])` makes a guest plus a night name exactly
  one slot — with a reverse index from bed-night to its slots so "is anyone
  still in this bed?" is answerable. Three rules follow, and they are the
  displacement contract for a shared double:
  1. Evicting one occupant of a two-occupant double frees **zero** physical
     beds while the other remains, and is credited **nothing** against a room's
     shortfall. Displacement counting is in physical bed-nights freed, never in
     rows or bookings displaced.
  2. The double counts as **one** freed bed once BOTH occupant slots are gone —
     one bed, not two, even when both occupants belong to the same booking.
  3. On the **single-bed claim path** — `tryDisplaceForHeldGuestNight`, which
     claims ONE bed-night by evicting exactly ONE booking — a bed-night whose
     occupants span more than one booking is never a displacement target at
     all. Only one of the two would go, so the bed would not actually be freed,
     and taking it anyway is how a stranger ends up written in beside someone
     else's second occupant.

     The **whole-stay room path** — `planEvictionsForRoom` — deliberately does
     the opposite, and rules 1 and 2 are what make that safe. It clears a whole
     room by evicting a SET of bookings, so it makes EVERY occupant of a
     candidate bed-night an eviction candidate, including both occupants of a
     shared double held by two different bookings. It never gains the bed
     until all of them are in the set, because credit is counted in beds freed
     (rule 1): either both bookings on that double are displaced together, or
     the room is never chosen. So a shared double CAN be vacated across two
     bookings — by the path that takes both — and can never be half-vacated by
     either path.

     Either way, an eviction that turns out to free nothing is dropped from the
     plan rather than displacing a booking for nothing.

  `permanentlyOccupied` is still needed for the hold case above: an occupancy
  with no row behind it cannot be represented as an occupant slot.
- **The blocking predicate is this engine's own**, never a parallel list:
  `wholeLodgeHold` AND `bookingHoldsCapacity()` / `capacityHoldingBookingFilter()`
  over the same lodge — `getLodgeHeldNights`'s population. So the planners
  can never report a night held that admission would let a booking into, and a
  stale `wholeLodgeHold = true` on a booking that stopped holding capacity blocks
  nothing in either place. It is deliberately NOT the #2285 short-circuit's
  predicate, which asks a different question ("may this booking own rows?") and
  is keyed on the raw flag. The one deliberate asymmetry is direction-safe:
  where the planner cannot resolve a lodge for a hold or a room it treats the
  night as held, refusing a bed the engine would have admitted rather than the
  reverse. `Booking.lodgeId` and `LodgeRoom.lodgeId` are both NOT NULL, so that
  branch is dead — kept conservative rather than removed.
- **The effect an officer sees** is that an overlapping booking's guest-nights
  on held nights are left in the awaiting-allocation list instead of being
  quietly placed. (`NO_BED_AVAILABLE` is the planner's internal reason code for
  this; it reaches the dashboard payload as `suggestedUnallocatedGuestNights`
  and is counted by the stuck-state dashboard, but no admin screen renders the
  reason itself.) What the officer actually reads on the board is the
  exclusive-hold banner plus the **Overlaps exclusive hold** chip on the
  clashing booking's card; the bed grid does not mark held cells, and the banner
  is built from the board's booking load — which requires a guest row
  overlapping the window — rather than from the deliberately-unfiltered blocking
  query, so a hold whose guests have not been entered yet blocks without
  appearing in it. That is more red on the board for a clash the
  officer has already been shown when the hold was set (#119/#177) — which is
  the point of the decision.
- **Manual placement is untouched.** ADR-001 decision 1 admits overlaps on
  purpose and hands them to the booking officer; a write-time refusal would take
  away the very resolution path the ADR requires. What #2317 adds is that the
  automatic paths stop making the decision for them.
- Both writers re-read the live holds on the client that is about to write
  (mirroring the custodian re-filter), so a hold committing between plan and
  write is not written over. Every placement transaction this code **opens
  itself** also takes the per-lodge advisory lock as its first statement; a
  reconcile running inside a CALLER's transaction, and the lifecycle's common
  no-displacement path (which opens no transaction of its own), rely on the
  re-read alone — the same posture as the custodian exclusion. Source:
  `src/lib/exclusive-hold-occupancy.ts`; guards:
  `src/lib/__tests__/exclusive-hold-planner-occupancy.test.ts` and the
  whole-lodge entries in
  `src/lib/__tests__/custodian-write-path-contract.test.ts`.

Setting a hold also drops the booking out of the requested-room lock (#776):
that lock is "this booking has at least one APPROVED `BedAllocation` row", and
the prune removes the approved rows along with the rest, so a member's requested
room becomes editable again. That is the intended state — with no allocated beds
there is nothing for the lock to protect — and it persists after the hold is
cleared until an admin approves the re-planned beds. The removed rows (including
which were approved) are listed in the hold's audit entry so the placement can be
rebuilt by hand.

The MANUAL write paths enforce it as well (#2251): single-night board placement,
the bulk multi-night drop and range assignment all pass through
`assertGuestAndBedForAllocation`, which refuses a whole-lodge-held booking rather
than accepting a row the next reconcile would sweep. Range assignment reports it
as its own refusal category and refuses the **whole** range, since a held booking
owns no per-bed rows at all. This is scoped to the held booking's OWN guests: an
ordinary booking overlapping someone else's hold stays allocatable everywhere
(the hold surfaces it as a conflict and an `overlapsExclusiveHold` badge —
decision 1's never-refuse posture), so no allocation path hard-blocks on another
booking's hold.

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
