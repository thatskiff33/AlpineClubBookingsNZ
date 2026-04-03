# TACBookings - Build Plan

## Build Status

### Phases 1-6 & 8: MERGED INTO MAIN

All completed build phases have been merged into `main` in sequence, with all conflicts resolved.

**What has been built:**

1. **Phase 1: Foundation** - Next.js 15 + TypeScript + Tailwind + shadcn/ui, Prisma schema (all entities), NextAuth v5 credentials auth with JWT sessions, password reset flow, member profile, admin layout with sidebar, Docker Compose + Caddy setup
2. **Phase 2: Seasons & Pricing** - Admin seasons CRUD (`/admin/seasons`), cancellation policy management (`/admin/cancellation-policy`), pricing engine with full test coverage (getStayNights, findSeasonForDate, getNightlyRate, calculateBookingPrice, calculatePromoDiscount, calculateRefund, formatCents, getSeasonYear)
3. **Phase 3: Core Booking** - Availability calculator (29-bed capacity), booking wizard (`/book`), guest forms, booking API routes (create, quote, cancel, availability), my bookings list + detail pages, admin bookings page with filters
4. **Phase 4: Stripe Payments** - PaymentIntents for confirmed bookings, SetupIntents for pending bookings (save card, charge later), Stripe webhook handler, cancellation with policy-based refunds, Stripe React components (PaymentForm, SetupForm, StripeProvider)
5. **Phase 5: Non-Member Guests & Bumping** - FIFO bumping algorithm (`src/lib/bumping.ts`), cron job for auto-confirming pending bookings (`src/instrumentation.ts` + `src/lib/cron-confirm-pending.ts`), booking API integration with bumping for member bookings, email notifications (confirmed, pending, bumped), payment routes now use NextAuth auth, manual cron trigger API (`/api/cron`)
6. **Phase 6: Xero Integration** - OAuth2 connect flow, encrypted token storage, invoice creation on booking confirmation, credit notes on refunds, contact sync, membership verification, daily cron for membership refresh, webhook handler. Wired into Stripe webhook, cancellation route, and cron auto-confirmation (all guarded with `isXeroConnected()` check).
8. **Phase 8: Chore Roster** - Chore allocator algorithm (round-robin, age-aware), admin chore template management, roster review/edit page, printable A4 roster view, chore roster email notifications. Enhanced ChoreTemplate with ageRestriction enum, recommendedPeopleMin/Max, isEssential, conditionalNote.

### Cross-Phase Integration Review - COMPLETED

**Date:** 2026-04-03

**Scope:** Full codebase review after merging Phases 5, 6, and 8 in parallel. Build, type check, 224 tests all pass. Reviewed cross-phase integration, auth/security, Prisma schema, business logic, error handling, dependencies, and code quality.

**24 issues found (2 Critical, 8 High, 10 Medium, 4 Low). All Critical and High issues fixed:**

1. **CRITICAL: `/api/bookings/cancel` had no auth** - Auth and ownership checks were commented out with TODO. Restored `auth()` call and `memberId` ownership verification.
2. **HIGH: Payment routes missing ownership checks** - `/api/payments/create-payment-intent` and `/api/payments/create-setup-intent` verified auth but not booking ownership. Added `booking.memberId !== session.user.id` checks.
3. **HIGH: Missing Xero invoice on manual charge** - `/api/payments/charge-saved-method` confirmed bookings without creating Xero invoices. Added guarded `createXeroInvoiceForBooking()` call.
4. **HIGH: Duplicate cancellation routes with inconsistent logic** - `/api/bookings/[id]/cancel` just set status without refund/Xero. Rewrote to include full cancellation flow (policy-based refund, Stripe refund, Xero credit note).
5. **HIGH: Wrong CHILD age threshold in profile** - `/api/profile` had local `computeAgeTier` using `age < 10` instead of canonical `age < 13`. Now imports from `@/lib/age-tier`.
6. **HIGH: Missing Xero env vars in docker-compose** - `XERO_ENCRYPTION_KEY` and `XERO_WEBHOOK_KEY` not passed to app container. Added both. Also added `DOMAIN` env var for Caddy.
7. **HIGH: No cron overlap guard** - Both cron jobs in `instrumentation.ts` could run concurrently if a previous execution hadn't finished. Added `isRunning` flags with `finally` cleanup.

**Remaining Medium/Low issues (not fixed, documented for future):**
- Missing FK indexes on `PasswordResetToken.memberId` and `ChoreAssignment.choreTemplateId`
- `getSeasonYear` duplicated in 3 files (`utils.ts`, `pricing.ts`, `age-tier.ts`)
- `formatCents` duplicated in 2 files
- Inconsistent cron auth patterns (`x-cron-secret` vs `Authorization: Bearer`)
- `/api/seasons` GET and `/api/availability` have no auth (may be intentionally public)
- Unused `Room` model in Prisma schema
- Unused `calculateRefund` function in `pricing.ts` (active version is in `cancellation.ts`)
- `dotenv` package unused in dependencies

### Phase 6: Xero Integration - COMPLETED

**Date:** 2026-04-03

**What was built:**
- **OAuth2 flow:** Admin "Connect Xero" button redirects to Xero authorization, callback stores encrypted tokens
- **Token management:** AES-256-GCM encrypted at rest, auto-refresh 5 minutes before 30-min expiry
- **Invoice creation:** `createXeroInvoiceForBooking(bookingId)` - creates Xero invoice with per-guest line items, records payment against invoice, stores `xeroInvoiceId` on Payment record
- **Credit notes:** `createXeroCreditNote(paymentId, refundAmountCents)` - creates credit note against original invoice for refunds
- **Contact sync:** Bulk import from Xero (matches by email), find-or-create on invoice creation, links `xeroContactId` on Member
- **Membership verification:** `checkMembershipStatus(memberId)` - queries Xero invoices for subscription keywords in current season year, updates MemberSubscription status (PAID/UNPAID/OVERDUE)
- **Daily cron:** `POST /api/cron/xero` (secured with CRON_SECRET) refreshes membership status for all active members with Xero contacts
- **Xero webhook handler:** HMAC-SHA256 signature verification, intent-to-receive pattern support
- **Admin page:** `/admin/xero` - connection status, connect/disconnect, contact sync, membership refresh with results display
- **Tests:** 36 new tests covering encryption, invoice line items, subscription matching, season year boundaries

**Key files:**
- `src/lib/xero.ts` - Core Xero integration library (all business logic)
- `src/lib/__tests__/xero.test.ts` - 36 tests
- `src/app/(admin)/admin/xero/page.tsx` - Admin Xero status page
- `src/app/api/admin/xero/connect/route.ts` - OAuth2 redirect
- `src/app/api/admin/xero/callback/route.ts` - OAuth2 callback
- `src/app/api/admin/xero/disconnect/route.ts` - Disconnect
- `src/app/api/admin/xero/status/route.ts` - Connection status
- `src/app/api/admin/xero/sync-contacts/route.ts` - Bulk contact import
- `src/app/api/admin/xero/sync-memberships/route.ts` - Membership refresh
- `src/app/api/webhooks/xero/route.ts` - Webhook handler
- `src/app/api/cron/xero/route.ts` - Daily cron endpoint

**Integration points (for other phases to wire in):**
- Call `createXeroInvoiceForBooking(bookingId)` after booking confirmation + payment success
- Call `createXeroCreditNote(paymentId, refundAmountCents)` after Stripe refund processing
- Call `checkMembershipStatus(memberId)` on login to verify current subscription

**Environment variables required:**
- `XERO_CLIENT_ID` - From Xero developer app
- `XERO_CLIENT_SECRET` - From Xero developer app
- `XERO_REDIRECT_URI` - OAuth2 callback URL
- `XERO_ENCRYPTION_KEY` - 64-char hex string for token encryption (generate: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`)
- `XERO_WEBHOOK_KEY` - From Xero webhook subscription config

5. **Phase 8: Chore Roster** - ChoreTemplate schema extended (recommendedPeopleMin/Max, isEssential, ageRestriction enum, conditionalNote), 17 chore templates seeded, auto-suggest allocation algorithm with round-robin/age restrictions/4-day history lookback/occupancy scaling, admin chores CRUD (`/admin/chores`), admin roster review (`/admin/roster`) with date picker/reassignment/confirm, printable A4 roster (`/admin/roster/[date]/print`), roster email to guests, 39 chore allocator tests

**How to run:**
```bash
npm install --legacy-peer-deps
npx prisma generate
npm test              # 224 tests pass (11 test files)
npm run build         # builds successfully
```

**To seed database (requires running PostgreSQL):**
```bash
npx prisma migrate dev --name initial
npm run db:seed
```

**Test accounts (from seed):**
- Admin: admin@tac.org.nz / admin123
- Member: member@tac.org.nz / member123

**Known considerations:**
- nodemailer v8 has peer dep conflict with next-auth (use `--legacy-peer-deps`)
- Prisma v6 (not v7) - standard PostgreSQL compatible
- All prices stored as integer cents
- Season year: April-March cycle
- No migrations committed yet - run `prisma migrate dev` to create initial migration from merged schema
- Xero account codes default to "200" (sales) and "090" (bank) - may need configuration for specific Xero orgs

### Phase 5 Details: Non-Member Guests & Bumping

**Key files:**
- `src/lib/bumping.ts` - FIFO bumping algorithm: finds PENDING non-member bookings overlapping date range, bumps most-recent-first until capacity restored
- `src/lib/cron-confirm-pending.ts` - Cron processing: finds PENDING bookings past hold deadline, checks capacity, charges saved PaymentMethod or bumps
- `src/instrumentation.ts` - Next.js instrumentation hook: schedules node-cron job every 3 hours
- `src/app/api/cron/route.ts` - Manual cron trigger endpoint (secured by CRON_SECRET header)
- `src/app/api/bookings/route.ts` - Updated to integrate bumping when member bookings exceed capacity

**Booking flow logic:**
- **All-member guests OR check-in <= 7 days**: status = CONFIRMED, collect Stripe payment immediately
- **Has non-member guests AND check-in > 7 days**: status = PENDING, collect card via SetupIntent, set `nonMemberHoldUntil = checkIn - 7 days`
- **Member booking exceeds capacity**: triggers FIFO bumping of PENDING bookings (most recent first)
- **Non-member booking exceeds capacity**: rejected (cannot bump other bookings)

**Cron job behavior (every 3 hours):**
1. Finds PENDING bookings where `nonMemberHoldUntil <= now()`
2. For each: re-checks bed availability
3. If beds available + payment method saved: charges card, confirms booking, sends email
4. If beds not available: bumps booking, sends notification email
5. Continues processing remaining bookings even if one fails

**Edge cases handled:**
- Stops bumping as soon as capacity is restored (doesn't over-bump)
- Returns capacityRestored=false if bumping all PENDING bookings isn't enough
- Booking API rejects new booking if capacity can't be restored
- Cron handles missing payment methods gracefully (marks as failed)
- Cron handles Stripe charge failures gracefully
- Bumped notification emails sent after transaction commits (no emails on rollback)
- Advisory locks prevent concurrent double-booking

### What's Next: Phase 7 - Promo Codes & Discounts
1. Admin UI: create/edit promo codes (type, value, limits, date range)
2. Promo code entry in booking wizard
3. Validation (expiry, usage limits, single-use, member-only)
4. Discount reflected in Stripe charge and Xero invoice
5. Redemption tracking

## Context

Tokoroa Alpine Club (TAC) is a not-for-profit operating a 29-bed alpine lodge. They currently use Checkfront for booking management and Xero for accounting/membership. They want to replace Checkfront with a bespoke booking and membership system that integrates deeply with Xero and Stripe. The club has ~410 members (310 adult, 60 youth, 40 child), no developers on the team - building entirely with LLM assistance. Hosted on AWS Lightsail.

## Tech Stack

| Layer | Choice | Rationale |
|-------|--------|-----------|
| **Framework** | Next.js 15 (App Router) | Full-stack TypeScript monolith. Largest LLM training corpus. Single codebase for frontend + API |
| **Language** | TypeScript | Type safety catches errors at compile time. LLMs generate excellent TS |
| **Database** | PostgreSQL 16 | Robust relational DB, handles bookings/members/payments well. Free on Lightsail |
| **ORM** | Prisma | Type-safe DB access, declarative schema = self-documenting, auto migrations |
| **Auth** | NextAuth.js v5 (Auth.js) | Credentials provider (email+password), JWT sessions, built-in password reset |
| **UI** | Tailwind CSS + shadcn/ui | Production-quality components without design skills. LLMs produce excellent Tailwind |
| **Payments** | Stripe (PaymentIntents + SetupIntents) | Industry standard, Xero has native Stripe feed |
| **Accounting** | Xero API via `xero-node` SDK | Full bidirectional sync: invoices, contacts, payments |
| **Email** | AWS SES via `nodemailer` (or Resend) | Already on AWS. Transactional emails for confirmations, resets, notifications |
| **Deployment** | Docker Compose on Lightsail | Single `docker compose up` deploys everything |
| **Reverse Proxy** | Caddy 2 | Automatic HTTPS via Let's Encrypt. Two-line config |
| **Scheduled Jobs** | `node-cron` in Next.js `instrumentation.ts` | No external scheduler needed for this scale |

**Why NOT alternatives:**
- Django/Rails: Two-language problem (Python/Ruby + JS for frontend)
- Microservices: Massively over-engineered for 410 users
- Separate React SPA + Express: Two codebases instead of one
- Supabase/Firebase: Adds vendor lock-in, another abstraction layer

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
│   │   ├── api/
│   │   │   ├── auth/[...nextauth]/route.ts
│   │   │   ├── webhooks/stripe/route.ts
│   │   │   ├── webhooks/xero/route.ts
│   │   │   ├── cron/route.ts      # Cron endpoint (secured)
│   │   │   └── chores/roster/[date]/print/route.ts
│   │   ├── (public)/              # No auth required
│   │   │   ├── login/page.tsx
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
│   │   ├── email.ts               # Email transport + templates
│   │   ├── capacity.ts            # Bed availability calculation
│   │   ├── pricing.ts             # Rate calculation engine
│   │   ├── bumping.ts             # Non-member FIFO bumping
│   │   └── chore-allocator.ts     # Auto-suggest chore roster
│   └── components/
│       ├── ui/                    # shadcn/ui components
│       ├── booking-calendar.tsx
│       ├── guest-form.tsx
│       └── chore-roster-print.tsx
├── docker-compose.yml
├── Dockerfile
├── Caddyfile
├── .env.example
├── CLAUDE.md
└── package.json
```

## Database Schema (Prisma)

### Core Entities

**Member** - Club members who can log in and book
```
- id, email (unique), passwordHash, firstName, lastName
- dateOfBirth, phone
- role: MEMBER | ADMIN
- ageTier: ADULT | YOUTH | CHILD (computed from DOB)
- xeroContactId (link to Xero contact)
- active: boolean
- timestamps
```

**MemberSubscription** - Tracks annual season subscription status from Xero
```
- id, memberId, seasonYear (e.g. 2025 = Apr 2025 - Mar 2026)
- status: UNPAID | PAID | OVERDUE
- xeroInvoiceId
- paidAt
```

**Season** - Admin-configured winter/summer periods with rates
```
- id, name ("Winter 2025"), type: WINTER | SUMMER
- startDate, endDate
- active: boolean
```

**SeasonRate** - Per-season pricing (6 rates per season: 3 age tiers x member/non-member)
```
- id, seasonId, ageTier: ADULT | YOUTH | CHILD
- isMember: boolean
- pricePerNightCents: integer (store money as cents to avoid floating point)
```

**Booking** - A stay at the lodge
```
- id, memberId (who booked), checkIn, checkOut
- status: PENDING | CONFIRMED | BUMPED | CANCELLED | COMPLETED
- totalPriceCents, discountCents, finalPriceCents
- hasNonMembers: boolean
- nonMemberHoldUntil: datetime (checkIn - 7 days, for pending bookings)
- notes
- timestamps
```

**BookingGuest** - Individual guests within a booking
```
- id, bookingId, firstName, lastName
- ageTier, isMember, memberId (nullable - linked if they're a member)
- priceCents (price for this guest for the full stay)
```

**Payment** - Stripe payment record linked to booking
```
- id, bookingId (unique), amountCents
- stripePaymentIntentId (unique), stripePaymentMethodId
- xeroInvoiceId (unique)
- status: PENDING | PROCESSING | SUCCEEDED | FAILED | REFUNDED | PARTIALLY_REFUNDED
- refundedAmountCents
```

**PromoCode** - Discount codes and vouchers
```
- id, code (unique), description
- type: PERCENTAGE | FIXED_AMOUNT | FREE_NIGHTS
- valueCents, percentOff, freeNights (nullable, depends on type)
- maxRedemptions, currentRedemptions
- validFrom, validUntil
- membersOnly, singleUse, active
```

**PromoRedemption** - Tracks which member used which code on which booking
```
- id, promoCodeId, bookingId (unique), memberId
- discountCents
```

**ChoreTemplate** - Configurable chore definitions
```
- id, name ("Dishes", "Sweep common area", "Clean bathrooms")
- description, recommendedPeople (default 2)
- minAge (default 10 - skip children under this age)
- sortOrder, active
```

**ChoreAssignment** - Assigns guests to chores per day
```
- id, choreTemplateId, bookingId, bookingGuestId (nullable)
- date (which day)
- status: SUGGESTED | CONFIRMED | COMPLETED
```

**CancellationPolicy** - Admin-configurable refund rules
```
- id, daysBeforeStay, refundPercentage
- e.g. [{days: 14, refund: 100}, {days: 7, refund: 50}, {days: 0, refund: 0}]
```

**XeroToken** - Stores OAuth2 tokens for Xero integration
```
- id, accessToken (encrypted), refreshToken (encrypted)
- expiresAt, tenantId
```

### Key Relationships
- Member -> many Bookings, many MemberSubscriptions, many PromoRedemptions
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
4. For each bumped booking: set status = BUMPED, send notification email
5. No refund needed (payment wasn't taken for PENDING bookings)

### 3. Pending Booking Confirmation (Cron - runs every few hours)
1. Find PENDING bookings where `nonMemberHoldUntil <= now()`
2. Re-check availability for each
3. If beds available: charge saved PaymentMethod via Stripe, set CONFIRMED, create Xero invoice, email confirmation
4. If beds no longer available: set BUMPED, email notification

### 4. Pricing Engine
- For each night in stay: determine which Season it falls in, look up SeasonRate for guest's ageTier + isMember
- All prices stored as integer cents (e.g. $45.50 = 4550)
- Promo code application: FREE_NIGHTS (subtract cheapest N nights), PERCENTAGE (% off total), FIXED_AMOUNT (flat $ off)

### 5. Cancellation & Refunds
- Admin-configurable policy: e.g. 14+ days = 100% refund, 7-14 days = 50%, <7 days = 0%
- Members cancel from their booking detail page
- System calculates refund based on policy, processes Stripe refund, creates Xero credit note

### 6. Chore Roster
- Admin configures chore templates (name, recommended people count, min age)
- For a given date, system auto-suggests assignments using round-robin across all confirmed guests
- Hut leader reviews on admin panel, can reassign/edit
- Confirms roster - status changes from SUGGESTED to CONFIRMED
- Printable A4 page: clean table with guest names, assigned chores, date - CSS `@media print` styling

### 7. Xero Integration (Full Bidirectional Sync)

**OAuth2 Flow:**
1. Admin clicks "Connect Xero" in admin panel
2. Redirects to Xero authorization
3. Callback stores encrypted access + refresh tokens
4. Auto-refresh before 30-min expiry

**Xero -> TAC (Membership Verification):**
- Daily cron + on-login check: query Xero for member's contact by `xeroContactId`
- Check for paid invoices matching current season subscription
- Update MemberSubscription status
- Season year logic: if current month >= April, seasonYear = currentYear; else seasonYear = currentYear - 1

**TAC -> Xero (Booking Invoices):**
- On CONFIRMED + payment succeeded:
  1. Find or create Xero Contact for the member
  2. Create Xero Invoice with line items (per guest, per night, showing rates)
  3. Record payment against the invoice
  4. Store xeroInvoiceId on Payment record

**Refund Sync:**
- Stripe refund webhook -> create Xero credit note against original invoice

## Email Notifications

| Event | Recipient | Content |
|-------|-----------|---------|
| Registration | New member | Welcome email |
| Password reset | Member | Reset link (1hr expiry) |
| Booking confirmed | Booking member | Dates, guests, total, payment receipt |
| Booking pending | Booking member | Dates, guests, explanation of hold period |
| Pending -> confirmed | Booking member | Payment taken, confirmation details |
| Booking bumped | Booking member | Apology, explanation, rebooking link |
| Booking cancelled | Booking member | Cancellation confirmation, refund amount |
| Chore roster | All guests for date | Their assigned chores for the day |
| Admin: new booking | Admin | Notification of new booking |
| Admin: capacity warning | Admin | Lodge nearly full for upcoming dates |
| Admin: pending approaching deadline | Admin | Non-member bookings about to auto-confirm |

## Deployment (AWS Lightsail)

**Instance:** 2GB RAM, 1 vCPU ($10/mo). Upgrade to 4GB ($20/mo) if needed.
**OS:** Ubuntu 24.04 LTS
**DNS:** Point domain A record to Lightsail static IP.

**Docker Compose** (3 services):
1. `caddy` - reverse proxy, auto HTTPS
2. `app` - Next.js application
3. `postgres` - PostgreSQL 16

**Caddyfile:**
```
yourdomain.co.nz {
    reverse_proxy app:3000
}
```

**Deploy process:**
1. Push to GitHub
2. SSH into Lightsail: `git pull && docker compose up -d --build`
3. On schema changes: `docker compose exec app npx prisma migrate deploy`
4. Future: automate with GitHub Actions

**Backups:**
- Lightsail automatic snapshots (built-in, ~$2/mo)
- Daily `pg_dump` cron to S3 bucket

**Environment variables (.env):**
```
DATABASE_URL=postgresql://tac:PASSWORD@postgres:5432/tacbookings
NEXTAUTH_URL=https://yourdomain.co.nz
NEXTAUTH_SECRET=<random-64-char>
STRIPE_SECRET_KEY=sk_live_...
STRIPE_PUBLISHABLE_KEY=pk_live_...
STRIPE_WEBHOOK_SECRET=whsec_...
XERO_CLIENT_ID=...
XERO_CLIENT_SECRET=...
XERO_REDIRECT_URI=https://yourdomain.co.nz/api/admin/xero/callback
AWS_SES_REGION=ap-southeast-2
AWS_SES_ACCESS_KEY_ID=...
AWS_SES_SECRET_ACCESS_KEY=...
EMAIL_FROM=bookings@yourdomain.co.nz
CRON_SECRET=<random-32-char>
```

## Phased Build Order

### Phase 1: Foundation (Week 1-2)
**Goal: Working login, basic member management, deployed to Lightsail**
1. Initialize Next.js 15 + TypeScript + Tailwind + shadcn/ui
2. Prisma schema (full schema upfront), initial migration
3. Seed rooms (7 rooms, capacities)
4. NextAuth credentials provider (login/register)
5. Password reset flow with email
6. Basic member profile page
7. Admin layout + member list page
8. Docker Compose + Caddy setup
9. Deploy to Lightsail, verify HTTPS
- **Files:** `prisma/schema.prisma`, `src/lib/prisma.ts`, `src/lib/auth.ts`, `src/lib/email.ts`, `docker-compose.yml`, `Dockerfile`, `Caddyfile`

### Phase 2: Seasons & Pricing (Week 3)
**Goal: Admin can configure seasons, rates, and cancellation policy**
1. Admin UI: create/edit seasons (name, type, start/end dates)
2. Admin UI: set rates per season (6 rates per season)
3. Admin UI: cancellation policy configuration
4. Pricing engine with unit tests
5. Seed initial seasons and rates
- **Files:** `src/lib/pricing.ts`, `src/app/(admin)/admin/seasons/page.tsx`, `src/app/(admin)/admin/cancellation-policy/page.tsx`

### Phase 3: Core Booking (Week 4-5)
**Goal: Members can book stays and see availability**
1. Availability calculator (beds per night query)
2. Booking calendar UI (date picker showing availability)
3. Guest addition form (name, age, member/non-member)
4. Real-time price display as guests are added
5. Booking creation (member-only bookings first, immediate confirmation)
6. My bookings list + detail pages
7. Admin: view all bookings with filters
8. Concurrency handling (advisory locks)
- **Files:** `src/lib/capacity.ts`, `src/app/(authenticated)/book/page.tsx`, `src/app/(authenticated)/bookings/page.tsx`

### Phase 4: Stripe Payments (Week 6)
**Goal: Bookings require payment to confirm**
1. Stripe integration: PaymentIntents for confirmed bookings
2. Stripe Elements card input in booking wizard
3. Webhook handler for payment events
4. Booking status tied to payment success
5. SetupIntents for pending bookings (save card, charge later)
6. Cancellation with policy-based Stripe refunds
- **Files:** `src/lib/stripe.ts`, `src/app/api/webhooks/stripe/route.ts`

### Phase 5: Non-Member Guests & Bumping (Week 7-8)
**Goal: Full non-member booking flow with priority system**
1. Non-member guest flow in booking wizard
2. PENDING status for non-member bookings >7 days out
3. Cron job to auto-confirm pending bookings at 7-day mark
4. FIFO bumping algorithm when members fill lodge
5. Charge saved PaymentMethod on confirmation
6. Bumped booking notification emails
7. Thorough edge-case testing
- **Files:** `src/lib/bumping.ts`, cron logic in `src/instrumentation.ts`

### Phase 6: Xero Integration (Week 9-10)
**Goal: Full bidirectional Xero sync**
1. OAuth2 connect flow in admin panel
2. Token storage (encrypted) and auto-refresh
3. Membership subscription check (block booking if unpaid)
4. Invoice creation on confirmed booking
5. Payment recording against Xero invoice
6. Credit note on refund
7. Contact sync (bulk import + ongoing sync)
8. Daily cron for membership status refresh
- **Files:** `src/lib/xero.ts`, `src/app/api/webhooks/xero/route.ts`, `src/app/(admin)/admin/xero/page.tsx`

### Phase 7: Promo Codes & Discounts (Week 11)
**Goal: Working bee vouchers and promotional pricing**
1. Admin UI: create/edit promo codes (type, value, limits, date range)
2. Promo code entry in booking wizard
3. Validation (expiry, usage limits, single-use, member-only)
4. Discount reflected in Stripe charge and Xero invoice
5. Redemption tracking
- **Files:** `src/app/(admin)/admin/promo-codes/page.tsx`

### Phase 8: Chore Roster (Week 12-13)
**Goal: Auto-suggested, editable, printable chore roster**
1. Admin UI: chore template management (name, recommended people, min age)
2. Auto-suggest algorithm (round-robin, skip children under min age)
3. Hut leader review/edit interface (drag-and-drop or dropdown reassignment)
4. Confirm roster (SUGGESTED -> CONFIRMED)
5. Printable A4 page with `@media print` CSS
6. Email roster to guests for the day
- **Files:** `src/lib/chore-allocator.ts`, `src/app/(admin)/admin/roster/page.tsx`, `src/app/(admin)/admin/roster/[date]/print/page.tsx`

### Phase 9: Polish & Production Hardening (Week 14-15)
**Goal: Production-ready, tested, documented**
1. Comprehensive error handling and user-friendly error pages
2. Admin reports (occupancy rates, revenue by period, booking trends)
3. Email template polish (React Email)
4. Automated database backup cron to S3
5. GitHub Actions deploy pipeline (optional)
6. Security audit (rate limiting, input validation, CSRF)
7. User acceptance testing with club committee
8. Member data import from Checkfront/Xero

## Key Design Decisions

- **All prices in cents as integers** - prevents floating point rounding bugs with money
- **Timezone: Pacific/Auckland (NZST/NZDT)** - all dates stored as date-only (no time) since bookings are per-night. Server timezone set to NZ
- **JWT sessions (not database sessions)** - 410 members, simple roles. 24hr expiry with refresh. Trade-off: can't instantly revoke, but acceptable at this scale
- **Capacity-based booking (not room-based)** - members book beds, admin assigns rooms separately if needed. Simplifies the booking engine significantly
- **Season year = April to March** - if current month >= April, seasonYear = currentYear; else seasonYear = currentYear - 1

## Verification & Testing

- **Unit tests**: Pricing engine, availability calculator, bumping algorithm, chore allocator (use Vitest)
- **Integration tests**: Booking flow end-to-end, Stripe webhook handling, Xero sync
- **Manual testing**: Each phase deployed and tested on Lightsail before proceeding
- **UAT**: Club committee tests before go-live with real member data
- **Stripe test mode**: Use Stripe test keys throughout development, switch to live keys at go-live
- **Xero demo company**: Test against Xero demo org before connecting production

## Development Workflow: How to Build This with Claude

### Overview

The build uses a **session-per-phase** approach. Each session focuses on one build phase, runs autonomously with minimal interruption, and hands off cleanly to the next session via CLAUDE.md. Within each session, Claude uses sub-agents in parallel where modules are independent.

### Step 1: Configure Claude Code for Autonomous Work

Create `.claude/settings.json` in the project root to pre-approve safe commands so Claude doesn't ask permission for every npm/git/prisma operation:

```json
{
  "permissions": {
    "allow": [
      "Bash(npm *)",
      "Bash(npx *)",
      "Bash(node *)",
      "Bash(git add *)",
      "Bash(git commit *)",
      "Bash(git push *)",
      "Bash(git status*)",
      "Bash(git diff*)",
      "Bash(git log*)",
      "Bash(docker compose *)",
      "Bash(mkdir *)",
      "Bash(ls *)",
      "Bash(cat *)",
      "Bash(cp *)",
      "Bash(mv *)",
      "Bash(rm -rf node_modules)",
      "Bash(rm -rf .next)",
      "Read(*)",
      "Edit(*)",
      "Write(*)",
      "Glob(*)",
      "Grep(*)"
    ],
    "deny": [
      "Bash(rm -rf /)*",
      "Bash(rm -rf .git)*"
    ]
  }
}
```

This eliminates ~90% of permission prompts. Claude can freely create files, install packages, run builds/tests, commit, and push without stopping to ask.

### Step 2: Structure CLAUDE.md for Session Handoff

The CLAUDE.md in the repo root is the **single source of truth** that any new Claude session reads first. It must always contain:

1. **What the project is** (context, requirements) - already written
2. **What has been built so far** - updated at end of each session
3. **What to build next** - the next phase's scope
4. **How to run/test it** - commands that work right now
5. **Known issues / decisions made** - so Claude doesn't re-litigate settled decisions

At the end of each build session, tell Claude: **"Update CLAUDE.md with what was built, what works, and what's next. Commit and push."**

### Step 3: Add Path-Scoped Rules for Focused Context

Create `.claude/rules/` directory with files that only load when Claude touches files in matching paths:

**`.claude/rules/database.md`** (loads when touching `prisma/**`):
```
- All prices stored as integer cents (e.g. $45.50 = 4550)
- Use Prisma transactions for any multi-table writes
- Always add indexes on foreign keys and commonly queried fields
- Season year: if month >= April, year = currentYear; else year = currentYear - 1
```

**`.claude/rules/api.md`** (loads when touching `src/app/api/**`):
```
- Validate all inputs with Zod schemas
- Return consistent error shape: { error: string, details?: any }
- Always check auth via auth() helper before processing
- Admin routes must verify role === ADMIN
```

**`.claude/rules/stripe.md`** (loads when touching `src/lib/stripe*`):
```
- Always verify Stripe webhook signatures
- Use PaymentIntents for confirmed bookings, SetupIntents for pending
- Store all Stripe IDs for reconciliation
- Handle idempotency - webhooks may fire multiple times
```

**`.claude/rules/testing.md`** (loads when touching `**/*.test.*`):
```
- Use Vitest for all tests
- Test business logic (pricing, availability, bumping) thoroughly
- Mock Stripe and Xero API calls in tests
- Every new lib/ function should have tests before the session ends
```

### Step 4: Session-per-Phase Execution

Each phase = one Claude Code session. Here's how to run each:

**Starting a session (your prompt to Claude):**
```
Read CLAUDE.md. Build Phase [N]: [Phase Name].

Build everything in this phase autonomously. Write tests for all
business logic. Commit after each major milestone. When done, update
CLAUDE.md with what was built, commands to run/test, and what's next.
Push all commits.
```

That's it. Claude reads the plan, knows the full context, builds the phase, tests it, commits, and updates the handoff doc. You review the output at the end.

**What Claude does autonomously within a session:**
- Reads CLAUDE.md and the phase requirements
- Creates files, installs dependencies
- Writes implementation code
- Writes tests and runs them
- Fixes failing tests
- Commits at milestones (e.g. "Add Prisma schema and seed", "Add auth with NextAuth")
- Updates CLAUDE.md at the end
- Pushes to the branch

**When Claude SHOULD interrupt you:**
- Ambiguous requirements (e.g. "should promo codes stack?")
- Architecture decisions not covered in the plan
- External service setup needed (e.g. "I need your Stripe test API key")
- A persistent bug it can't resolve after 2-3 attempts

### Step 5: Security & Quality Checkpoints

After each phase is built, run a dedicated **review session** before moving to the next phase:

```
Read CLAUDE.md. Review Phase [N] code for:
1. Security vulnerabilities (OWASP top 10, input validation, auth bypass)
2. Business logic correctness (edge cases in pricing, bumping, availability)
3. Error handling (what happens when Stripe/Xero is down?)
4. Test coverage gaps
5. Code quality (duplication, unnecessary complexity)

Fix any issues found. Do NOT add features or refactor beyond what's needed.
Commit fixes and push.
```

### Step 6: Parallel Sub-Agents Within Sessions

Claude automatically uses sub-agents for independent work within a session. For example, during Phase 3 (Core Booking), Claude might:
- **Agent 1**: Build the availability calculator + tests
- **Agent 2**: Build the booking calendar UI component
- **Agent 3**: Research the best date-range picker library for the stack

These run in parallel, then Claude integrates the results. You don't need to orchestrate this - Claude decides when parallelism helps.

### Recommended Session Sequence

| Session | Phase | Prompt | Duration |
|---------|-------|--------|----------|
| 1 | Foundation | "Build Phase 1: Foundation" | ~30-45 min |
| 1R | Review | "Review Phase 1 for security and correctness" | ~15 min |
| 2 | Seasons & Pricing | "Build Phase 2: Seasons & Pricing" | ~20 min |
| 3 | Core Booking | "Build Phase 3: Core Booking" | ~45 min |
| 3R | Review | "Review Phases 2-3 for security and correctness" | ~15 min |
| 4 | Payments | "Build Phase 4: Stripe Payments" | ~30 min |
| 4R | Review | "Review Phase 4 - payment security is critical" | ~15 min |
| 5 | Non-Member + Bumping | "Build Phase 5: Non-Member Guests & Bumping" | ~30 min |
| 5R | Review | "Review Phase 5 bumping logic edge cases" | ~15 min |
| 6 | Xero Integration | "Build Phase 6: Xero Integration" | ~30 min |
| 7 | Promo Codes | "Build Phase 7: Promo Codes & Discounts" | ~20 min |
| 8 | Chore Roster | "Build Phase 8: Chore Roster" | ~30 min |
| 8R | Review | "Full security and integration review of all phases" | ~20 min |
| 9 | Polish | "Build Phase 9: Polish & Production Hardening" | ~30 min |

**Total: ~15 sessions, mostly hands-off.** You review output between sessions and provide any missing info (API keys, domain name, etc).

### What You Need to Provide (Once, Before Starting)

Before Phase 1, gather these. Claude will ask for them when needed but having them ready avoids interruptions:

1. **Domain name** for the booking system
2. **Stripe account** - sign up at stripe.com, get test API keys from dashboard
3. **Xero app** - register at developer.xero.com, get client ID and secret
4. **AWS SES** - verify your sending domain in SES console (or use Resend as alternative - simpler setup)
5. **Lightsail instance** - provision a 2GB Ubuntu 24.04 instance, attach a static IP, note the IP address
6. **Club logo** (optional) - PNG/SVG for the booking site header

### Recovery: When Things Go Wrong

If a session produces broken code:
```
Read CLAUDE.md. The last session left the build in a broken state.
Run `npm run build` and `npm test` to see what's failing.
Fix all errors without changing working functionality.
Commit and push when green.
```

If you want to restart a phase from scratch:
```
Read CLAUDE.md. Revert Phase [N] commits and rebuild Phase [N]
from the beginning using a different approach for [specific issue].
```

### Hooks for Auto-Formatting (Optional)

Add to `.claude/settings.json` to auto-format code after every edit:

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Edit",
        "hooks": [
          {
            "type": "command",
            "command": "npx prettier --write \"$CLAUDE_FILE_PATH\" 2>/dev/null || true"
          }
        ]
      },
      {
        "matcher": "Write",
        "hooks": [
          {
            "type": "command",
            "command": "npx prettier --write \"$CLAUDE_FILE_PATH\" 2>/dev/null || true"
          }
        ]
      }
    ]
  }
}
```

---

## Build Progress

### Phase 1: Foundation - COMPLETED

**Date:** 2026-04-03

**What was built:**
- Next.js 15 + TypeScript + Tailwind CSS v4 + shadcn/ui components
- Full Prisma schema (15 models, all enums, indexes, relations) with Prisma 6
- Database seed script (7 rooms / 29 beds, cancellation policies, chore templates, admin user)
- NextAuth v5 (beta) with credentials provider (email + password, JWT sessions)
- User registration with Zod validation, bcrypt hashing, age tier computation
- Password reset flow (forgot password -> email token -> reset)
- Member profile page (view/edit name, phone, DOB)
- Admin layout with sidebar navigation
- Admin members list page with search and filtering
- Member dashboard with placeholder cards
- Navigation bar with responsive mobile menu
- Docker Compose (postgres + app + caddy) + Dockerfile + Caddyfile
- Email utility (AWS SES via nodemailer, dev mode logs to console)
- Unit tests: age tier computation, season year calculation (11 tests, all passing)

**Key files:**
- `prisma/schema.prisma` - Full database schema
- `prisma/seed.ts` - Seed script
- `src/lib/auth.ts` - NextAuth configuration
- `src/lib/prisma.ts` - Prisma singleton client
- `src/lib/email.ts` - Email transport and templates
- `src/lib/age-tier.ts` - Age tier and season year computation
- `src/app/(public)/` - Login, register, forgot/reset password pages
- `src/app/(authenticated)/` - Dashboard, profile (layout with auth guard)
- `src/app/(admin)/` - Admin dashboard, members list (layout with admin guard)
- `docker-compose.yml`, `Dockerfile`, `Caddyfile` - Deployment config

**How to run:**
```bash
# Install dependencies
npm install --legacy-peer-deps

# Generate Prisma client
npx prisma generate

# Run development server
npm run dev

# Run tests
npm test

# Build for production
npm run build

# With Docker (requires Docker Compose):
docker compose up -d

# Seed database (requires running PostgreSQL):
npm run db:seed
```

**Default admin user (from seed):**
- Email: admin@tac.org.nz
- Password: admin123

**What's next: Phase 2 - Seasons & Pricing**
1. Admin UI: create/edit seasons (name, type, start/end dates)
2. Admin UI: set rates per season (6 rates per season: 3 age tiers x member/non-member)
3. Admin UI: cancellation policy configuration
4. Pricing engine with unit tests
5. Seed initial seasons and rates
