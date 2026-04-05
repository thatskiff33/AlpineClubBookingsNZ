# TACBookings

## How to Run

```bash
npm install --legacy-peer-deps
npx prisma generate
npm test              # 312 tests pass (15 test files)
npm run build         # builds successfully
npm run dev           # development server

# Docker deployment:
docker compose up -d --build

# Seed database (requires running PostgreSQL):
npx prisma migrate dev --name initial
npm run db:seed
```

**Test accounts (from seed):**
- Admin: admin@tac.org.nz / admin123
- Member: member@tac.org.nz / member123

**Note:** nodemailer v8 has peer dep conflict with next-auth (use `--legacy-peer-deps`)

## Current State

All 9 build phases + Delivery Phase 1 complete. Security audit + 5 integration reviews done. 312 tests pass, build succeeds.

**What works today:**
- Auth: login, register, password reset, JWT sessions (8h expiry), admin role guard
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

## What's Next

Phase 1 (Foundational Infrastructure) complete. See `docs/DELIVERY_PLAN.md` for remaining phases 2-10.

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
│   │       ├── admin/xero/page.tsx
│   │       └── admin/reports/page.tsx
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
│   │   └── backup.ts              # Automated pg_dump to S3
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
3. On schema changes: `docker compose exec app npx prisma migrate deploy`

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

9 build phases + security audit + 5 integration reviews completed 2026-04-03. 292 tests pass. All critical/high issues resolved. See `docs/BUILD_HISTORY.md` for full details. Original build workflow documented in `docs/DEVELOPMENT_WORKFLOW.md`.
