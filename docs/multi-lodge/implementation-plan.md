# Multi-Lodge Implementation Plan

Phased delivery plan for multi-lodge support. Each phase is one or more
PRs; no phase bundles schema, money-path logic, and UI in a single change.
Risk labels set the review lenses under the `AGENTS.md` merge gate (#3959):
a High/Critical item gets three lenses, and any open owner decision in it waits
for the owner.

Phases 0–1 are prerequisites for everything else. Phases 4, 5, and 6 are
independent of each other once phase 3 lands and can proceed in any order.

## Phase 0 — Decisions (complete, 2026-07-02)

All five ADR-001 open questions are resolved and recorded in ADR-001
"Resolved Questions": one booking = one lodge; eligibility default-open
with optional restriction; policies club-wide with per-lodge overrides
(replace, not merge); promos club-wide with a multi-lodge restriction
junction; lodge-operational staff scoped per lodge while `ADMIN` stays
club-wide.

**Risk: Low (docs only). Done.**

## Phase 1 — Lodge entity and admin management (delivered 2026-07-02)

Delivered on `feature/multi-lodge-support`. The lodge identity fields were
initially copied (not moved) from `EmailMessageSetting`, with lodge edits
writing through to the singleton while exactly one active lodge existed
(`syncSoleActiveLodgeIdentity`). Email templates read per-booking lodge
context since phase 8. *Progress note (2026-07-09):* the singleton columns
are now DROPPED (migration
`20260709130000_drop_email_message_setting_lodge_identity_columns`), email
identity always resolves from `Lodge` (default lodge when no `lodgeId` is
in scope), and the write-through helper is retired — see
`contract-release.md`.

- Add the `Lodge` model, seeded with one row (migration 1 of the ADR-001
  sequence).
- Add the `multiLodge` Admin Module flag (default OFF) per ADR-002:
  `ClubModuleSettings.multiLodge`, a `MODULE_DEFINITIONS` entry, and
  `feature-routes.ts` rules gating the lodge-management route family.
  The flag gates configuration only; runtime booking logic never reads
  it.
- Lodge-management admin page (module-gated) to view/rename the lodge
  and, later, add a second one. The module flag is the rollout gate: it
  stays off in real deployments until phase 3 is complete and soaked, so
  no deployment enters multi-lodge state early. Disabling the module is
  rejected while more than one active lodge exists.
- Move lodge identity fields (`lodgeName`, `doorCode`, `lodgeTravelNote`)
  from `EmailMessageSetting` onto the lodge, with a compatibility read
  path until phase 8 finishes the email-template updates.

**Risk: Medium (schema + migration, but additive and single-lodge
behaviour preserved).**

## Phase 2 — lodgeId scoping migrations

**Progress:** the expand release (nullable `lodgeId` columns, Booking FK
added NOT VALID then validated, backfill to the sole lodge, ledger
entries, and all runtime writers stamping `lodgeId` via
`getDefaultLodgeId`) is delivered on `feature/multi-lodge-support`
(2026-07-02). Outstanding: the contract release below (NOT NULL +
re-scoped uniqueness) after the expand release deploys.

Per ADR-001 sequencing, across several PRs:

- Nullable `lodgeId` columns on `LodgeRoom`, `Locker`, `Season`,
  `Booking`, `ChoreTemplate`; backfill to the seeded lodge, then enforce
  NOT NULL per the ADR-001 sequencing.
- Nullable `lodgeId` on `CancellationPolicy`, `MinimumStayPolicy`, and
  `BookingPeriod` (permanently nullable — the club-wide-with-override
  pattern); where a table carries a uniqueness key, a partial unique index
  preserves today's uniqueness on the club-wide (null) partition.
  *Progress note (2026-07-09):* the club-wide null-partition partial unique
  indexes shipped in `20260709000100_add_clubwide_policy_partial_unique_indexes`
  for `CancellationPolicy` (`daysBeforeStay`) and `LodgeInstruction` (`key`) —
  raw SQL, invisible to Prisma/`migrate diff`; see `contract-release.md`.
  `MinimumStayPolicy` and `BookingPeriod` carry no unique key in either
  partition, so there is nothing to enforce for them.
- Convert singleton settings tables (`LodgeSettings`,
  `BedAllocationSettings`, `BookingDefaults`, `BookingRequestSettings`)
  to per-lodge rows.
- Enforce NOT NULL and re-scoped unique constraints
  (`[lodgeId, name]` on rooms and lockers) after backfill verification.
  *Progress note (2026-07-03):* the `[lodgeId, name]` re-scoping for
  rooms and lockers shipped early as an expand-safe index swap
  (`20260708000900_rescope_room_locker_name_uniqueness`, re-timestamped into
  the contiguous v0.10.0 block) after two-lodge testing hit the global "Room 1
  already exists" clash; app checks treat null-lodge rows as clashing at
  every lodge until this contract release enforces NOT NULL and adds the
  null-partition partial indexes.
- Run `pnpm run db:check-drift` against a shadow database for every
  migration PR; verify each step against
  `BLUE_GREEN_MIGRATION_POLICY.md`.

**Risk: High (schema/migrations on booking-critical tables). Owner
approval required.**

## Phase 3 — Capacity, pricing, and booking-transaction core

**Progress:** delivered on `feature/multi-lodge-support` (2026-07-02).
Notable implementation decisions beyond the plan text:

- Capacity fallback: since #1982 capacity is DB-only — the club-config bed
  total is no longer a runtime fallback (the default lodge's
  `LodgeSettings.capacity` is backfilled from it by the boot self-heal). Any
  lodge, default or additional, with no configured beds and no capacity
  override resolves to capacity 0 (`unconfigured_lodge`) so it can never be
  overbooked before setup.
- Overlap queries tolerate null `lodgeId` rows (written by a draining old
  colour during the expand deploy) by counting them against every lodge —
  exact while one lodge exists, conservative afterwards, dead once the
  contract release enforces NOT NULL.
- The advisory lock is `pg_advisory_xact_lock(hashtextextended(lodgeId, 0))`
  via the shared `acquireLodgeCapacityLock` helper; the draft-cleanup cron
  locks every affected lodge in sorted order and re-scans under the locks.
- Policy resolution (`CancellationPolicy`, `MinimumStayPolicy`,
  `BookingPeriod`) goes through `resolvePolicyRowsForLodge` implementing
  the replace-not-merge override rule over the whole policy type.

The critical phase. Thread `lodgeId` through:

- `src/lib/lodge-capacity.ts` (`getLodgeCapacity` becomes per-lodge bed
  sum; retire or per-lodge the `LodgeSettings.capacity` override —
  decide during implementation).
- `src/lib/capacity.ts` (`getAvailability`, `checkCapacity`,
  `checkCapacityForGuestRanges`, `getMonthAvailability`) — every booking
  overlap query gains a lodge filter.
- `src/lib/policies/pricing.ts` callers — season loading gains a lodge
  filter; the pure calculation functions keep their current signatures.
- Booking creation/modification transactions — the capacity advisory
  lock becomes per-lodge; verify no cross-lodge contention and no
  regression in the double-booking protection.
- Availability/quote/booking API routes accept and validate `lodgeId`
  (defaulting to the sole lodge while one exists, so existing clients
  keep working).

Test-first: extend the capacity/booking test suites with two-lodge
fixtures before changing logic. Cross-lodge isolation (a full lodge A
never blocks a booking at lodge B, and vice versa) is the headline
regression risk.

**Risk: Critical (money and booking capacity). Owner approval and staging
soak required before the phase-1 "second lodge" guard is lifted.**

## Phase 4 — Access scoping and booking eligibility

**Progress:** delivered on `feature/multi-lodge-support` (2026-07-02).
Implementation decisions beyond the plan text:

- `MemberLodgeAccess` carries a `kind` enum: `BOOKING_RESTRICTION` rows
  mean the member may book only the listed lodges (no rows =
  default-open); `STAFF` rows bind a kiosk account to its lodge.
- Admin bookings on behalf of a member bypass the booking restriction
  deliberately — the restriction is admin-configured policy and the
  on-behalf flow is the audited override path.
- Group-join bookings need no eligibility check: the joiner is a
  freshly created non-login member, default-open by construction.
- Hut-leader PINs match only assignments at the kiosk's bound lodge
  (or legacy null-lodge assignments until the contract release).
- `ADMIN` access remains club-wide; nothing admin-facing reads the
  grant table for authorization.

- New junction table (working name `MemberLodgeAccess`) expressing
  per-lodge grants, used for both staff access and member booking
  eligibility per the phase 0 decisions.
- Lodge-scoped staff access: kiosk/roster tools and hut-leader PIN
  sessions bind to a lodge (`HutLeaderAssignment` gains `lodgeId`; the
  kiosk device declares its lodge). `ADMIN` access stays club-wide and is
  never lodge-filtered — the scoping applies to lodge operations, not
  back-end administration.
- Member booking eligibility enforcement in the booking service (not
  UI-only), default-open: no restriction rows means every active member
  can book every active lodge.

**Risk: High (auth boundaries). Owner approval required.**

## Phase 5 — Chores and roster

**Progress:** delivered on `feature/multi-lodge-support` (2026-07-02).
Kiosk requests resolve their lodge via `resolveKioskLodgeId` (PIN
assignment's lodge; STAFF grant for lodge/admin accounts; the member's
active booking for staying guests; session-login hut leaders resolve
via their own assignment). Roster generation, chore templates,
guest lists, and arrival/departure mutations are scoped to that lodge
with null-tolerant filters; cross-lodge mutations are rejected.

- `ChoreTemplate.lodgeId` filtering in roster generation and the chore
  allocator; roster pages and print views take lodge context from the
  kiosk/staff session's lodge.

*Progress note (2026-07-03):* the **admin** roster surface
(`/admin/roster` and its print view) had been missed by the phase 7
retrofit — the route hardwired the default lodge and the page had no
picker, so admins could only ever see the default lodge's roster. The
route now accepts `?lodgeId=` (validated active lodge, 400 otherwise,
default-lodge fallback when omitted) across GET and every mutation, and
the page carries the standard `LodgeSelect` + URL lodge context through
fetches, mutations, and the print link. Kiosk roster routes were already
lodge-bound and are unchanged.

*Progress note (2026-08-02, #2478):* one more roster read had been missed
— the standalone printable-roster feed
`/api/chores/roster/[date]/print`, which no page calls (the admin Print
Roster button goes to `/api/admin/roster/[date]`). It queried chore
assignments and staying guests club-wide. It now resolves its lodge the
same way the admin roster route does (`?lodgeId=` validated active, 400
otherwise, default-lodge fallback) and scopes both queries —
`choreTemplate: lodgeNullTolerantScope(...)` on the assignments, a plain
lodge match on the bookings — so it can only ever answer for one lodge.

**Risk: Medium.**

## Phase 6 — Promo codes

**Progress:** delivered on `feature/multi-lodge-support` (2026-07-02).
`PromoCodeLodge` junction added (no rows = every lodge); validation and
redemption check the booking's lodge; admin promo routes accept
`lodgeIds` replace-set style and serialize them.

- `PromoCodeLodge` junction table (no rows = redeemable at every lodge;
  rows = redeemable only at those lodges, supporting "two of three"
  restrictions); validation and redemption checks compare against the
  booking's lodge; admin promo UI gains the optional multi-select lodge
  restriction.

**Risk: Medium-High (touches redemption/allocation money paths).**

## Phase 7 — Admin UI retrofit

**Progress:** delivered on `feature/multi-lodge-support` (2026-07-02) for
the configuration pages: rooms/beds, seasons, lockers, chores (shared
`LodgeSelect` context selector; lists filter per lodge with null-tolerant
scoping and creates stamp the selected lodge), the hut-leader assignment
form (lodge picker plus a lodge column, with the assignment-overlap check
now scoped per lodge so each lodge can have its own leader), the promo
editor (`lodgeIds` multi-select restriction), and a member Lodge Access
card on the admin member detail page (booking restriction + staff grants
over the phase-4 API). Season overlap validation also became per-lodge
(lodges may run different season windows). Every control honours the
ADR-002 presentation rule via `LodgeSelect`, which renders nothing with
fewer than two lodges. The two items deferred from the first
phase-7 PR landed in follow-ups: the admin booking list lodge filter and
column (with phase 8), the bed-allocation board's lodge context (board,
auto-allocation, and range approval all follow one lodge scope, and
manual allocation now enforces that a bed belongs to the booking's
lodge), and the booking-policy per-lodge override editors (cancellation,
minimum stay, and booking periods each gained a scope selector editing
exactly one partition — club-wide null rows or one lodge's override set —
with create/remove-override flows on the cancellation editor). Policy
admin routes accept a validated `lodgeId` and never cross partitions;
the runtime replace-not-merge resolution was already in place from
phase 3. Room/locker names stay globally unique until the
phase-2 contract release re-scopes the constraints.

- Build the lodge-picker pattern once (a context selector honouring the
  ADR-002 single-lodge presentation rule) and apply it to: rooms/beds,
  lockers, seasons, bed allocation, chores, booking policies (if
  lodge-scoped), lodge settings.
- Admin booking list/search/detail gain lodge filters and columns (again
  hidden while one lodge exists).

**Risk: Medium (UI over already-guarded APIs).**

## Phase 7b — Lodge configuration hub (ADR-003)

**Progress:** delivered on `feature/multi-lodge-support` (2026-07-02).
`/admin/lodges/[id]` (inside the module-gated lodges route family) shows
the lodge's identity plus per-area summary cards — rooms & beds with
resolved capacity, lockers, seasons, chores — linking to the existing
pages pre-filtered via `?lodgeId=`; those pages now initialise their
selector from that parameter and render it in one consistent slot.
Rooms/beds and lockers gained transactional bulk-seed endpoints and
quick-add forms ("N rooms of M beds", "N lockers") with a name prefix;
clashes with the still-global name uniqueness are rejected whole, not
half-applied.

- Hub page summarising a lodge's configuration state with links into the
  per-area pages (ADR-003).
- URL-driven lodge context and a single selector placement convention on
  the retrofitted pages.
- Bulk seeding for rooms/beds and lockers.

**Risk: Medium (admin UI plus additive bulk-create APIs over existing
guards).**

## Phase 8 — Member UI and communications

**Progress:** delivered on `feature/multi-lodge-support` (2026-07-02).
The member `/book` flow (and the admin book-on-behalf flow) starts with a
`LodgeSelect` step — member scope via `/api/lodges`, so a restricted
member never sees lodges they cannot book — and threads the chosen
`lodgeId` through the calendar (`/api/availability`), range check
(`/api/availability/check`), minimum-stay check
(`/api/booking-policies/check`), room preferences (`/api/bookings/rooms` —
the CREATE flow only, and always with the chosen `lodgeId` on it, never the
no-`lodgeId` cross-lodge mode; editing an existing booking's requested room
reads the booking-scoped `/api/bookings/[id]/requested-room/options` instead,
#2664),
quote, promo validation (`/api/promo-codes/validate`), and booking
create/draft/waitlist calls. Since #2701, `POST /api/bookings` refuses an
omitted `lodgeId` with `BOOKING_LODGE_REQUIRED` before consulting the default
lodge; the create services (`createDraftBooking`,
`createConfirmedBooking`, `createWaitlistedBooking`) take `lodgeId` in
their shared input, and `resolveBookingLodgeId` enforces the scoping
contract (active lodge; a requested room must belong to the booking's
lodge — `BookingLodgeError` → 400). Internal production callers name the
authoritative lodge too: copied bookings keep the source lodge and group-join
children inherit the organiser's lodge. The per-booking max-guests check uses
the chosen lodge's capacity. Emails: `prepareEmailMessage`/`sendEmail`
accept the booking's `lodgeId` and `loadEmailMessageSettingsForLodge`
overlays the lodge's name, travel note, and door code onto the settings —
strictly the lodge's own door code, never another lodge's from the
singleton — for booking-confirmed and pre-arrival sends (all ten
confirmation call sites and the pre-arrival cron pass the booking's
lodge). The admin bookings list gained a lodge filter (null-tolerant) and
column, hidden with one lodge. Copy: capacity/waitlist messages in the
booking flows name the lodge once a second lodge exists; template strings
keep the generic phrase because ADR-002 forbids lodge names for
single-lodge clubs, and the CLUB_LODGE_NAME/travel-note/door-code tokens
now carry the booking lodge's values in multi-lodge deployments. Kiosk
screens needed no change (phase 5 already scopes them per lodge and they
never display door codes). The remaining booking email senders (pending,
bumped/guests-cancelled, cancelled, review approved/declined, chore
roster, check-in reminder, modified, card-setup-failed, and the three
waitlist emails — fifteen senders, twenty-seven call sites) now thread
the booking's `lodgeId` through `sendEmail` as well, completing the
sweep. The deferred drop of the `EmailMessageSetting` lodge-identity
columns landed 2026-07-09 as migration `20260709130000` together with the
identity-resolution refactor that made it safe (see `contract-release.md`);
`syncSoleActiveLodgeIdentity` is retired.

- Booking flow lodge selection step (shown only with >1 active lodge),
  carried through availability, quote, and creation calls.
- Booking confirmations, pre-arrival/door-code emails, and kiosk screens
  use the booking's lodge for name, travel note, and door code.
- Copy sweep for hardcoded "the lodge" strings.

**Risk: Medium.**

## Phase 9 — Validation, soak, and enabling multi-lodge

- Staging seeded with two, then three, lodges; full end-to-end pass per
  `test-plan.md` (booking, payment, modification, cancellation, waitlist,
  group booking, roster, kiosk at each lodge; cross-lodge isolation
  checks).
- Enable the `multiLodge` module in the real deployment and create the
  second lodge.
- Update `docs/ARCHITECTURE.md`, `docs/DOMAIN_INVARIANTS.md`,
  `docs/END_TO_END_TEST_MATRIX.md`, `docs/UX_FLOW_MAP.md`,
  `CONFIGURATION.md`, and `README.md` to describe the lodge dimension
  (these are also updated incrementally in earlier phases as behaviour
  actually changes).

**Risk: High gate review; the change itself is mostly test/docs.**

## Future Enhancements (post phase 9)

Recorded so they are not lost; each needs its own scoping when picked
up.

- **Cross-lodge waitlist opt-in.** Promoted out of this list on
  2026-07-03: design accepted as
  [ADR-004](decisions/ADR-004-cross-lodge-waitlist.md) (owner decisions:
  configurable queue order defaulting to own-lodge-first; explicit
  confirmation of the repriced offer). Members joining a waitlist may
  opt into alternate lodges; the processor offers a freed bed
  cross-lodge per the configured order, and acceptance creates a fresh
  booking at the offered lodge and cancels the waitlist entry — never a
  lodgeId mutation. Risk: High (waitlist/money paths); owner review
  before merge.

  *Progress note (2026-07-03):* implemented end to end on this branch.
  Expand migration `20260708000500_add_cross_lodge_waitlist` adds the
  `BookingWaitlistAlternateLodge` junction, nullable
  `Booking.waitlistOfferedLodgeId`/`waitlistOfferedPriceCents`, and
  `BookingDefaults.waitlistCrossLodgeOrder` (default `OWN_LODGE_FIRST`).
  The `/book` waitlist prompt offers eligible alternate-lodge checkboxes
  (ADR-002 presentation rule); the create API validates alternates
  (active, distinct, member-eligible) in `createWaitlistedBooking`.
  `processWaitlistForDates` takes the freed lodge from every caller,
  locks all active lodges in sorted order, and runs the cross-lodge pass
  per the configured order with eligibility and priceability gates; the
  offer email and the booking-page offer card state the offered lodge
  and quoted price. Confirm dispatches cross-lodge offers to
  `confirmCrossLodgeWaitlistOffer` (create-and-cancel through
  `createConfirmedBooking`, price re-checked against the stored quote —
  drift refreshes the quote and asks the member to re-confirm). The
  queue order is edited on the booking-policies page (club-wide, shown
  only with a second lodge). Deliberate narrowing, recorded in ADR-004:
  waitlist entries carrying a promo redemption are never offered
  cross-lodge — promo revalidation at another lodge collides with
  usage-limit counting of the entry's own redemption; their same-lodge
  flow is unchanged.
- **Per-lodge revenue reporting** via Xero tracking categories or a
  lodge dimension on finance snapshots (kept club-wide by ADR-001; a
  future ADR would record any change).
- **New-lodge setup wizard.** A guided flow on lodge creation (identity →
  rooms/beds → lockers → seasons/rates → chores, steps gated by enabled
  modules) with copy-from-existing-lodge for chores and rates. The
  ADR-003 hub and bulk-seed endpoints are its building blocks; there is
  no safety pressure forcing it because an unconfigured lodge resolves to
  capacity 0 (phase 3).

  *Progress note (2026-07-03):* delivered at `/admin/lodges/[id]/setup`.
  Creating a lodge redirects into the wizard; the hub gains a "Setup
  wizard" button; every step is skippable. Rooms/lockers steps quick-seed
  via the existing bulk endpoints with lodge-name-prefixed defaults
  (names stay club-wide unique until the contract release); seasons and
  chores copy from an existing lodge through the standard admin create
  routes with per-item failure reporting. UI-only composition — no new
  server surface; browser-verified end to end (see ADR-003 update).

## Post-audit scoping batch (2026-07-03)

A full-schema audit against the scoping contract (see its "Resolved
2026-07-03" section) delivered, in one batch on this branch: lodge-bound
work-party events, per-lodge kiosk instructions with club-wide fallback,
lodge-aware public/school booking requests end to end, per-lodge
LodgeSettings/BedAllocationSettings rows (id-keyed, legacy "default" row
preserved), the parameterised `{{lodge-capacity:slug}}` CMS token, the
kiosk header lodge name, and lodge identity on booking-request emails.
`BookingRequestSettings` and `BookingDefaults` are recorded as
deliberately club-wide policy knobs; inductions, group discount, and
skifield conditions are recorded club-wide in the contract.

## Standing Rules for Every Phase

- Follow `agents/CODEX_WORKFLOW.md`: one branch per issue-scoped change,
  tests with the change, validation results in the PR body, merge
  commits only.
- Single-lodge behaviour must be preserved at every merge point — each
  phase lands with the club still operating exactly as today until
  phase 9 deliberately enables the second lodge.
- Update this plan, the scoping contract, and the affected core docs in
  the same PR when reality diverges from the plan.
- Nothing in this work touches live providers; all validation uses local
  or staging environments per `AGENTS.md`.

## Upstream Contribution

This work happens on a public fork with the intent to offer it upstream.
Keep commits free of club-specific data (lodge names, door codes, network
details, registry hosts); those belong in deployment configuration, not
the repository. Phase boundaries above are chosen so upstream can review
and adopt the work as a sequence of coherent PRs rather than one bulk
drop.
