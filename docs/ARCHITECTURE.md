# Architecture

AlpineClubBookingsNZ is a full-stack TypeScript monolith for club booking and membership
operations. It is built around Next.js App Router route handlers,
Prisma/PostgreSQL, Stripe, Xero, AWS SES, cron jobs, and Docker Compose
deployment.

## Runtime Shape

```text
Browser
  |
  v
Caddy reverse proxy
  |
  v
Next.js app container
  |
  +-- PostgreSQL 16
  +-- Stripe API and webhooks
  +-- Xero API and webhooks
  +-- AWS SES SMTP and SNS feedback
  +-- Sentry and structured logs
```

The production Compose model runs:

- `caddy` for HTTP/HTTPS routing
- `app` as the cron leader and warm fallback upstream
- `app_blue` and `app_green` as web-only blue/green slots
- `postgres` as the database
- `migrate` as an explicit Prisma migration runner

## Project Structure

```text
prisma/
  schema.prisma                 database schema
  migrations/                   deployable migration history
  seed.ts                       local/staging seed data
  demo-seed.ts                  destructive local-only showcase seed data
src/
  app/                          Next.js App Router pages and API routes
  components/                   shared UI and feature components
  config/                       club identity, module flags, and runtime config
  data/                         static public-page content
  lib/                          business logic, integrations, cron helpers
  types/                        project type augmentation
docs/                           public architecture and runbooks
scripts/                        deploy, migration, staging, and repair helpers
deploy/                         production proxy/runtime support files
```

Important route groups:

- `src/app/(public)` contains unauthenticated pages such as login, join, FAQ,
  contact, reset password, nomination, and public token flows.
- `src/app/(authenticated)` contains member dashboard, booking, profile, family,
  and booking-detail pages.
- `src/app/(admin)` contains administrative operations for members, member CSV
  import, bookings, bed allocation, payments, reports, lodge, Xero, audit logs,
  and policies.
- `src/app/api` contains route handlers for auth, bookings, payments, admin,
  finance, lodge, webhooks, cron, and health checks.

## Module Boundaries

This application is intentionally still a single Next.js monolith. The
important boundary is not process separation; it is keeping route handlers thin,
business rules testable, and integration code behind narrow helpers.

Use these ownership boundaries when adding new code:

| Area | Primary paths | Rule of thumb |
| --- | --- | --- |
| Club configuration | `config/`, `src/config/` | Club identity, capacities, rates, and feature switches must come from config or environment, not hard-coded deployment values. |
| Pages and route handlers | `src/app/` | Validate input and session state near the route boundary, then delegate decisions to `src/lib/`. |
| Route-private admin UI | `src/app/(admin)/admin/xero/_components`, `src/app/(admin)/admin/xero/_hooks`, `src/app/(admin)/admin/members/**/_components`, `src/app/(admin)/admin/members/**/_hooks` | Large admin routes should be route shells plus local components/hooks before moving anything to shared UI. |
| Shared UI | `src/components/` | Reusable view pieces live here; route-specific view state can stay beside the page until it is reused. |
| Booking lifecycle | `src/lib/booking-create.ts`, `src/lib/booking-modify.ts`, `src/lib/booking-payment-cleanup.ts`, `src/lib/payment-recovery.ts` | Keep route handlers thin; booking orchestration and durable payment recovery live behind these services. |
| Bed allocation | `src/lib/bed-allocation.ts`, `src/lib/bed-allocation-lifecycle.ts`, `src/lib/admin-bed-allocation.ts` | Room/bed inventory, family-aware allocation planning, lifecycle reconciliation, manual admin allocation, and approval state live behind focused services. |
| Policy rules | `src/lib/policies/` | Pricing, age-tier, cancellation, change-fee, minimum-stay, member-credit, and booking-route decisions live as testable policy helpers. |
| Operational Xero | `src/lib/xero-*.ts`, `src/lib/xero.ts` | `src/lib/xero.ts` is a compatibility facade. New code should import from the focused module that owns the behavior, not from the facade. |
| Admin/member services | `src/lib/admin-member-xero-actions.ts`, `src/lib/member-serialization.ts`, `src/lib/member-lifecycle-actions.ts`, `src/lib/membership-cancellation-*.ts` | Shared admin/member request wrappers, DTO shape, lifecycle actions, and cancellation workflows live outside page files. |
| Business logic | `src/lib/` | Keep money in integer cents, dates as New Zealand date-only lodge nights, and external calls outside long database transactions where practical. |
| Database | `prisma/schema.prisma`, `prisma/migrations/` | Schema changes must include deployable migrations and respect the blue/green migration policy. |
| Operations | `scripts/`, `deploy/`, Compose files | Deployment helpers should be reusable by forks through environment overrides. |

The largest current files are historical consolidation points rather than a
preferred style. When changing them, extract focused helpers around the code
being touched and keep tests close to the extracted domain helper so public
adopters can find the contract without reading the whole application.

### Xero integration layers

`src/lib/xero.ts` is a 199-line compatibility facade for older imports. Prefer
direct imports from the focused modules below for new code.

| Concern | Focused modules | Notes |
| --- | --- | --- |
| Infrastructure | `xero-oauth`, `xero-token-store`, `xero-api-client`, `xero-mappings`, `xero-sync-cursors` | OAuth, encrypted tokens, metered/retried API calls, mapping lookup, and sync cursors. |
| Contacts | `xero-contacts`, `xero-contact-cache`, `xero-contact-groups`, `xero-duplicate-contacts`, `xero-bulk-contact-sync`, `xero-member-import` | Contact CRUD, local caches, managed groups, duplicate suggestions, bulk sync, and member import. |
| Membership | `xero-membership-sync` | Subscription invoice discovery, status checks, history flushing, and linked-contact sync. |
| Invoice documents | `xero-invoice-helpers`, `xero-invoice-payments`, `xero-booking-invoices`, `xero-credit-notes`, `xero-supplementary-invoices`, `xero-modification-credit-notes`, `xero-entrance-fee-invoices` | Booking invoices, entrance-fee invoices, supplementary invoices, payments, refunds, credit notes, and allocation helpers. |
| Operations and admin support | `xero-sync`, `xero-operation-outbox`, `xero-operation-retry`, `xero-operation-queue`, `xero-record-activity`, `xero-record-links`, `xero-hardening`, `xero-inbound-reconciliation`, `xero-booking-repair`, `xero-contact-link-mismatches`, `xero-contact-sync`, `xero-booking-edit-settlement`, `xero-admin-cache`, `xero-admin-failures`, `xero-admin-health`, `xero-api-usage`, `xero-api-errors`, `xero-config`, `xero-error-alert`, `xero-error-shape`, `xero-feature-flags`, `xero-links`, `xero-oauth-state`, `xero-record-types` | Existing boundaries for queues, reconciliation, repair tooling, admin health, diagnostics, config, links, and error handling. |

### Booking lifecycle boundary

`src/lib/booking-create.ts` owns booking creation orchestration after route
validation: capacity locking, pricing, promo/member-credit decisions,
persistence, audit, emails, and Xero queueing. `src/lib/booking-modify.ts` owns
the modification boundary for date/guest/promo changes and delegates reusable
decisions to helpers and `src/lib/policies/`.

`src/lib/booking-payment-cleanup.ts` queues superseded Stripe PaymentIntents
when booking edits replace or zero out pending payment work.
`src/lib/payment-recovery.ts` is the durable recovery queue that cancels open
intents, treats already-cancelled intents as complete, and refunds late
captures without re-entering the normal booking-confirmation path.

### Admin/member layer

`/admin/stuck-states` is the consolidated operator queue for cross-domain
recovery visibility. `src/lib/stuck-state-dashboard.ts` aggregates local
payment recovery, operational Xero, email deliverability, waitlist,
bed-allocation, hut-leader, and issue-report signals into severity, owner, and
target links without making live provider calls during page render.

The `/admin/xero` and `/admin/members` routes are route shells with local
`_components` and `_hooks` folders. Shared admin/member logic lives in
`src/lib/`: `admin-member-xero-actions` wraps the Xero contact actions used by
both the members list and detail page, `member-serialization` centralises DTO
shape, `member-lifecycle-actions` owns archive/delete request handling, and
`membership-cancellation-*` owns the cancellation request, confirmation,
approval, Xero, settings, and status-label flow.

## Core Data Model

The source of truth is `prisma/schema.prisma`. Key domains are:

- Members, family groups, dependent relationships, nominations, membership
  cancellation requests, setup invites, password/email tokens, notification
  preferences, deletion requests, and audit logs.
- Seasons, season rates, booking periods, minimum-stay policies, group
  discounts, age-tier settings, promo codes, fixed-nightly promo adjustments,
  and promo redemptions.
- Bookings, guests, payments, refunds, booking modifications, waitlist offers,
  account-credit ledger entries, chores, hut-leader assignments, lodge PIN
  sessions, and issue reports.
- Lodge rooms, lodge beds, bed allocations, allocation settings, and allocation
  approval metadata.
- Operational Xero tokens, object links, cache tables, inbound events,
  operation queues, account/item mappings, and API usage metering.
- Finance sync runs, finance snapshots, chart-of-accounts snapshots, finance
  report diagnostics, and finance access levels, all using the operational Xero
  connection rather than a separate finance token store.
- Cron run records, email logs, webhook logs, processed webhook events, and
  backup/audit-retention support records.

## Booking and Payment Flow

1. A member selects check-in and check-out dates.
2. Capacity is calculated as lodge beds minus capacity-holding guests per
   night. Only bookings with money committed hold beds: `PAID`, `COMPLETED`,
   `CONFIRMED` (pay-on-account school groups), and `AWAITING_REVIEW` (a bed is
   reserved while an admin decides). `PENDING` does not hold capacity; it is a
   provisional non-member hold. The single source of truth is
   `CAPACITY_HOLDING_BOOKING_STATUSES` in `src/lib/booking-status.ts`.
3. Minimum-stay, booking-window, age-tier, membership, group-discount, fixed or
   percentage promo, and account-credit rules are applied.
4. If all guests are members, or check-in is within the non-member hold window,
   the booking can proceed to payment immediately.
5. If non-members are included outside the hold window, a card can be saved and
   the booking remains pending until the hold date.
6. `BookingGuest.stayStart` and `BookingGuest.stayEnd` record the actual
   date-only range for each guest inside the parent booking envelope. Capacity,
   lodge lists, rosters, and booking-derived finance metrics count a guest only
   on nights in that individual range.
7. Capacity-sensitive writes use a PostgreSQL advisory transaction lock so
   overlapping booking decisions serialize at the current lodge scale.
   Member lifecycle approval (delete / archive) acquires
   `pg_advisory_xact_lock(hashtext('member-lifecycle:<memberId>'))` inside
   the transaction. Future approve / reject paths that recount eligibility
   then mutate the member graph should follow the same idiom so a parallel
   write cannot race the re-check.
8. Payment state records an explicit source. Stripe payments stay on Stripe
   PaymentIntent, refund, and recovery paths; Internet Banking payments issue a
   Xero invoice and settle through inbound Xero reconciliation. By default,
   Internet Banking bookings do not hold capacity until reconciliation performs
   the final capacity claim. Admin settings can opt into bed-slot holding for a
   bounded number of days, in which case the booking is `CONFIRMED` while the
   Xero invoice remains unpaid.
9. Bed allocations reconcile when bookings are confirmed, modified, waitlist
   confirmed, force-confirmed, cancelled, completed, or deleted. Automatic
   allocation can fill missing guest nights from active room/bed inventory, and
   admins can manually move or approve allocations.

In-progress member self-service edits are limited to future unused nights from
NZ tomorrow onward. NZ today and earlier are locked for admin review through
booking change requests. Positive booking-edit deltas use supplementary Xero
invoices after additional Stripe payment succeeds, while negative deltas use a
settlement choice: Stripe refund work where applicable or an idempotent
source-linked member account credit. Both avoid unsafe financial mutation of a
paid, part-paid, credited, or locked original invoice.

Money values are integer cents. Booking dates are New Zealand date-only lodge
nights rather than timestamps.

## Booking Statuses

Common booking states include:

- `DRAFT` for unconfirmed drafts with a time-to-live
- `PENDING` for non-member hold bookings
- `CONFIRMED` and `PAID` for accepted bookings
- `WAITLISTED` and `WAITLIST_OFFERED` for capacity waitlist flows
- `BUMPED`, `CANCELLED`, and `COMPLETED` for lifecycle transitions

Waitlisted and offered bookings do not consume capacity until confirmed.
Completed bookings continue to consume capacity for their remaining stay nights.
Admins can soft-delete cancelled bookings to hide operational duplicates while
preserving the booking row, audit snapshot, guests, events, and modification
history. Soft-delete remains blocked when captured/refunded/credited payment,
refund, member-credit, payment-recovery, or Xero history exists. Internal
booking modifications do not block this cleanup when their net cent effect is
zero and no external financial or Xero history exists.

## Admin and Lodge

Admin pages cover member management, member CSV import, bookings, operational
booking filters, bed allocation, payments, seasons, policies, refund requests,
promo codes, communications, health, audit logs, reports, Xero operations and
inbound-event drilldowns, committee data, issue reports, waitlist, lodge
operations, hut leaders, and roster/chores. Lodge settings are a singleton
record for lodge-wide operational defaults such as fallback capacity and the
hut-leader lookahead window used by dashboard and Needs Attention warnings.

Member CSV import allows distinct identities to share an email address while
preserving the database invariant that only one member per email can have
`canLogin: true`. Duplicate detection uses normalized email plus first and last
name, and setup invites are sent only to imported members that can log in.
Member, dependent, profile, onboarding, and application address forms submit a
`postalSameAsPhysical` flag; route handlers copy physical address fields into
postal fields before persistence when that flag is true.
Address autocomplete is an optional Addy-backed public proxy module. It defaults
off, is gated by Admin Modules and `src/proxy.ts` before route handlers run, and
never replaces manual address entry.

Access roles live in `MemberAccessRole` and are the normalized login/permission
axis: `USER`, `ADMIN`, `LODGE`, `FINANCE_USER`, `FINANCE_ADMIN`, and `ORG`.
`Member.role` remains a synchronized compatibility/classification field with
`USER`, `ADMIN`, `LODGE`, `NON_MEMBER`, and `SCHOOL`; Associate, Life, and
club-created categories are membership types, not role enum values.
`Member.financeAccessLevel` remains synchronized for compatibility visibility,
but runtime finance guards ignore it. Non-login records simply have no
access-role rows. The canonical access-role constants and compatibility helpers
live in `src/lib/access-roles.ts`; compatibility role constants stay in
`src/lib/member-roles.ts` for old imports, membership classification, and
provider-created non-member records.

Seasonal membership types are policy records, not access roles. `MembershipType`
stores the stable identifier, display text, active/archive state, sort order,
booking behavior, subscription behavior, allowed age tiers, and optional Xero
contact-group rules for built-in and admin-defined types. The built-ins are
Full, Associate, Life, School, Non-Member, and Family; Associate is the single
Associate/Reserve-style built-in and can be renamed by the club. Age tiers stay
separate because the same tier can appear under several membership types. Age
Tier Xero groups are for broad age cohorts, Membership Type Xero groups are for
status or policy labels, and clubs can configure both when Xero needs both
labels.
`SeasonalMembershipAssignment` records a member's type for a membership
`seasonYear`, assignment source, and optional date-only `applyFrom` changeover.
The initial backfill maps existing legacy roles to current-season assignments.
Admin changes to an individual member's seasonal type go through a preview that
reports affected future confirmed bookings, draft bookings, waitlist records,
current subscription state, and recent subscription history, then require an
admin reason before the audited save. The membership-type settings page can roll
assignments forward from one season to another idempotently, skipping existing
target-season assignments and reporting missing or inactive-type exceptions.
The Admin > Members list shows the current seasonal Membership Type beside the
Access column so operators can scan access and membership policy separately.
Booking pricing and booking gates resolve the member's effective seasonal type
for the booking season:
`MEMBER_RATE` uses normal member rates, `NON_MEMBER_RATE` uses non-member
nightly rates while preserving member identity, and `BLOCK_BOOKING` returns a
structured policy error before the booking is created or repriced. Subscription
displays and booking lockout also resolve the seasonal type: `NOT_REQUIRED` is
an effective status layered over the raw `MemberSubscription`/Xero history,
which remains stored and visible for audit. Seasonal type changes do not
automatically reprice existing future bookings. Committee assignments remain
separate public/contact metadata. `CommitteeRole` stores reusable master positions
and their role email aliases, and `CommitteeAssignment` links members to those
positions with blurb, sort order, published, show-phone, contactable, and active
flags. The public committee API reads only active, published assignments with
active roles, never selects member email, returns phone only when show-phone is
enabled, and exposes contact keys only for contactable assignments. The contact
form resolves those assignment keys server-side to the role email alias or falls
back to the club contact address; it does not deliver committee mail to the
linked member's private email address. Committee contact email delivery stores
an opaque committee-contact marker in EmailLog instead of the recipient address.

Membership cancellation is a member-initiated account lifecycle workflow.
Requests can include the requester, dependants, non-login adults, and related
family adults. Login-capable adults receive their own confirmation link before
admin review. Admin approval disables the local membership, clears operational
family/email-inheritance links, preserves financial and lodge history, and
queues Xero cancellation operations.

Cancelled members can be archived through `MemberLifecycleActionRequest` with
the `ARCHIVE` action. Archive requires a reason and approval by a different
admin through the `/admin/membership-cancellations` review queue. Approval keeps
the member record and related history but marks it archived, inactive, and
non-login so default operational lists exclude it.

Member records created in error use `MemberLifecycleActionRequest` with the
`DELETE` action. A delete request requires a reason, approval by a different
admin, a clean eligibility check with no booking, financial, family, Xero, or
membership history blockers, and a retained member snapshot before hard
deletion. Direct `DELETE /api/admin/members/[id]` is intentionally disabled.

The lodge kiosk has its own PIN session model and permission tiers for
view-only, guest, hut-leader, and admin-style lodge actions. It supports guest
arrival/departure, expected arrival times, chores, and issue reporting without
exposing the full admin interface.

## Integrations

### Stripe

Stripe is used for PaymentIntents, SetupIntents, saved payment methods, refunds,
and webhook reconciliation. Webhook routes should be idempotent and must not
trust client-supplied payment state. Internet Banking payments are explicitly
excluded from Stripe-only PaymentIntent, refund, and recovery paths.

Superseded Stripe PaymentIntents that can no longer settle a booking are tracked
through `PaymentRecoveryOperation`. The recovery worker cancels still-open
intents, treats already-cancelled intents as complete, and queues/refunds late
captures without running the normal booking-confirmation path.

### Operational Xero

Operational Xero handles member/contact sync, booking invoices, payments,
credit notes, item codes, contact groups, inbound webhooks, local caches, retry
queues, and usage metering. Xero tokens are encrypted at rest.
OAuth token refresh uses a short database-backed lease on the operational
token row so multiple app workers cannot use the same rotating refresh token.
Internet Banking bookings use this boundary to issue invoice-backed payment
instructions and reconcile settlement from inbound Xero invoice/payment state.
Unheld Internet Banking reconciliation performs the final capacity claim before
marking a booking paid. If the paid booking no longer fits, the payment is
recorded as succeeded, the booking is cancelled, member account credit is
created for the paid amount, Xero account-credit work is queued, admins are
alerted, and waitlists are processed. Held Internet Banking bookings are
released by the payment cron when their hold expiry passes unpaid; the release
cancels the booking, fails the pending payment, queues invoice-clearing
credit-note work, emails the member, records history/audit, and processes
waitlists.

### Finance reporting

Finance reporting uses the same operational Xero connection that booking,
payment, and membership flows use. The finance sync service reads reports,
invoice datasets, bank balances, and chart-of-accounts snapshots through that
connection, then stores `FinanceSnapshot` and `FinanceSyncRun` rows for page
rendering. There is no separate finance Xero OAuth app, token store, callback
route, or usage-metering table.

### Address autocomplete

Address autocomplete uses server-side Addy credentials only in
`src/lib/addy-api.ts`. Browser code talks to `/api/address-autocomplete/**`,
which is feature-gated by the `addressAutocomplete` Admin Module and rate
limited. Missing credentials and upstream failures return small error payloads;
address forms keep manual inputs editable so saving an address does not depend
on Addy availability.

### Email

AWS SES SMTP sends transactional email. SES SNS feedback is ingested for bounce
and complaint suppression. Email templates should avoid embedding secrets and
should use effective recipient logic for dependents where required. Editable
templates and admin/system delivery policies are registered in the email
message registry and surfaced in Admin Setup and Admin Notifications.
If an admin/system alert cannot be delivered to any opted-in admin recipient
because every send is suppressed or fails, the app records a critical
communication audit event and surfaces it in Admin Email Deliverability.
Failed token-bearing lifecycle emails for nomination requests, member setup
invites, and membership cancellation confirmations are not auto-retried because
their HTML is redacted; Admin Email Deliverability exposes a reissue action that
creates a fresh token and resends the lifecycle email after any active
suppression has been cleared.
Nomination request links also have workflow-level recovery: expired unconfirmed
links are renewed by the `nomination-reminders` cron weekly for four automatic
reminders, and admins can refresh or replace unconfirmed nominators from the
member-applications queue.
Membership cancellation, archive, and hard-delete lifecycle messages use that
registry so operators can preview and override copy without bypassing the
shared `sendEmail` path.

## Cron Jobs

Cron jobs run inside the `app` cron-leader container. Web-only blue/green slots
disable cron with `CRON_ENABLED=false`.

| Job | Schedule | Purpose |
| --- | --- | --- |
| `confirm-pending` | Every 3 hours | Confirm pending bookings after hold deadlines |
| `pre-arrival-reminders` | Every 3 hours | Send current directions and door-code reminders before check-in |
| `purge-booking-requests` | Every 3 hours | Delete expired declined and never-verified public booking requests after the retention window |
| `quote-expiry-reminders` | Every 3 hours | Remind public booking-request quote recipients before their quote link expires (sends a fresh working link) |
| `payment-recovery` | Every 15 minutes | Cancel or refund superseded Stripe PaymentIntents |
| `waitlist-processor` | Every 30 minutes | Expire offers and advance waitlist |
| `email-retry` | Every 30 minutes | Retry failed email sends |
| `xero-outbox` | Every 15 minutes | Process queued Xero outbox operations |
| `xero-operation-replay` | Every 15 minutes | Replay queued Xero retries |
| `xero-inbound-reconcile` | Every 15 minutes | Process inbound Xero events |
| `complete-bookings` | Daily | Mark past bookings completed |
| `xero-membership-refresh` | Daily when enabled | Sync membership invoice state |
| `xero-link-backfill` | Daily | Backfill canonical Xero object links into the ledger |
| `xero-link-cleanup` | Daily | Clean stale canonical Xero object links |
| `xero-reconciliation-report` | Daily | Send the Xero reconciliation report |
| `data-pruning` | Daily | Prune expired tokens/logs and run audit retention |
| `draft-cleanup` | Daily | Delete expired draft bookings |
| `pending-deadline-alerts` | Daily | Alert admins about pending bookings approaching deadline |
| `credit-reconciliation` | Daily | Reconcile account-credit ledger state and alert on refunded Stripe payments missing Xero credit notes |
| `hut-leader-auto-assign` | Daily | Suggest hut leaders |
| `age-up` | Daily | Process age-tier/member transitions |
| `capacity-warnings` | Daily | Alert when lodge occupancy approaches limits |
| `admin-digest` | Daily | Send admin summary email |
| `nomination-reminders` | Daily | Renew expired unconfirmed nomination links weekly, up to four automatic reminders |
| `checkin-reminders` | Daily | Send next-day check-in reminders |
| `backup` | Configurable | Upload PostgreSQL dumps to S3 |

## Security and Privacy Boundaries

- Auth uses credentials sessions with explicit admin and finance guards.
- Finance access is separate from general admin access.
- Public bearer tokens are stored hashed or encrypted according to use case.
- Logs, Sentry events, and webhook records should be redacted before storing or
  emitting sensitive values.
- Mutation routes should validate inputs with structured schemas and enforce
  role/session checks close to the route boundary.
- External service callbacks and webhooks must verify signatures, state, or
  expected origin data before mutating local state.

## Deployment and Migrations

Production deployment uses the blue/green runner documented in `DEPLOYMENT.md`.
Database migrations must follow `docs/BLUE_GREEN_MIGRATION_POLICY.md` so old
and new app versions can overlap safely during cutover.

Staging and accessibility checks use `docker-compose.staging.yml`,
`Caddyfile.staging`, `.env.staging.example`, and the workflow in
`docs/STAGING_ACCESSIBILITY.md`.

## Configuration

The environment contract is documented in `.env.example` and
`.env.staging.example`. Use test or demo service credentials outside production.
Do not commit real `.env`, database dumps, generated reports, logs, or build
artifacts.
