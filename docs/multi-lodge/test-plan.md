# Multi-Lodge Test Plan

Multi-lodge changes are not merge-ready with green CI alone. Capacity,
pricing, and booking-transaction changes (phase 3) additionally need the
manual verification below on staging before the second-lodge guard is
lifted.

## Required Automated Coverage

### Unit Tests

- lodge-scoped capacity: per-lodge bed sums, per-lodge settings override
  behaviour, no cross-lodge summation
- pricing with lodge-filtered seasons, including two lodges with
  different rates for the same date and age tier
- booking service lodge integrity: guests, nights, allocations, and
  requested room all match the booking's lodge; mismatches rejected
- single-lodge default resolution: APIs called without `lodgeId` while
  one lodge exists resolve to that lodge
- policy override resolution (phase 2): a lodge with override rows uses
  them instead of the club-wide set; a lodge without overrides falls
  back to club-wide; overrides never merge with defaults
- lodge access/eligibility helpers (phase 4): staff scoped to a lodge,
  member eligibility default-open and restricted cases, `ADMIN` never
  lodge-filtered
- chore/roster generation filtered per lodge (phase 5)
- promo lodge restriction (phase 6): no junction rows redeemable
  everywhere; restricted promo accepted at each listed lodge and
  rejected at unlisted lodges

### Integration Tests

- route boundary tests extended for new lodge admin routes (the static
  guard-marker tests in `src/lib/__tests__/api-route-boundaries.test.ts`
  must cover them)
- availability/quote/booking routes with explicit and defaulted
  `lodgeId`; invalid or inactive lodge rejected
- booking creation under concurrent load at two lodges: capacity locks
  do not contend across lodges, and per-lodge double-booking protection
  still holds. **Deferred to the phase-9 manual staging pass** (see
  Manual Verification → Cross-Lodge Isolation): a real contention test
  needs a live Postgres to exercise advisory locks and serialised
  transactions, which the mocked CI suite cannot reproduce. The lock-key
  shape is unit-tested at `src/lib/__tests__/capacity.test.ts`; the
  behaviour under genuine concurrency is verified only on staging.
- migration backfill assertions: every pre-existing row lands on the
  seeded lodge; re-scoped unique constraints reject cross-lodge
  collisions but allow same-name rooms at different lodges

### Regression Tests

- with exactly one active lodge, every existing test suite passes
  unchanged in behaviour: quotes, capacity, waitlist, cancellation,
  modification, group bookings, roster, kiosk
- single-lodge presentation rule: no lodge selector/column renders with
  one active lodge; renders with two
- `multiLodge` module gating: lodge-management routes 404 while the
  module is off; disabling the module is rejected while more than one
  active lodge exists; booking at existing lodges is unaffected by the
  flag in either state
- Xero invoice generation unchanged: club-wide item/account mappings
  produce identical output for bookings at either lodge

## Advisory Two-Lodge E2E Coverage (#1568)

An **advisory, non-blocking** Playwright project now runs the app with two
active lodges and `multiLodge` ON, giving CI its first real two-lodge signal:
`e2e/two-lodge/two-lodge.spec.ts`, run via `playwright.two-lodge.config.ts` and
`.github/workflows/e2e-two-lodge.yml` against a staging stack prepared with a
second lodge (West Ridge Hut, `DEMO_SECOND_LODGE=1`), the module ON
(`E2E_ENABLE_MULTI_LODGE=1`), and the two-lodge fixtures
(`E2E_TWO_LODGE=1` → `e2e/setup/seed-two-lodge.ts`).

This **does not replace any manual row below.** The manual staging matrix
remains the hard gate before the second-lodge guard is lifted; the advisory
project only smoke-guards a subset against regressions between manual passes.
Advisory automated coverage now exists for:

- **Cross-Lodge Isolation** — per-lodge availability isolation and "a booking at
  one lodge does not consume the other's capacity" (spec scenarios a/b). The
  real-database *concurrent* two-lodge contention row is still manual-only.
- **Operations** — a kiosk account bound to West Ridge (single STAFF grant) sees
  only West Ridge's roster on a shared date, not the default lodge's (scenario
  c). Hut-leader-PIN rejection and roster-overlay rows stay manual-only.
- **Waitlist (cross-lodge accept path, ADR-004)** — a **non-member-guest**
  cross-lodge offer confirms end to end (scenario d). The **member-guest**
  cross-lodge confirm is encoded as an **expected-fail** documenting #1609 (the
  Phase-2 member-night guard trips on the entry's own `WAITLIST_OFFERED`
  booking); an unexpected pass there would signal #1609 is fixed.

Money/pricing at the second lodge and the door-code/travel-note email rows have
**no** advisory automated coverage and remain manual-only.

Promotion of this project from advisory to a blocking required check is a later
owner decision, to be taken after observing its flake rate on `main` — the same
advisory→blocking precedent as the main E2E suite (#1315).

## Manual Verification (Staging)

### Cross-Lodge Isolation

- fill lodge A to capacity for a date; confirm lodge B remains bookable
  for the same date and vice versa
- cancel at lodge A; confirm no availability change at lodge B
- waitlist at a full lodge A while B has space; confirm the waitlist
  offer is for lodge A only
- **concurrent two-lodge booking load (moved here from Integration
  Tests):** drive simultaneous booking creation at both lodges against a
  live database and confirm capacity locks do not contend across lodges
  while per-lodge double-booking protection still holds. This is the
  real-database concurrency check the automated suite cannot cover with
  mocked transactions.

### Money and Pricing

- same member, same dates, both lodges: quotes reflect each lodge's
  rates; Stripe payment and Xero invoice amounts match the quote in
  integer cents
- booking modification moving dates within one lodge reprices against
  that lodge's seasons only
- promo restricted to lodge A rejects redemption on a lodge B booking

### Operations

- kiosk device bound to lodge A shows only lodge A arrivals and roster
- hut-leader PIN for lodge A rejected at lodge B's kiosk
- roster generation for a shared date produces separate, correct rosters
  per lodge
- with two active lodges, the `/admin/roster` calendar colour overlay
  matches the lodge-filtered roster list below it: selecting lodge A shows
  A's per-date statuses only, and switching to lodge B repaints to B's
  (no cross-lodge badges linger). Reference #1587 item 3.
- door-code email for a lodge B booking carries lodge B's code and
  travel note

### Rollback Awareness

- confirm each phase-2 migration step is individually deployable and
  that the app version running during cutover tolerates both the pre-
  and post-migration schema per `BLUE_GREEN_MIGRATION_POLICY.md`

## Evidence

Each phase PR records what was run, what was not run and why, and
residual risk, per `agents/CODEX_WORKFLOW.md` residual-risk reporting.
