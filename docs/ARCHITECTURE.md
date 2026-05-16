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
src/
  app/                          Next.js App Router pages and API routes
  components/                   shared UI and feature components
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
- `src/app/(admin)` contains administrative operations for members, bookings,
  payments, reports, lodge, Xero, audit logs, and policies.
- `src/app/api` contains route handlers for auth, bookings, payments, admin,
  finance, lodge, webhooks, cron, and health checks.

## Core Data Model

The source of truth is `prisma/schema.prisma`. Key domains are:

- Members, family groups, dependent relationships, nominations, setup invites,
  password/email tokens, notification preferences, deletion requests, and audit
  logs.
- Seasons, season rates, booking periods, minimum-stay policies, group
  discounts, age-tier settings, promo codes, and promo redemptions.
- Bookings, guests, payments, refunds, booking modifications, waitlist offers,
  account-credit ledger entries, chores, hut-leader assignments, lodge PIN
  sessions, and issue reports.
- Operational Xero tokens, object links, cache tables, inbound events,
  operation queues, account/item mappings, and API usage metering.
- Finance Xero tokens, finance sync runs, finance snapshots, finance usage
  metering, and finance access levels.
- Cron run records, email logs, webhook logs, processed webhook events, and
  backup/audit-retention support records.

## Booking and Payment Flow

1. A member selects check-in and check-out dates.
2. Capacity is calculated as lodge beds minus confirmed/paid guests per night.
3. Minimum-stay, booking-window, age-tier, membership, group-discount, promo,
   and account-credit rules are applied.
4. If all guests are members, or check-in is within the non-member hold window,
   the booking can proceed to payment immediately.
5. If non-members are included outside the hold window, a card can be saved and
   the booking remains pending until the hold date.
6. Capacity-sensitive writes use a PostgreSQL advisory transaction lock so
   overlapping booking decisions serialize at the current lodge scale.
7. Stripe records payment state; Xero operations are queued or performed through
   durable integration helpers and linked back to local records.

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

## Admin and Lodge

Admin pages cover member management, bookings, payments, seasons, policies,
refund requests, promo codes, communications, health, audit logs, reports,
Xero, committee data, issue reports, waitlist, lodge operations, hut leaders,
and roster/chores.

The lodge kiosk has its own PIN session model and permission tiers for
view-only, guest, hut-leader, and admin-style lodge actions. It supports guest
arrival/departure, expected arrival times, chores, and issue reporting without
exposing the full admin interface.

## Integrations

### Stripe

Stripe is used for PaymentIntents, SetupIntents, saved payment methods, refunds,
and webhook reconciliation. Webhook routes should be idempotent and must not
trust client-supplied payment state.

### Operational Xero

Operational Xero handles member/contact sync, booking invoices, payments,
credit notes, item codes, contact groups, inbound webhooks, local caches, retry
queues, and usage metering. Xero tokens are encrypted at rest.

### Finance Xero

Finance Xero is a separate OAuth boundary with separate token storage,
encryption keys, tenant linkage, callback route, usage metering, and sync
service. Finance pages normally read stored snapshots or first-party booking
data rather than calling Xero during page render.

### Email

AWS SES SMTP sends transactional email. SES SNS feedback is ingested for bounce
and complaint suppression. Email templates should avoid embedding secrets and
should use effective recipient logic for dependents where required.

## Cron Jobs

Cron jobs run inside the `app` cron-leader container. Web-only blue/green slots
disable cron with `CRON_ENABLED=false`.

| Job | Schedule | Purpose |
| --- | --- | --- |
| `confirm-pending` | Every 3 hours | Confirm pending bookings after hold deadlines |
| `waitlist` | Every 30 minutes | Expire offers and advance waitlist |
| `email-retry` | Every 30 minutes | Retry failed email sends |
| `xero-retry` | Every 15 minutes | Process queued Xero operations |
| `xero-reconcile` | Every 15 minutes | Process inbound Xero events |
| `complete-bookings` | Daily | Mark past bookings completed |
| `xero-membership` | Daily | Sync membership invoice state |
| `data-pruning` | Daily | Prune expired tokens/logs and run audit retention |
| `draft-cleanup` | Daily | Delete expired draft bookings |
| `credit-reconciliation` | Daily | Reconcile account-credit ledger state |
| `hut-leader-auto-assign` | Daily | Suggest hut leaders |
| `age-up` | Daily | Process age-tier/member transitions |
| `capacity-warnings` | Daily | Alert when lodge occupancy approaches limits |
| `admin-digest` | Daily | Send admin summary email |
| `checkin-reminders` | Daily | Send pre-arrival reminders |
| `feedback-requests` | Daily | Send post-stay feedback requests |
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
