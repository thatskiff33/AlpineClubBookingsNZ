# Delivery Plan

## Context

The TACBookings app (9 build phases + security audit complete, 292 tests passing) needs ~75 new features across 7 requirement areas: admin member management, member self-service, booking modifications, lodge/kiosk, notifications, admin operations, observability, and compliance/public pages. This plan groups features into dependency-ordered phases with concurrency notes.

Note: A9 and 5a are the same feature (admin dashboard real data); B4 and 5b are the same feature (member dashboard real data). They appear once below under their canonical IDs.

---

## Phase 1: Foundational Infrastructure

**Features:** CAN-01, CAN-02, SCH-01, SCH-02, FEE-01, OBS-04, OBS-06, OBS-09, OBS-13

**Why first:** Schema additions (SCH-01/02) are required by booking modifications. Cancel consolidation (CAN-01/02) eliminates duplicated logic before further cancel-path changes. Structured logging (OBS-04) touches ~85 call sites -- doing it early avoids rework. Health endpoint and log rotation are zero-dependency infra.

- CAN-01: Extract shared cancellation service into `src/lib/booking-cancel.ts`
- CAN-02: Switch CancelBookingButton to path-based route, deprecate body-based route
- SCH-01: Add `BookingModification` model to Prisma schema
- SCH-02: Add `changeFeeCents` to `Payment` model
- FEE-01: Extract `getRefundTier()` from `cancellation.ts` with unit tests
- OBS-04: Replace ~85 `console.*` calls with structured pino logger
- OBS-06: `GET /api/health` endpoint (DB, Stripe, Xero, SMTP checks)
- OBS-09: `CronJobRun` Prisma model + persist run metadata in `instrumentation.ts`
- OBS-13: Docker Compose log rotation config (json-file, 10m x 5)

**Dependencies on other phases:** None
**Estimated effort:** L (mostly mechanical refactoring + schema additions)

---

## Phase 2: Dashboard Hydration & Profile Quick Wins

**Features:** A9/5a, B4/5b, A7, A10, B1, B8, B7, B9

**Why early:** Fixes visible placeholder/stubbed data across dashboards. All features are small, independent, and high-visibility.

- A9/5a: Admin dashboard -- replace hardcoded `totalBookings: 0` with real DB queries
- B4/5b: Member dashboard -- real upcoming bookings count, recent bookings list
- A7: Add subscription status column to admin members table
- A10: Expose `forcePasswordChange` toggle in admin member actions + badge
- B1: Add "Change Password" form/link on profile page
- B8: Profile security section with password change link + `passwordChangedAt` field
- B7: Editable notes field on booking detail page (`PUT /api/bookings/[id]/notes`)
- B9: Membership status card on profile page (current season + history)

**Dependencies on other phases:** None
**Can run concurrently with:** Phase 3, Phase 4, Phase 5, Phase 10
**Estimated effort:** M

---

## Phase 3: Admin Member Management

**Features:** A1, A2, A3, A4, A5, A6, A8, A11

**Internal dependency chain:** A1 -> A2 -> A3, A1 -> A11, A5 -> A6

- A1: Server-side pagination for members API + table controls
- A11: Sortable table columns (sort params via API) -- depends A1
- A2: Advanced filtering (role, status, age tier, Xero, subscription) -- depends A1
- A3: CSV export respecting current filters -- depends A2
- A4: CSV import with validation, preview, optional invite emails + Xero linking
- A5: Bulk deactivate/reactivate with selection UI + confirmation
- A6: Bulk role change -- depends A5 (shares selection UI)
- A8: Member detail view (`/admin/members/[id]`) with booking history + audit log

**Dependencies on other phases:** None
**Can run concurrently with:** Phase 2, Phase 4, Phase 5
**Estimated effort:** L

---

## Phase 4: Admin Operations & Tooling

**Features:** 1a-c (Subscription tracking), 2a-c (Payments list), 3a-c (Audit log viewer), 4a-b (Report export)

- 1a: Subscription overview page `/admin/subscriptions` with season selector
- 1b: Subscription status API (`GET /api/admin/subscriptions`)
- 1c: Sidebar nav entry for Subscriptions
- 2a: Payments list page `/admin/payments` with summary cards, filters, pagination
- 2b: Payments API (`GET /api/admin/payments`)
- 2c: Sidebar nav entry for Payments
- 3a: Audit log page `/admin/audit-log` with expandable details
- 3b: Audit log API (`GET /api/admin/audit-log`)
- 3c: Sidebar nav entry for Audit Log
- 4a: CSV export button on reports page (client-side Blob generation)
- 4b: PDF export via `window.print()` with `@media print` stylesheet

**Dependencies on other phases:** None
**Can run concurrently with:** Phase 2, Phase 3, Phase 5
**Estimated effort:** L

---

## Phase 5: Member Auth Enhancements

**Features:** B2, B3

**Why separate:** Both require schema migrations (new token models), new API routes, and email flows. B3 (email verification) affects the registration and booking creation flows.

- B3: Email verification on registration -- `emailVerified` field, verification token model, booking gate, resend flow, existing members grandfathered
- B2: Email change with verification -- `EmailChangeToken` model, verify flow, old-email notification, Xero contact update

**Dependencies on other phases:** None
**Can run concurrently with:** Phase 2, Phase 3, Phase 4
**Estimated effort:** L

---

## Phase 6: Notifications

**Features:** N-01 to N-13

**Internal dependency chain:** N-08 -> N-09, N-08 -> N-12, N-10 -> N-11

**Sub-phase 6a (core alerts, no deps):**
- N-01: Check-in reminder email (cron + template)
- N-02: Admin alert -- new booking created
- N-04: Admin alert -- payment failure
- N-06: Admin alert -- pending approaching deadline
- N-07: Admin alert -- booking bumped
- N-10: Email delivery tracking (`EmailLog` model + logging in `sendEmail`)

**Sub-phase 6b (depends on 6a):**
- N-03: Admin alert -- capacity warning (cron)
- N-05: Admin alert -- Xero sync errors
- N-08: Notification preferences (schema + profile UI + email checks)
- N-11: Email retry with backoff -- depends N-10
- N-13: Admin digest email (consolidates N-02 to N-07)

**Sub-phase 6c (depends on 6b):**
- N-09: Bulk member communication -- depends N-08
- N-12: Post-stay feedback request -- depends N-08

**Dependencies on other phases:** None (uses existing cron/email infra)
**Can run concurrently with:** Phase 7, Phase 8
**Estimated effort:** XL

---

## Phase 7: Lodge & Kiosk

**Features:** F1-F11 (from lodge/kiosk requirements)

**Internal dependency chain:** F1 -> F2 -> F6/F8/F9, F3 -> F7, F4 -> F11, F1+F2+F3+F4 -> F6, F9 -> F10

**Sub-phase 7a (foundational, parallel):**
- F1: LODGE role + lodge account (schema + auth + seed)
- F3: ChoreTemplate `timeOfDay` enum + migration + UI grouping
- F4: Chore frequency settings (schema + allocator + admin UI)
- F5: Family group allocation (allocator-only change)

**Sub-phase 7b (depends on 7a):**
- F2: iPad kiosk page (`/lodge/kiosk`) + lodge API endpoints -- depends F1
- F7: Arriving/departing guest routing in allocator -- depends F3
- F11: Chore history lookback for frequency-based generation -- depends F4

**Sub-phase 7c (depends on 7b):**
- F9: Guest arrival/departure and chore tick-off on kiosk -- depends F1, F2
- F6: Hut leader wizard `/lodge/roster/[date]/setup` -- depends F1, F2, F3, F4

**Sub-phase 7d (depends on 7c):**
- F8: Hut leader role assignment (admin UI + date-scoped auth) -- depends F1, F2, F6
- F10: Per-guest email link for chore access -- depends F9

**Dependencies on other phases:** None
**Can run concurrently with:** Phase 6, Phase 8
**Estimated effort:** XL

---

## Phase 8: Booking Modifications

**Features:** FEE-02, FEE-03, MOD-01-05, CHR-01, XER-01, EML-01, UI-01-03, B5, B6 (B5/B6 are satisfied by MOD-01+UI-01 and MOD-03/04+UI-02)

**Internal dependency chain:** FEE-02 -> FEE-03/MOD-01/MOD-05, MOD-01 -> MOD-02/CHR-01/XER-01/EML-01/UI-01, MOD-03+MOD-04+MOD-05 -> UI-02

**Sub-phase 8a (core logic):**
- FEE-02: Late-notice change fee calculation (`src/lib/change-fee.ts`)
- FEE-03: Change fee interaction with cancellation refund -- depends Phase 1 (CAN-01, SCH-02, FEE-01)
- MOD-05: Modification quote API (read-only preview)

**Sub-phase 8b (APIs, depends on 8a):**
- MOD-01: Date change API (`PUT /api/bookings/[id]/modify-dates`) -- XL, core endpoint
- MOD-03: Add guests API (`POST /api/bookings/[id]/guests`)
- MOD-04: Remove guest API (`DELETE /api/bookings/[id]/guests/[guestId]`)
- UI-03: Modification history card on booking detail page

**Sub-phase 8c (integrations, depends on 8b):**
- MOD-02: Extend stay (covered by MOD-01)
- CHR-01: Chore cleanup on date change
- XER-01: Xero invoice adjustment on price change
- EML-01: Booking modified email template

**Sub-phase 8d (UI, depends on 8b+8c):**
- UI-01: Change dates UI on booking detail page
- UI-02: Manage guests UI on booking detail page

**Dependencies on other phases:** Phase 1 (SCH-01, SCH-02, CAN-01, FEE-01)
**Can run concurrently with:** Phase 6, Phase 7 (after Phase 1 complete)
**Estimated effort:** XL

---

## Phase 9: Observability (Sentry & Monitoring)

**Features:** OBS-01, OBS-02, OBS-03, OBS-05, OBS-07, OBS-08, OBS-10, OBS-11, OBS-12

**Internal dependency chain:** OBS-01 -> OBS-02/OBS-03/OBS-10/OBS-11, OBS-06+OBS-08+OBS-09 -> OBS-07

- OBS-01: Sentry server-side integration (`@sentry/nextjs`)
- OBS-02: Sentry client-side (error boundaries) -- depends OBS-01
- OBS-03: Sentry cron monitoring (3 cron jobs) -- depends OBS-01
- OBS-05: API route request logging middleware -- depends Phase 1 (OBS-04)
- OBS-08: Webhook delivery monitoring (`WebhookLog` model) -- depends Phase 1 (OBS-04)
- OBS-10: Sentry performance tracing -- depends OBS-01
- OBS-11: Sentry alerting rules -- depends OBS-01, OBS-03
- OBS-12: External uptime monitoring -- depends Phase 1 (OBS-06)
- OBS-07: Admin health dashboard `/admin/health` -- depends Phase 1 (OBS-06, OBS-09), OBS-08

**Dependencies on other phases:** Phase 1 (OBS-04, OBS-06, OBS-09)
**Can run concurrently with:** Phase 6, Phase 7, Phase 8
**Estimated effort:** L

---

## Phase 10: Compliance & Public Content

**Features:** F-COMP-01, F-COMP-02, F-COMP-03, F-COMP-04, F-PUB-01, F-PUB-02, F-PUB-03, F-PUB-04

- F-COMP-01: Privacy policy page (`/privacy`)
- F-COMP-02: Terms of service page (`/terms`)
- F-PUB-01: Committee page content (admin-editable data source)
- F-PUB-02: Join page with fee information
- F-PUB-03: Contact page with contact form + rate limiting
- F-PUB-04: FAQ page (accordion UI, data-driven)
- F-COMP-03: Personal data export (JSON download from profile)
- F-COMP-04: Account deletion workflow (request -> admin review -> anonymise) -- XL

**Dependencies on other phases:** None (F-COMP-04 uses existing cancel/email/audit infra)
**Can run concurrently with:** All other phases
**Estimated effort:** L

---

## Concurrency Map

```
Phase 1 (Infra) ──────────────┐
                               ├── Phase 8 (Booking Mods)
                               ├── Phase 9 (Observability)
                               │
Phase 2 (Dashboards) ─────────┤
Phase 3 (Admin Members) ──────┤── All independent, run any 2-3 concurrently
Phase 4 (Admin Ops) ──────────┤
Phase 5 (Auth Enhancements) ──┤
                               │
Phase 6 (Notifications) ──────┤── Independent of each other
Phase 7 (Lodge/Kiosk) ────────┤
                               │
Phase 10 (Compliance/Content) ─── Can run anytime
```

**Phases 2, 3, 4, 5, 10** have no inter-phase dependencies and can run in any order or concurrently.
**Phases 8, 9** depend on Phase 1 completing first.
**Phases 6, 7** are independent of everything and can start anytime.

---

## Effort Summary

| Phase | Effort | Feature Count |
|-------|--------|---------------|
| 1. Foundational Infrastructure | L | 9 |
| 2. Dashboard & Profile Quick Wins | M | 8 |
| 3. Admin Member Management | L | 8 |
| 4. Admin Operations & Tooling | L | 11 |
| 5. Member Auth Enhancements | L | 2 |
| 6. Notifications | XL | 13 |
| 7. Lodge & Kiosk | XL | 11 |
| 8. Booking Modifications | XL | 15 |
| 9. Observability | L | 9 |
| 10. Compliance & Public Content | L | 8 |
| **Total** | | **~75 unique features** |

---

## CLAUDE.md Strategy

The current `CLAUDE.md` is 1242 lines. Much of it is historical build logs and original planning material that served its purpose during the initial 9-phase build. For the next wave of development, it needs to be restructured to stay useful without overwhelming context windows.

### What stays (in CLAUDE.md)

These sections contain active reference material that new sessions need:

- **Context** (line 473) -- project description, club details, user count. Keep as-is.
- **Tech Stack** (line 477) -- active decisions. Keep as-is.
- **Architecture Overview** (line 500) -- deployment topology. Keep as-is.
- **Project Structure** (line 522) -- directory layout. **Update** to reflect new files/routes added in each delivery phase.
- **Database Schema** (line 585) -- entity descriptions. **Update** as schema evolves (new models, new fields).
- **Core Business Logic** (line 698) -- booking flow, bumping, pricing, cancellation, chores, Xero. Keep as-is; **extend** when booking modifications are built.
- **Key Design Decisions** (line 925) -- keep and extend with new decisions.
- **Verification & Testing** (line 933) -- keep as-is.
- **Remaining Post-Build Tasks** (line 468) -- **update** to reference the delivery plan phases.

### What gets summarised (replace verbose sections with brief summaries)

- **Build Status** (lines 3-470, ~470 lines) -- The 6 review sections and 9 phase completion logs are historical. Replace with a single **Build History Summary** paragraph: "9 build phases + security audit + 5 integration reviews completed. 292 tests pass. All critical/high issues resolved. See `docs/BUILD_HISTORY.md` for full details."
- **Phased Build Order** (lines 826-924, ~100 lines) -- Original week-by-week plan is now complete and superseded by the delivery plan. Replace with: "Original 9-phase build complete. See `docs/DELIVERY_PLAN.md` for the next wave of features."
- **Email Notifications** table (line 764) -- Keep but mark which are implemented vs planned.
- **Deployment** section (line 780) -- Keep but trim the env var list (already in `.env.example`).

### What gets archived (move out of CLAUDE.md entirely)

- **Development Workflow: How to Build This with Claude** (lines 942-1170, ~230 lines) -- Claude Code usage guide, hook config, session templates. Move to `docs/DEVELOPMENT_WORKFLOW.md`. This is meta-process documentation, not codebase context.
- **Build Progress / Phase details** (lines 1175-1242) -- Detailed phase 1 completion log. Merge into the archived build history doc.
- **Per-phase completion logs** (Security Audit, Reviews #1-5, Phase 5-9 details) -- Move to `docs/BUILD_HISTORY.md`.

### New content to add

- **Current State** -- Brief "what works today" summary (auth, booking, payments, Xero, chores, promo codes, admin reports, email notifications).
- **What's Next** -- Pointer to `docs/DELIVERY_PLAN.md` with current phase status.
- **How to Run** -- Consolidate the scattered `npm install` / `npm test` / `npm run build` instructions into one canonical block at the top.

### Target structure after cleanup

```
CLAUDE.md (~400 lines, down from 1242)
├── How to Run (install, test, build, seed)
├── Current State (what works today)
├── What's Next (link to DELIVERY_PLAN.md)
├── Context
├── Tech Stack
├── Architecture Overview
├── Project Structure (updated)
├── Database Schema (updated)
├── Core Business Logic
├── Email Notifications (updated)
├── Deployment (trimmed)
├── Key Design Decisions (extended)
├── Verification & Testing
└── Build History Summary (1 paragraph + link to docs/BUILD_HISTORY.md)
```

### When to execute the cleanup

Do the CLAUDE.md restructure as the **first task of Phase 1** (Foundational Infrastructure), before any feature work. This ensures all subsequent sessions benefit from the leaner file. Archive files (`docs/BUILD_HISTORY.md`, `docs/DEVELOPMENT_WORKFLOW.md`) are created in the same commit.
