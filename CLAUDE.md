# TACBookings - Build Plan

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
