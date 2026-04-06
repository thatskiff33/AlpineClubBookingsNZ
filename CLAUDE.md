# TACBookings

## How to Run

```bash
npm install
npx prisma generate
npm test              # 411 tests pass (21 test files)
npm run build         # builds successfully
npm run dev           # development server

# Docker deployment:
docker compose up -d --build
docker compose run --rm migrate    # run database migrations

# Seed database (requires running PostgreSQL):
npx prisma migrate dev --name initial
npm run db:seed
```

**Test accounts (from seed):**
- Admin: admin@tac.org.nz / admin123
- Member: member@tac.org.nz / member123

**Note:** nodemailer pinned to v7 for next-auth peer dep compatibility

## Current State

All 9 build phases + Delivery Phases 1, 4, 5, 6, 9 complete. Security audit + 5 integration reviews done. 411 tests pass, build succeeds.

**What works today:**
- Auth: login, register, password reset, JWT sessions (8h expiry), admin role guard, email verification on registration, email change with verification
- Booking: availability calendar, booking wizard, guest forms, pricing engine, advisory lock concurrency
- Payments: Stripe PaymentIntents (confirmed), SetupIntents (pending), webhook handler, policy-based refunds
- Non-member flow: PENDING status, 7-day hold, cron auto-confirm, FIFO bumping algorithm
- Xero: OAuth2 connect, encrypted tokens, invoice creation, credit notes, contact sync, membership verification, daily cron
- Promo codes: PERCENTAGE/FIXED_AMOUNT/FREE_NIGHTS types, validation, redemption tracking, admin CRUD
- Chore roster: round-robin allocator, admin review/edit, printable A4 view, email notifications
- Admin: seasons CRUD, cancellation policy, members list, bookings with filters, reports dashboard (recharts)
- Infrastructure: security headers (CSP, HSTS), rate limiting, audit logging, automated pg_dump backups, error pages
- Cancellation: shared service in `src/lib/booking-cancel.ts`, both routes delegate to it
- Logging: structured JSON logging via pino (`src/lib/logger.ts`), LOG_LEVEL env var
- Health: `GET /api/health` checks DB, Stripe, Xero, SMTP with latency and status
- Cron tracking: `CronJobRun` model records execution metadata, auto-prunes after 90 days
- Schema: `BookingModification` model, `Payment.changeFeeCents` field (for future booking mods)
- Refunds: `getRefundTier()` extracted from cancellation logic with full test coverage
- Docker: log rotation (json-file, 10m x 5) on all services
- Sentry: server-side + client-side error tracking, cron monitoring, performance tracing
- Observability: API request logging middleware, webhook delivery monitoring (`WebhookLog`), admin health dashboard
- Notifications: EmailLog tracking, check-in reminders, admin alerts (new booking, payment failure, pending deadline, bumped, Xero errors, capacity warnings), notification preferences, email retry with backoff, admin daily digest, bulk member communication (rate-limited, preference-gated), post-stay feedback requests

### Delivery Phase 1: Foundational Infrastructure - COMPLETED

**Date:** 2026-04-05
**Branch:** phase-1-infra
**Tests:** 312 (was 292, +20 new)

**Features built:**
1. **CAN-01**: Shared cancellation service (`src/lib/booking-cancel.ts`) - both cancel routes delegate
2. **CAN-02**: CancelBookingButton uses path-based route, body-based route logs deprecation
3. **SCH-01**: `BookingModification` Prisma model with indexes
4. **SCH-02**: `Payment.changeFeeCents` field (default 0)
5. **FEE-01**: `getRefundTier()` extracted from cancellation.ts, 12 new tests
6. **OBS-04**: Structured pino logger, all ~85 console.* calls replaced in src/lib/ and src/app/api/
7. **OBS-06**: `GET /api/health` endpoint with DB/Stripe/Xero/SMTP checks, 8 new tests
8. **OBS-09**: `CronJobRun` model, instrumentation.ts persists run metadata, 90-day auto-prune
9. **OBS-13**: Docker Compose log rotation (json-file, max-size 10m, max-file 5) on all 3 services

**New files:**
- `src/lib/booking-cancel.ts` - Shared cancellation service
- `src/lib/logger.ts` - Pino structured logger
- `src/app/api/health/route.ts` - Health check endpoint
- `src/lib/__tests__/health.test.ts` - Health endpoint tests

**New Prisma models (require migration):**
- `BookingModification` - Booking change history with before/after snapshots
- `CronJobRun` - Cron execution tracking

**New env vars:**
- `LOG_LEVEL` - Logging level (default: info in production, debug in development)


### Delivery Phase 4: Admin Operations & Tooling - COMPLETED

**Date:** 2026-04-06
**Branch:** phase-4-admin-ops
**Tests:** 327 (was 312, +15 new)

**Features built:**
1. **Subscription Tracking**: GET /api/admin/subscriptions with season year selector, status filter, pagination, summary counts. Admin page with summary cards and filterable table.
2. **Payments List**: GET /api/admin/payments with status/date range filters, pagination, revenue aggregates. Admin page with summary cards and table with copyable Stripe PI IDs.
3. **Audit Log Viewer**: GET /api/admin/audit-log with action/actor/date filters, pagination, distinct action list. Admin page with expandable detail rows showing formatted JSON.
4. **Report Export**: CSV download button generates tac-report-YYYY-MM-DD.csv. PDF print button with @media print stylesheet hides sidebar/nav/filters, sizes charts to A4.
5. **Sidebar Nav**: Added Subscriptions, Payments, Audit Log entries to admin sidebar.

**New files:**
- src/app/api/admin/subscriptions/route.ts - Subscription tracking API
- src/app/api/admin/payments/route.ts - Payments list API
- src/app/api/admin/audit-log/route.ts - Audit log API
- src/app/(admin)/admin/subscriptions/page.tsx - Subscriptions admin page
- src/app/(admin)/admin/payments/page.tsx - Payments admin page
- src/app/(admin)/admin/audit-log/page.tsx - Audit log admin page
- src/lib/__tests__/admin-api.test.ts - 15 tests for all 3 new APIs

**Modified files:**
- src/components/admin-sidebar.tsx - Added 3 new nav entries
- src/app/(admin)/admin/reports/page.tsx - Added CSV/PDF export buttons
- src/app/globals.css - Added @media print styles
### Delivery Phase 5: Member Auth Enhancements - COMPLETED

**Date:** 2026-04-06
**Branch:** phase-5-auth
**Tests:** 342 (was 327, +15 new)

**Features built:**
1. **B3 - Email Verification on Registration**: `emailVerified` field on Member (default false), `EmailVerificationToken` model (24h expiry, crypto.randomBytes), registration sends verification email, `GET /api/auth/verify-email` validates token and sets emailVerified=true, `POST /api/auth/resend-verification` (rate-limited 3/hr), unverified members blocked from login (EMAIL_NOT_VERIFIED error), login page shows verification prompt with resend button, booking creation gated on emailVerified (403), existing members grandfathered via SQL comment.
2. **B2 - Email Change with Verification**: `EmailChangeToken` model (1h expiry), `POST /api/auth/request-email-change` validates new email/sends verification to new address/notification to old, `GET /api/auth/confirm-email-change` updates email/deletes token/updates Xero contact (fire-and-forget), ChangeEmailForm on profile page, audit log entries for request and confirmation, rate-limited 3/hr.

**New files:**
- `src/lib/verification-tokens.ts` - Token generation (crypto.randomBytes) and creation helpers
- `src/app/api/auth/verify-email/route.ts` - Email verification endpoint
- `src/app/api/auth/resend-verification/route.ts` - Resend verification endpoint
- `src/app/api/auth/request-email-change/route.ts` - Request email change endpoint
- `src/app/api/auth/confirm-email-change/route.ts` - Confirm email change endpoint
- `src/app/(public)/verify-email/page.tsx` - Verify email page
- `src/app/(public)/confirm-email-change/page.tsx` - Confirm email change page
- `src/app/(authenticated)/profile/change-email-form.tsx` - Change email form component
- `src/lib/__tests__/email-verification.test.ts` - 15 tests for verification flows

**New Prisma models (require migration):**
- `EmailVerificationToken` - Email verification tokens with 24h expiry
- `EmailChangeToken` - Email change tokens with 1h expiry

**Modified files:**
- `prisma/schema.prisma` - Added emailVerified field, EmailVerificationToken, EmailChangeToken models
- `src/lib/auth.ts` - Added isEmailVerified to session, block unverified login
- `src/lib/email.ts` - Added verification/change email sending functions
- `src/lib/email-templates.ts` - Added 3 new email templates
- `src/lib/rate-limit.ts` - Added resendVerification and requestEmailChange limiters
- `src/app/api/auth/register/route.ts` - Send verification email on registration
- `src/app/api/bookings/route.ts` - Gate booking on emailVerified
- `src/app/(public)/login/page.tsx` - Handle EMAIL_NOT_VERIFIED, show resend button
- `src/app/(authenticated)/profile/page.tsx` - Added ChangeEmailForm section

### Delivery Phase 9: Observability - COMPLETED

**Date:** 2026-04-06
**Branch:** phase-9-observability
**Tests:** 359 (was 342, +17 new)

**Features built:**
1. **OBS-01**: Sentry server-side integration (`@sentry/nextjs`), `sentry.server.config.ts` with sensitive data scrubbing (`beforeSend`), source map support
2. **OBS-02**: Sentry client-side error boundaries - `error.tsx` and `global-error.tsx` call `Sentry.captureException()` with digest tag correlation, breadcrumbs enabled
3. **OBS-03**: Sentry cron monitoring for 3 jobs (`confirm-pending-bookings`, `xero-membership-refresh`, `database-backup`) with check-in/check-out signals and schedule config
4. **OBS-05**: API request logging middleware (`src/lib/api-logger.ts`) - `withRequestLogging()` wrapper logs method, path, status, durationMs, IP at appropriate log levels
5. **OBS-08**: `WebhookLog` Prisma model for webhook delivery monitoring, `recordWebhookLog()` + `getWebhookStats()` helpers, Stripe and Xero handlers instrumented, 30-day auto-prune
6. **OBS-10**: Sentry performance tracing (0.2 sample rate in production, 1.0 in development)
7. **OBS-11**: Sentry alerting rules documented in `docs/SENTRY_ALERTS.md` (4 alert rules with triage steps)
8. **OBS-12**: External uptime monitoring config in `docs/UPTIME_MONITORING.md` (UptimeRobot, Sentry Uptime, Route 53 options)
9. **OBS-07**: Admin health dashboard `/admin/health` with service checks, cron job history, webhook stats, system info, Sentry link, auto-refresh every 60s

**New files:**
- `sentry.server.config.ts` - Sentry server-side initialization
- `sentry.client.config.ts` - Sentry client-side initialization
- `sentry.edge.config.ts` - Sentry edge runtime initialization
- `src/lib/api-logger.ts` - API request logging middleware
- `src/lib/webhook-log.ts` - Webhook delivery monitoring helpers
- `src/app/api/admin/health/route.ts` - Admin health data API
- `src/app/(admin)/admin/health/page.tsx` - Admin health dashboard page
- `src/lib/__tests__/observability.test.ts` - 17 tests for observability features
- `docs/SENTRY_ALERTS.md` - Sentry alerting rules documentation
- `docs/UPTIME_MONITORING.md` - External uptime monitoring documentation

**New Prisma models (require migration):**
- `WebhookLog` - Webhook delivery tracking with source, eventType, status, duration

**New env vars:**
- `SENTRY_DSN` - Sentry DSN for server-side error tracking
- `NEXT_PUBLIC_SENTRY_DSN` - Sentry DSN for client-side error tracking
- `SENTRY_ORG` - Sentry organization slug (for source map uploads)
- `SENTRY_PROJECT` - Sentry project slug (for source map uploads)
- `SENTRY_AUTH_TOKEN` - Sentry auth token (for source map uploads during build)

**Modified files:**
- `next.config.ts` - Wrapped with `withSentryConfig`
- `src/instrumentation.ts` - Added Sentry init + cron monitoring
- `src/app/error.tsx` - Added Sentry error capture
- `src/app/global-error.tsx` - Added Sentry error capture
- `src/middleware.ts` - Added Sentry ingest to CSP connect-src
- `src/app/api/webhooks/stripe/route.ts` - Added webhook logging
- `src/app/api/webhooks/xero/route.ts` - Added webhook logging
- `src/components/admin-sidebar.tsx` - Added System Health nav entry
- `prisma/schema.prisma` - Added WebhookLog model
- `.env.example` - Added Sentry env vars

### Delivery Phase 6: Notifications - COMPLETED

**Date:** 2026-04-06
**Branch:** phase-6-notifications
**Tests:** 411 (was 359, +52 new across 3 sub-phases)

**Sub-phase 6a: Core Alerts**
1. **N-10**: EmailLog Prisma model with delivery tracking (QUEUED/SENT/FAILED/BOUNCED), htmlBody for retry, integrated into sendEmail()
2. **N-01**: Check-in reminder cron (daily 9AM NZST), queries CONFIRMED bookings with checkIn=tomorrow, includes guest list and chore assignments
3. **N-02**: Admin alert on new booking creation (fire-and-forget to all admins)
4. **N-04**: Admin alert on payment failure (Stripe webhook + charge-saved-method failures)
5. **N-06**: Pending deadline alert cron (daily 8AM NZST), digest of PENDING bookings within 48h of nonMemberHoldUntil
6. **N-07**: Admin alert when booking bumped, includes triggering member info

**Sub-phase 6b: Preference-Gated Features**
7. **N-03**: Capacity warning cron (daily 7AM NZST), alerts when any of next 14 days has <=5 beds remaining
8. **N-05**: Xero sync error alerts with 1-hour deduplication via EmailLog check
9. **N-08**: NotificationPreference model (per-member toggles), GET/PUT API, profile page UI with toggle switches, shouldSendEmail() helper
10. **N-11**: Email retry cron (every 30min), retries FAILED emails up to 3 attempts using stored htmlBody
11. **N-13**: Admin daily digest cron (daily 7:30AM NZST), summarizes past 24h alerts by type with counts

**Sub-phase 6c: Advanced Communication**
12. **N-09**: Bulk member communication - admin-only POST endpoint, rate limited 1/hr, respects marketingEmails preference, HTML/header injection prevention (escapeHtml + newline stripping), compose UI, send history via audit log
13. **N-12**: Post-stay feedback request cron (daily 10AM NZST), queries CONFIRMED/COMPLETED bookings where checkOut=yesterday, respects bookingReminder preference

**New files:**
- `src/lib/cron-checkin-reminders.ts` - Check-in reminder cron logic
- `src/lib/cron-pending-deadline-alerts.ts` - Pending deadline alert cron
- `src/lib/cron-capacity-warnings.ts` - Capacity warning cron
- `src/lib/cron-email-retry.ts` - Email retry with backoff cron
- `src/lib/cron-admin-digest.ts` - Admin daily digest cron
- `src/lib/cron-feedback-requests.ts` - Post-stay feedback request cron
- `src/lib/xero-error-alert.ts` - Xero sync error alert with deduplication
- `src/app/api/notifications/preferences/route.ts` - Notification preferences API
- `src/app/api/admin/communications/send/route.ts` - Bulk communication send API
- `src/app/api/admin/communications/history/route.ts` - Communication history API
- `src/app/(admin)/admin/communications/page.tsx` - Communications admin page
- `src/app/(authenticated)/profile/notification-preferences.tsx` - Notification preferences UI
- `src/lib/__tests__/phase6a-notifications.test.ts` - 18 tests for Phase 6a
- `src/lib/__tests__/phase6b-notifications.test.ts` - 17 tests for Phase 6b
- `src/lib/__tests__/phase6c-notifications.test.ts` - 17 tests for Phase 6c

**New Prisma models (require migration):**
- `EmailLog` - Email delivery tracking with status, attempts, htmlBody for retry
- `NotificationPreference` - Per-member notification toggle preferences

**Modified files:**
- `src/lib/email.ts` - EmailLog integration, shouldSendEmail(), admin alert senders, bulk communication support
- `src/lib/email-templates.ts` - 13 new email templates (check-in reminder, admin alerts, digest, feedback, bulk communication)
- `src/instrumentation.ts` - 6 new cron jobs registered with overlap guards and timezone config
- `src/components/admin-sidebar.tsx` - Added Communications nav entry
- `src/app/api/bookings/route.ts` - Fire-and-forget admin new booking alert
- `src/app/api/webhooks/stripe/route.ts` - Payment failure admin alert
- `src/lib/bumping.ts` - Admin alert on booking bump
- `prisma/schema.prisma` - EmailLog, NotificationPreference models

## What's Next

Phases 1, 4, 5, 6, and 9 complete. See `docs/DELIVERY_PLAN.md` for remaining phases.

## Context

Tokoroa Alpine Club (TAC) is a not-for-profit operating a 29-bed alpine lodge. They currently use Checkfront for booking management and Xero for accounting/membership. They want to replace Checkfront with a bespoke booking and membership system that integrates deeply with Xero and Stripe. The club has ~410 members (310 adult, 60 youth, 40 child), no developers on the team - building entirely with LLM assistance. Hosted on AWS Lightsail.

## Tech Stack

| Layer | Choice | Rationale |
|-------|--------|-----------|
| **Framework** | Next.js 15 (App Router) | Full-stack TypeScript monolith. Single codebase for frontend + API |
| **Language** | TypeScript | Type safety catches errors at compile time |
| **Database** | PostgreSQL 16 | Robust relational DB. Free on Lightsail |
| **ORM** | Prisma 6 | Type-safe DB access, declarative schema, auto migrations |
| **Auth** | NextAuth.js v5 (Auth.js) | Credentials provider (email+password), JWT sessions |
| **UI** | Tailwind CSS + shadcn/ui | Production-quality components |
| **Payments** | Stripe (PaymentIntents + SetupIntents) | Industry standard, Xero has native Stripe feed |
| **Accounting** | Xero API via `xero-node` SDK | Full bidirectional sync: invoices, contacts, payments |
| **Email** | AWS SES via `nodemailer` | Transactional emails for confirmations, resets, notifications |
| **Deployment** | Docker Compose on Lightsail | Single `docker compose up` deploys everything |
| **Reverse Proxy** | Caddy 2 | Automatic HTTPS via Let's Encrypt |
| **Scheduled Jobs** | `node-cron` in Next.js `instrumentation.ts` | No external scheduler needed for this scale |

## Architecture Overview

```
Internet
    |
    v
[Caddy - auto HTTPS, ports 80/443]
    |
    v
[Next.js App - port 3000]
    |
    v
[PostgreSQL 16 - port 5432]

External Services:
  - Stripe (payments + webhooks)
  - Xero (accounting + webhooks)
  - AWS SES (transactional email)
```

All three services run via Docker Compose on a single Lightsail instance ($10-20/mo, 2GB RAM).

## Project Structure

```
TACBookings/
├── prisma/
│   ├── schema.prisma              # Single source of truth for DB
│   └── seed.ts                    # Seed rooms, default chores
├── src/
│   ├── app/
│   │   ├── layout.tsx             # Root layout with auth provider
│   │   ├── page.tsx               # Landing / redirect to login
│   │   ├── not-found.tsx          # 404 page
│   │   ├── error.tsx              # Error boundary
│   │   ├── global-error.tsx       # Global error boundary
│   │   ├── api/
│   │   │   ├── auth/[...nextauth]/route.ts
│   │   │   ├── bookings/route.ts          # Create booking, list bookings
│   │   │   ├── bookings/quote/route.ts    # Price quote
│   │   │   ├── bookings/cancel/route.ts   # Cancel by booking ID in body
│   │   │   ├── bookings/[id]/cancel/route.ts  # Cancel by URL param
│   │   │   ├── availability/route.ts      # Bed availability check
│   │   │   ├── payments/create-payment-intent/route.ts
│   │   │   ├── payments/create-setup-intent/route.ts
│   │   │   ├── payments/charge-saved-method/route.ts
│   │   │   ├── webhooks/stripe/route.ts
│   │   │   ├── webhooks/xero/route.ts
│   │   │   ├── cron/route.ts              # Manual cron trigger
│   │   │   ├── cron/xero/route.ts         # Xero membership refresh
│   │   │   ├── promo-codes/validate/route.ts
│   │   │   ├── admin/seasons/route.ts
│   │   │   ├── admin/seasons/[id]/route.ts
│   │   │   ├── admin/bookings/route.ts
│   │   │   ├── admin/members/route.ts
│   │   │   ├── admin/promo-codes/route.ts
│   │   │   ├── admin/promo-codes/[id]/route.ts
│   │   │   ├── admin/chores/route.ts
│   │   │   ├── admin/chores/[id]/route.ts
│   │   │   ├── admin/roster/[date]/route.ts
│   │   │   ├── admin/cancellation-policy/route.ts
│   │   │   ├── admin/subscriptions/route.ts
│   │   │   ├── admin/payments/route.ts
│   │   │   ├── admin/audit-log/route.ts
│   │   │   ├── admin/health/route.ts
│   │   │   ├── admin/reports/route.ts
│   │   │   ├── admin/xero/connect/route.ts
│   │   │   ├── admin/xero/callback/route.ts
│   │   │   ├── admin/xero/disconnect/route.ts
│   │   │   ├── admin/xero/status/route.ts
│   │   │   ├── admin/xero/sync-contacts/route.ts
│   │   │   ├── admin/xero/sync-memberships/route.ts
│   │   │   └── chores/roster/[date]/print/route.ts
│   │   ├── (public)/              # No auth required
│   │   │   ├── login/page.tsx
│   │   │   ├── register/page.tsx
│   │   │   ├── forgot-password/page.tsx
│   │   │   └── reset-password/page.tsx
│   │   ├── (authenticated)/       # Member pages
│   │   │   ├── layout.tsx         # Auth guard
│   │   │   ├── dashboard/page.tsx
│   │   │   ├── book/page.tsx      # Booking wizard
│   │   │   ├── bookings/page.tsx  # My bookings
│   │   │   ├── bookings/[id]/page.tsx
│   │   │   └── profile/page.tsx
│   │   └── (admin)/               # Admin pages
│   │       ├── layout.tsx         # Admin role guard
│   │       ├── admin/dashboard/page.tsx
│   │       ├── admin/members/page.tsx
│   │       ├── admin/seasons/page.tsx
│   │       ├── admin/bookings/page.tsx
│   │       ├── admin/promo-codes/page.tsx
│   │       ├── admin/chores/page.tsx
│   │       ├── admin/roster/page.tsx
│   │       ├── admin/roster/[date]/print/page.tsx
│   │       ├── admin/cancellation-policy/page.tsx
│   │       ├── admin/subscriptions/page.tsx
│   │       ├── admin/payments/page.tsx
│   │       ├── admin/audit-log/page.tsx
│   │       ├── admin/xero/page.tsx
│   │       ├── admin/reports/page.tsx
│   │       └── admin/health/page.tsx
│   ├── lib/
│   │   ├── prisma.ts              # Singleton Prisma client
│   │   ├── auth.ts                # NextAuth config
│   │   ├── stripe.ts              # Stripe client + helpers
│   │   ├── xero.ts                # Xero client + token refresh
│   │   ├── email.ts               # Email transport
│   │   ├── email-templates.ts     # Branded HTML email templates
│   │   ├── capacity.ts            # Bed availability calculation
│   │   ├── pricing.ts             # Rate calculation engine
│   │   ├── cancellation.ts        # Refund calculation
│   │   ├── bumping.ts             # Non-member FIFO bumping
│   │   ├── promo.ts               # Promo code validation & redemption
│   │   ├── chore-allocator.ts     # Auto-suggest chore roster
│   │   ├── age-tier.ts            # Age tier & season year computation
│   │   ├── rate-limit.ts          # In-memory rate limiter
│   │   ├── audit.ts               # Audit logging helper
│   │   ├── backup.ts              # Automated pg_dump to S3
│   │   ├── api-logger.ts          # API request logging middleware
│   │   └── webhook-log.ts         # Webhook delivery monitoring
│   ├── middleware.ts              # Security headers (CSP, HSTS, etc.)
│   ├── instrumentation.ts        # Cron job scheduling
│   └── components/
│       ├── ui/                    # shadcn/ui components
│       ├── booking-calendar.tsx
│       ├── booking-payment-section.tsx
│       ├── guest-form.tsx
│       ├── promo-code-input.tsx
│       └── chore-roster-print.tsx
├── docs/
│   ├── DELIVERY_PLAN.md           # Next wave: ~75 features in 10 phases
│   ├── BUILD_HISTORY.md           # Archived build & review logs
│   ├── DEVELOPMENT_WORKFLOW.md    # Claude Code session workflow
│   ├── FEATURE_REQUIREMENTS.md
│   └── CODEBASE_AUDIT.md
├── docker-compose.yml
├── Dockerfile
├── Caddyfile
├── .env.example
└── package.json
```

## Database Schema (Prisma)

### Core Entities

**Member** - Club members who can log in and book
```
id, email (unique), passwordHash, firstName, lastName, dateOfBirth, phone
role: MEMBER | ADMIN, ageTier: ADULT | YOUTH | CHILD (computed from DOB)
xeroContactId, active, timestamps
```

**MemberSubscription** - Annual season subscription status from Xero
```
id, memberId, seasonYear (e.g. 2025 = Apr 2025 - Mar 2026)
status: UNPAID | PAID | OVERDUE, xeroInvoiceId, paidAt
```

**Season / SeasonRate** - Admin-configured periods with per-tier pricing
```
Season: id, name, type: WINTER | SUMMER, startDate, endDate, active
SeasonRate: id, seasonId, ageTier, isMember, pricePerNightCents
```

**Booking / BookingGuest** - Stays at the lodge
```
Booking: id, memberId, checkIn, checkOut, status (PENDING|CONFIRMED|BUMPED|CANCELLED|COMPLETED)
  totalPriceCents, discountCents, finalPriceCents, hasNonMembers, nonMemberHoldUntil
BookingGuest: id, bookingId, firstName, lastName, ageTier, isMember, memberId, priceCents
```

**Payment** - Stripe payment record
```
id, bookingId (unique), amountCents, stripePaymentIntentId (unique)
stripePaymentMethodId, xeroInvoiceId (unique)
status: PENDING | PROCESSING | SUCCEEDED | FAILED | REFUNDED | PARTIALLY_REFUNDED
refundedAmountCents
```

**PromoCode / PromoRedemption** - Discount codes
```
PromoCode: type (PERCENTAGE|FIXED_AMOUNT|FREE_NIGHTS), valueCents, percentOff, freeNights
  maxRedemptions, currentRedemptions, validFrom, validUntil, membersOnly, singleUse
PromoRedemption: promoCodeId, bookingId (unique), memberId, discountCents
```

**ChoreTemplate / ChoreAssignment** - Chore roster
```
ChoreTemplate: name, description, recommendedPeople, minAge, ageRestriction, isEssential
ChoreAssignment: choreTemplateId, bookingId, bookingGuestId, date, status (SUGGESTED|CONFIRMED|COMPLETED)
```

**Other:** CancellationPolicy, XeroToken, ProcessedWebhookEvent, AuditLog, Room, PasswordResetToken

### Key Relationships
- Member -> many Bookings, MemberSubscriptions, PromoRedemptions
- Booking -> many BookingGuests, one Payment, many ChoreAssignments
- Season -> many SeasonRates
- ChoreTemplate -> many ChoreAssignments

## Core Business Logic

### 1. Booking Flow
1. Member selects dates on availability calendar
2. System shows available beds (29 minus confirmed guests per night in range)
3. Member adds themselves + guests (name, age tier, member/non-member)
4. System calculates price: look up SeasonRate for each guest's ageTier + isMember for each night
5. Member optionally applies promo code
6. **If all guests are members OR checkIn <= 7 days away**: status = CONFIRMED, collect Stripe payment immediately
7. **If any guest is non-member AND checkIn > 7 days away**: status = PENDING, collect card details via Stripe SetupIntent (no charge yet), set `nonMemberHoldUntil = checkIn - 7 days`

### 2. Non-Member Priority Bumping (FIFO - last booked = first bumped)
When a member creates a booking that would fill the lodge past 29 beds on any night:
1. Find all PENDING bookings overlapping those nights
2. Sort by `createdAt DESC` (most recent first)
3. Bump bookings one at a time until capacity is restored
4. For each bumped booking: set status = BUMPED, clean up promo redemption, send notification email

### 3. Pending Booking Confirmation (Cron - every 3 hours)
1. Find PENDING bookings where `nonMemberHoldUntil <= now()`
2. Atomic claim (updateMany WHERE status=PENDING) before charging
3. If beds available + payment method saved: charge card, confirm booking, create Xero invoice, email
4. If beds not available: bump booking, email notification

### 4. Pricing Engine
- For each night in stay: determine which Season it falls in, look up SeasonRate for guest's ageTier + isMember
- All prices stored as integer cents (e.g. $45.50 = 4550)
- Promo code application: FREE_NIGHTS (subtract cheapest N nights), PERCENTAGE (% off total), FIXED_AMOUNT (flat $ off)

### 5. Cancellation & Refunds
- Admin-configurable policy: e.g. 14+ days = 100% refund, 7-14 days = 50%, <7 days = 0%
- Members cancel from their booking detail page
- System calculates refund based on policy, processes Stripe refund, creates Xero credit note, cleans up promo redemption

### 6. Chore Roster
- Admin configures chore templates (name, recommended people count, min age, age restriction)
- For a given date, system auto-suggests assignments using round-robin across confirmed guests (4-day history lookback, occupancy scaling)
- Hut leader reviews on admin panel, can reassign/edit, then confirms
- Printable A4 page with CSS `@media print` styling

### 7. Xero Integration (Full Bidirectional Sync)
- **OAuth2 Flow:** Admin connects via admin panel, tokens encrypted with AES-256-GCM
- **Membership Verification:** Daily cron queries Xero invoices for subscription keywords in current season year
- **Booking Invoices:** On CONFIRMED + payment: find/create Contact, create Invoice with per-guest line items, record payment
- **Refund Sync:** Stripe refund -> Xero credit note against original invoice

## Email Notifications

| Event | Recipient | Status |
|-------|-----------|--------|
| Registration | New member | Implemented |
| Password reset | Member | Implemented |
| Booking confirmed | Booking member | Implemented |
| Booking pending | Booking member | Implemented |
| Pending -> confirmed | Booking member | Implemented |
| Booking bumped | Booking member | Implemented |
| Booking cancelled | Booking member | Implemented |
| Chore roster | All guests for date | Implemented |
| Admin: new booking | Admin | Not yet |
| Admin: capacity warning | Admin | Not yet |
| Admin: pending approaching deadline | Admin | Not yet |

## Deployment (AWS Lightsail)

**Instance:** 2GB RAM, 1 vCPU ($10/mo), Ubuntu 24.04 LTS.

**Docker Compose** (3 services): `caddy` (reverse proxy, auto HTTPS), `app` (Next.js), `postgres` (PostgreSQL 16).

**Deploy process:**
1. Push to GitHub
2. SSH into Lightsail: `git pull && docker compose up -d --build`
3. On schema changes: `docker compose run --rm migrate`

**Backups:** Lightsail snapshots + daily pg_dump cron to S3 (configurable via env vars).

**Environment variables:** See `.env.example` for the full list.

## Key Design Decisions

- **All prices in cents as integers** - prevents floating point rounding bugs with money
- **Timezone: Pacific/Auckland (NZST/NZDT)** - all dates stored as date-only (no time) since bookings are per-night
- **JWT sessions (not database sessions)** - 410 members, simple roles. 8hr expiry. Trade-off: can't instantly revoke, but acceptable at this scale
- **Capacity-based booking (not room-based)** - members book beds, admin assigns rooms separately if needed
- **Season year = April to March** - if current month >= April, seasonYear = currentYear; else seasonYear = currentYear - 1
- **Fixed advisory lock key** - `pg_advisory_xact_lock(1)` serializes all booking creation to prevent double-booking
- **Promo codes cleaned up on cancel/bump** - PromoRedemption deleted and currentRedemptions decremented

## Verification & Testing

- **Unit tests**: Pricing engine, availability calculator, bumping algorithm, chore allocator, promo validation, rate limiter, email templates (use Vitest)
- **Manual testing**: Each phase deployed and tested on Lightsail before proceeding
- **UAT**: Club committee tests before go-live with real member data
- **Stripe test mode**: Use Stripe test keys throughout development, switch to live keys at go-live
- **Xero demo company**: Test against Xero demo org before connecting production

## Build History Summary

9 build phases + security audit + 5 integration reviews completed 2026-04-03. Delivery Phases 1, 4, 5, 6, and 9 completed 2026-04-06. 411 tests pass. All critical/high issues resolved. See `docs/BUILD_HISTORY.md` for full details. Original build workflow documented in `docs/DEVELOPMENT_WORKFLOW.md`.
