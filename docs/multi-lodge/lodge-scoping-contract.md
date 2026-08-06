# Lodge Scoping Contract

This contract records which data is lodge-scoped, which stays club-wide,
and the rules service code must follow. Update this file before changing
the scoping of any model, the same way `finance-dashboard/data-contracts.md`
is updated before metric definitions change.

## Lodge-Scoped Models

These carry a required `lodgeId` after phase 2 (see ADR-001 for migration
sequencing):

| Model | Scoping | Notes |
| --- | --- | --- |
| `LodgeRoom` | direct `lodgeId` | `name` unique per lodge, not globally |
| `LodgeBed` | via `LodgeRoom` | no direct FK |
| `BedAllocation` | via room/booking | no direct FK |
| `Locker` | direct `lodgeId` | `name` unique per lodge; lockers gain a lodge link for the first time |
| `Season` | direct `lodgeId` | lodges may have different season windows |
| `MembershipTypeSeasonRate` | via `Season` | keeps `[seasonId, membershipTypeId, ageTier]` uniqueness. Replaced the boolean-keyed `SeasonRate` at E4 (#1930); `SeasonRate` itself was dropped by `20260721120000_contract_drop_season_rate` (#2129 step 2) |
| `Booking` | direct `lodgeId` | denormalised for capacity/availability query performance; always matches the room's lodge when a room is assigned. `waitlistOfferedLodgeId` (nullable) names the alternate lodge of a live cross-lodge waitlist offer (ADR-004) and never changes the entry's own lodge |
| `BookingWaitlistAlternateLodge` | direct `lodgeId` junction | ADR-004 cross-lodge waitlist opt-in: lodges a waitlisted member would also accept; rows only widen what the processor may offer |
| `BookingGuest` / `BookingGuestNight` | via `Booking` | no direct FK |
| `GroupBooking` | via organiser `Booking` | one group = one lodge (ADR-001 open question 1) |
| `ChoreTemplate` | direct `lodgeId` | roster generation filters by lodge |
| `LodgeSettings` | per-lodge row | converted from singleton |
| `BedAllocationSettings` | per-lodge row | converted from singleton |
| `BookingDefaults` | per-lodge row | converted from singleton |
| `BookingRequestSettings` | per-lodge row | converted from singleton |
| Lodge identity fields (`lodgeName`, `doorCode`, `lodgeTravelNote`) | resolve from `Lodge` (default lodge when no `lodgeId` is in scope) | dropped from the `EmailMessageSetting` singleton (migration `20260709130000`) |

## Club-Wide Defaults With Per-Lodge Overrides

`CancellationPolicy`, `MinimumStayPolicy`, and `BookingPeriod` gain a
nullable `lodgeId` (ADR-001 resolved question 3). Resolution rule: rows
with null `lodgeId` are the club-wide defaults; if any rows exist for a
lodge, that lodge uses its rows instead of — never merged with — the
club-wide set for that policy type. Service code resolves a lodge's
policy through one shared helper so the replace-not-merge rule cannot
drift between the three policy types.

`LodgeInstruction` follows the same rule per document key (delivered
2026-07-03): null-`lodgeId` rows are the club-wide OPEN/CLOSE/DAY_TO_DAY
documents, and a `[lodgeId, key]` row replaces the club-wide document of
that key for that lodge — never merged. Readers resolve through
`getSanitizedLodgeInstructions(lodgeId)`; the kiosk surface derives its
lodge via `resolveKioskLodgeId`, and the admin editor edits one partition
at a time (omitted `lodgeId` means the club-wide partition, not the
default lodge) with an explicit `remove: true` flag to drop an override.
On the member reader (`GET /api/lodge-instructions?lodgeId=`), a hut leader
may only request a lodge they hold a current/upcoming assignment for
(assignment lodge set); an out-of-set `lodgeId` is `403`. Admins may request
any lodge. This keeps a lodge A hut leader from reading lodge B's
operational documents (which may carry door/emergency access details).

## Optional Lodge Restrictions

- `PromoCode`: restricted via a `PromoCodeLodge` junction table (phase 6),
  because a promo may apply at several lodges but not all. No junction
  rows = redeemable at every lodge.
- Member booking eligibility and lodge-operational staff access share the
  `MemberLodgeAccess` junction table (delivered in phase 4) with a `kind`
  enum. `BOOKING_RESTRICTION` rows mean the member may book only the
  listed lodges; no rows is default-open. Enforcement lives in the
  booking service (`assertMemberMayBookLodge`), and the same eligibility
  check (`isMemberEligibleToBookLodge`) also gates the read-side
  availability/pricing surfaces so a restricted member cannot discover a
  forbidden lodge's data: `/api/availability`, `/api/availability/check`,
  `/api/bookings/quote`, and `/api/bookings/rooms` return `403` when a
  restricted lodge is named. `/api/bookings/rooms` also has a no-`lodgeId`
  mode that lists room config across lodges; that listing is **filtered** to
  the member's eligible lodges (empty when none match) rather than returning
  `403` — a listing omits what the member cannot see. Both the named-lodge
  gate and the listing filter derive from `getEligibleLodgeIdsForMember`
  (which `isMemberEligibleToBookLodge` also derives from), so the two are the
  same eligibility set by construction. Admin on-behalf bookings and quotes
  bypass it as the audited override path. `STAFF` rows bind a kiosk account to its lodge;
  exactly one grant binds, zero grants fall back to the default lodge, and
  **two or more grants are ambiguous and denied** (`getStaffLodgeBinding`
  returns `{ kind: "ambiguous" }`; `resolveKioskLodgeId` throws
  `AmbiguousKioskLodgeError` and every kiosk data route maps it to a clean
  `403` via `kioskLodgeAuthErrorResponse`, while PIN login returns `403`
  directly, rather than serve the default lodge's data on the wrong property).
  Hut-leader assignments carry their own `lodgeId` and PINs match only at
  the bound lodge's kiosk. `ADMIN` access is club-wide and never
  lodge-filtered.

## Club-Wide Models (No Lodge Dimension)

These intentionally stay club-wide. Do not add `lodgeId` to them without a
new ADR:

- Membership: `Member`, `MemberAccessRole`, `MembershipType`, family
  groups, applications, subscriptions, lifecycle requests.
- Payments: `Payment`, `PaymentTransaction`, `PaymentRefund`, Stripe
  references. Payments attach to bookings; the booking carries the lodge.
- Xero and finance: all `Xero*` models, `FinanceSnapshot`,
  `FinanceReportCategory*`, item/account mappings. One club-wide ledger and
  one operational Xero connection, consistent with
  `finance-dashboard/decisions/ADR-005-single-operational-xero-connection.md`.
- Email, notifications, audit log, webhooks, cron state, page content,
  media, committee, module settings (`ClubModuleSettings` stays one row).
- Inductions (`InductionChecklistTemplate`/`MemberInduction*`, all kinds
  including `HUT_LEADER`): inductions certify the member, not a building
  (recorded 2026-07-03). If hut-leader inductions ever diverge per lodge,
  that is a new ADR.
- `GroupDiscountSetting` and `BookingDefaults.nonMemberHoldDays` /
  `waitlistCrossLodgeOrder`: booking policy knobs that are club fairness
  decisions, edited club-wide on the booking-policies page.
- Skifield conditions (`WhakapapaReportCache`, the `skifieldConditions`
  module): public-website content, not lodge UI. A per-lodge/per-field
  conditions widget would be a future enhancement, not a scoping change.

## Known Not-Yet-Scoped Surfaces (open)

Audited 2026-07-03; these are lodge-relevant but still club-wide or
default-lodge-pinned. Each needs an owner decision before work starts —
record the outcome here when decided:

(none — the 2026-07-03 audit list is fully resolved; see below)

## Resolved 2026-07-03 (delivered on `feature/multi-lodge-support`)

- **`BookingRequest.lodgeId` (nullable).** Null = the club's default lodge
  (all pre-migration rows); readers resolve `request.lodgeId ?? default`.
  The public general and school forms offer a required lodge choice when
  a second active lodge exists (the public settings endpoint exposes
  active lodges as id/name only); indicative pricing, capacity guards,
  holds, quote acceptance, approval, and the created booking all follow
  the request's lodge, and request emails carry that lodge's identity.
- **`BookingRequestSettings` stays club-wide.** Its three fields (pricing
  visibility, quote TTL, reminder lead) are booking-policy knobs like
  `BookingDefaults`, not per-property values; recorded club-wide rather
  than converted. A new ADR is needed to change this.

- **`WorkPartyEvent.lodgeId` (nullable).** Null = club-wide event (the
  pre-migration meaning). A lodge-bound event's internal promo resolves
  only for bookings at that lodge; the booking form filters events by the
  chosen lodge and labels lodge-bound ones.
- **`LodgeSettings` / `BedAllocationSettings` per-lodge rows.** A lodge's
  row is keyed by its lodge id (`id = lodgeId`); the legacy "default" row
  keeps serving the lodge it was soft-linked to in the phase-2 backfill
  (and single-lodge clubs). Resolution is own row → legacy row when unlinked
  or linked to the same lodge → code defaults; a legacy row linked elsewhere
  is never inherited, so one lodge's values cannot leak to another.
  `LodgeSettings` retains its existing first-write compatibility behavior and
  `hutLeaderLookaheadDays` remains a club-wide knob on its legacy row.
  `BedAllocationSettings` reads the same compatibility chain, but its admin
  API always requires one active lodge: a write updates `default` only when no
  lodge-id row exists and that legacy row is already linked to this lodge;
  otherwise it creates/updates the lodge-id row and leaves the legacy fallback
  untouched. Its
  `autoAllocationEnabled` and strict ordered `allocationPriorityOrder` apply to
  that lodge's board and booking lifecycle only; `[]` is a valid explicit
  neutral order. Config transfer writes authoritative per-lodge settings by
  lodge slug and keeps the legacy singleton path for older bundles. These
  settings soft-links keep a nullable `lodgeId` by design (the `NOT NULL`
  tightening applies only to the six entity tables; see
  `contract-release.md`).
- **CMS `{{lodge-capacity}}` token.** Gains an optional slug parameter
  (`{{lodge-capacity:lodge-slug}}`) for per-lodge figures; the bare token
  keeps resolving the default lodge. No cross-lodge total token — the
  capacity summing ban above applies to content tokens too.
- **Kiosk lodge identity.** The kiosk access payload includes the
  operating lodge's name (null for single-lodge clubs, ADR-002) and the
  kiosk header displays it.
- **Per-lodge kiosk accounts (admin surface).** The Lodge Kiosk admin
  page lists every LODGE-role account with its bound lodge, creates
  additional kiosk accounts bound via a STAFF grant in one step, and
  rebinds/unbinds (unbound = default lodge). The binding mechanism is
  `getStaffLodgeBinding`, which returns `none` (unbound → default lodge),
  `bound` (one grant → that lodge), or `ambiguous` (two or more grants).
  An `ambiguous` binding is **denied, never defaulted**: `resolveKioskLodgeId`
  throws `AmbiguousKioskLodgeError`, which every kiosk data route maps to a
  `403` (via `kioskLodgeAuthErrorResponse`, so a one-click misconfiguration
  is a clean deny rather than a 500) and PIN login returns `403` directly
  ("assigned to multiple lodges — an admin must fix the assignment"), so an
  accidental double-grant cannot silently serve the default lodge's guest
  list/roster or accept its hut-leader PINs on a shared screen. Lodge controls render
  only with a second active lodge (ADR-002).

## School-Group Soft Cap

The school-group soft cap (the bed count above which a school group is
warned it needs a club member to host — a warning only; the hard limit
is the lodge's capacity) is per-lodge on `LodgeSettings.schoolGroupSoftCap`,
resolving via the default lodge in a single-lodge club (ADR-002) and
falling back to the code default (`DEFAULT_SCHOOL_GROUP_SOFT_CAP`) when
unset. It is editable on the lodge-settings card (both `/admin/setup`
and, per-lodge, the lodge hub). The public school form measures against
the selected lodge's cap (the booking-request settings endpoint returns
each lodge's cap plus a top-level default for the single-lodge case).

## Capacity Configuration

Each lodge's capacity resolves in this order (`getLodgeCapacityStatus`):
active configured beds when the Bed Allocation module is on, else the
per-lodge `LodgeSettings.capacity` override, else the club-config bed
total for the default lodge only (additional lodges resolve to 0 until
beds or an override exist, so an unconfigured lodge can never be
overbooked). The per-lodge override is editable in core lodge config on
the lodge hub (`/admin/lodges/[id]`) regardless of the Bed Allocation
module, and on `/admin/setup`. Public and admin booking surfaces cap
guests against the *selected* lodge's capacity (the public booking-request
settings endpoint returns each active lodge's capacity), and the server
re-validates per lodge.

## Service Rules

- Capacity is per lodge: "beds available on date D at lodge L". No code
  path may sum beds across lodges into one number.
- **`lodgeId` is `NOT NULL` on the six entity tables** (LodgeRoom, Locker,
  Season, Booking, ChoreTemplate, HutLeaderAssignment), enforced without an
  outage via a `default_lodge_id()` column default (migration `20260708001100`):
  an old colour's omitted-column insert auto-fills the default lodge, so no null
  is written mid-cutover. `lodgeNullTolerantScope` is now a strict `{ lodgeId }`.
  Policy/settings tables keep a nullable `lodgeId` (null = club-wide default) and
  scope via `resolvePolicyRowsForLodge`. See `contract-release.md`.
- **The club default lodge is the `Lodge.isDefault`-flagged row**, not the
  earliest-`createdAt` one (#1656 / #1627 option b, migration
  `20260709120000`). `getDefaultLodgeId()` and the `default_lodge_id()` SQL
  function both resolve `isDefault` first (then oldest active, then oldest of
  any state, as a defensive fallback), and the two sides are a mirror contract —
  changing one requires a paired migration for the other. The old
  `createdAt`-ordering resolution inverted on non-UTC databases when a lodge was
  created inside the seed's TZ-skew window; the flag removes that class. A slug
  pin was rejected because both the seed and the admin rename route regenerate a
  lodge's slug from its name, so no slug stays stable. Exactly one lodge is
  default, enforced by a partial unique index (`Lodge_isDefault_key`,
  `WHERE "isDefault"`). The migration backfills the flag onto the current
  default; there is no admin UI yet, so **to change the default, unset the
  current row and set the new one in a single transaction** (the partial unique
  index rejects a transient two-default state). Reassign the default before
  deactivating a lodge — a flagged-but-inactive lodge deliberately stays the
  default.
  - **Retired third resolver (#1656 review note, resolved by #1982):**
    `isDefaultLodge()` in `src/lib/lodge-capacity.ts` used to gate the
    club-config capacity fallback with its own oldest-active logic. #1982 removed
    that runtime fallback (capacity is now DB-only), so the resolver — and the
    divergence risk it carried — is gone. Any remaining default-lodge resolution
    routes through `getDefaultLodgeId()` (the flag-aware resolver).
  - **Documented exception — reporting occupancy denominator.** The admin
    reports occupancy view and the finance booking-metrics occupancy summary
    may sum the capacity of all active lodges to form the "all lodges"
    denominator (`resolveMetricsCapacityAndScope` in
    `src/lib/finance-booking-metrics.ts`, reused by `/api/admin/reports`).
    This is the only sanctioned cross-lodge capacity aggregate: a reporting
    read that never feeds availability, booking, or capacity-enforcement
    logic. The surface labels the figure as covering all lodges and offers a
    per-lodge selector; selecting a lodge scopes both the bookings and the
    denominator to that lodge.
- A booking's guests, nights, bed allocations, and requested room must all
  belong to `booking.lodgeId`. Enforce in service logic; add DB constraints
  where practical. Manual bed allocation rejects a bed whose room belongs
  to a different lodge than the booking, and the bed-allocation board,
  auto-allocator, and range approval all operate within one lodge scope.
- Pricing lookups (`findRateForNight`, `calculateBookingPrice`) operate on
  the seasons of exactly one lodge. Callers pass lodge-filtered season
  data; the pure calculation functions stay lodge-agnostic.
- The booking-creation capacity check locks per lodge, not club-wide.
  Two bookings at different lodges must not contend.
- Roster/chore generation for a date runs per lodge and only sees that
  lodge's templates and staying guests.
- Uniqueness-style date checks are per lodge: season overlap validation
  and the hut-leader assignment overlap check compare only rows of the
  same lodge (each lodge runs its own season windows and its own hut
  leader). Rows still missing a lodgeId during the expand release
  conservatively conflict at every lodge.
- Money stays in integer cents and booking dates stay NZ date-only,
  unchanged by lodge scoping.

## Presentation Rule

When exactly one active lodge exists, member and admin UI must not show
lodge selectors, lodge columns, or lodge names in flows where they would
be redundant (ADR-002). APIs still require and return `lodgeId`; the rule
is presentation-only.

Lodge management is core and always available (ADR-005 removed the former
`multiLodge` Admin Module flag; the lodge routes are ungated). Runtime
booking, capacity, and pricing logic never branch on any lodge flag —
lodge count and `lodgeId` are the only lodge signals service code reads.
