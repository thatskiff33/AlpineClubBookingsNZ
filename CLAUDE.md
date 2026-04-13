# TACBookings

## How to Run

```bash
npm install
npx prisma generate
npm test              # 1258 tests pass (46 test files)
npm run build         # builds successfully
npm run dev           # development server

# Docker deployment:
docker compose up -d --build
docker compose build migrate       # rebuild migrate image (has its own build block)
docker compose run --rm migrate    # run database migrations

# Seed database (requires running PostgreSQL):
npx prisma migrate dev --name initial
npm run db:seed
```

**Seed account:**
- Admin: support@tokoroa.org.nz / admin123 (password change required on first login)

**Note:** nodemailer pinned to v7 for next-auth peer dep compatibility

## Active Build Plan — 9-Phase Improvement Sprint

There are 9 phases of improvements tracked as GitHub Issues #48–#56. **Work through them sequentially** (Phase 1 first, then 2, etc.) — each phase is one branch + one PR.

| Phase | Issue | Title | Status |
|-------|-------|-------|--------|
| 1 | #48 | Bug Fixes & Quick Wins | NOT STARTED |
| 2 | #49 | Booking List & Calendar Enhancements | NOT STARTED |
| 3 | #50 | Family Groups & INFANT Age Tier | NOT STARTED |
| 4 | #51 | Member Address & Dependent Management | NOT STARTED |
| 5 | #52 | Pricing, Promos & Cancellation | NOT STARTED |
| 6 | #53 | Xero Item Codes & Entrance Fees | NOT STARTED |
| 7 | #54 | Membership Nomination Workflow | NOT STARTED |
| 8 | #55 | Hut Leader & Kiosk Improvements | COMPLETE |
| 9 | #56 | Reports & Analytics Enhancements | NOT STARTED |

**To work on a phase:**
1. Read the GitHub issue: `gh issue view <number>`
2. Create branch: `git checkout -b phase-N-<name>`
3. Implement all items in the issue
4. Run `npm test` (all tests must pass) + `npm run build` (must succeed)
5. Add new tests in `src/lib/__tests__/` for new functionality
6. Create PR: `gh pr create` referencing "Closes #<issue>"
7. **Update this table** to mark the phase as COMPLETE after merge

**Dependencies:** Phases 1–3 are independent. Phase 7 depends on Phase 4 (addresses) and Phase 6 (entrance fees). All others are sequential by convention, not hard dependency.

**Detailed plan file:** `.claude/plans/moonlit-gathering-reddy.md` has implementation details, file paths, and line numbers for each item.

## Current State

All 9 build phases + all Delivery Phases (1–12) + post-launch bugfix rounds complete. Security audit + 5 integration reviews done. Waitlist feature added. 1258 tests pass, build succeeds.

**What works today:**
- **Auth**: login, register, password reset, JWT sessions (8h), admin role guard, email verification, email change with verification
- **Booking**: availability calendar, wizard with family quick-add, pricing engine, advisory lock concurrency, waitlist (FIFO, 48h offers), DRAFT status (72h expiry), booking modifications (dates, guests), booking notes
- **Payments**: Stripe PaymentIntents/SetupIntents, webhook handler, policy-based refunds, $0 bookings skip Stripe, modification payment collection
- **Non-member flow**: PENDING status, 7-day hold, cron auto-confirm, FIFO bumping
- **Xero**: OAuth2, encrypted tokens, invoices, credit notes, contact sync, membership verification, phone sync, configurable account mappings
- **Promo codes**: PERCENTAGE/FIXED_AMOUNT/FREE_NIGHTS, member-assigned codes, validation, redemption tracking
- **Chore roster**: round-robin allocator, admin review, printable A4, hut leader wizard, guest chore tokens, time-of-day/frequency
- **Family**: multi-group membership (FamilyGroupMember join table), email inheritance (inheritEmailFromId), dependent management
- **Admin**: seasons CRUD, cancellation policy, members (paginated, CSV import/export, bulk ops, detail edit), bookings with filters, reports (recharts), subscriptions, payments, audit log, health dashboard, communications, deletion requests, hut leaders, age tiers
- **Notifications**: EmailLog tracking, check-in reminders, 8+ admin alert types, preferences, retry with backoff, daily digest, bulk communication, feedback requests, waitlist emails
- **Infrastructure**: security headers, rate limiting, audit logging, pg_dump backups, Sentry, pino logging, Docker log rotation, Caddy auto-HTTPS
- **Content pages**: about, committee, join, FAQ, rules, contact, privacy, terms
- **Age tiers**: configurable via `AgeTierSetting` model; default CHILD <10, YOUTH 10–17, ADULT 18+; computed at season start (Apr 1)
- **Status colors**: centralized `src/lib/status-colors.ts`; unique color per booking/payment/subscription status

> Delivery phase history: see `docs/DELIVERY_PHASE_HISTORY.md`. All 12 phases + bugfix rounds + waitlist COMPLETED.

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
│   │   ├── webhook-log.ts         # Webhook delivery monitoring
│   │   ├── waitlist.ts            # Waitlist FIFO queue logic
│   │   └── cron-waitlist.ts       # Waitlist offer expiry cron
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

**Member** - Club members who can log in and book (or dependents managed by a parent)
```
id, email (unique among primary members), passwordHash, firstName, lastName, dateOfBirth, phone
role: MEMBER | ADMIN, ageTier: ADULT | YOUTH | CHILD (computed from DOB)
xeroContactId, active, parentMemberId (nullable self-FK for dependents), timestamps
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
Booking: id, memberId, checkIn, checkOut, notes
  status (DRAFT|PENDING|CONFIRMED|PAID|BUMPED|CANCELLED|COMPLETED|WAITLISTED|WAITLIST_OFFERED)
  totalPriceCents, discountCents, finalPriceCents, hasNonMembers, nonMemberHoldUntil
  waitlistPosition, waitlistOfferedAt, waitlistOfferExpiresAt
BookingGuest: id, bookingId, firstName, lastName, ageTier, isMember, memberId, priceCents
```
Note: DRAFT bookings expire 72h after creation. PAID is set for $0 bookings (no Stripe charge).

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

**Other:** CancellationPolicy, XeroToken, ProcessedWebhookEvent, AuditLog, Room, PasswordResetToken, AgeTierSetting, FamilyGroupMember, HutLeaderAssignment, GuestChoreToken, EmailLog, NotificationPreference, WebhookLog, CronJobRun, BookingModification, EmailVerificationToken, EmailChangeToken, DeletionRequest, XeroAccountMapping

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
8. **If capacity exceeded on any night**: return 409 with `canWaitlist: true`; member can re-submit with `waitlist: true` to join FIFO waitlist (status = WAITLISTED, no payment collected)

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
| Admin: new booking | Admin | Implemented |
| Admin: capacity warning | Admin | Implemented |
| Admin: pending approaching deadline | Admin | Implemented |
| Waitlist confirmation | Booking member | Implemented |
| Waitlist offer (spot opened) | Booking member | Implemented |
| Waitlist offer expired | Booking member | Implemented |
| Admin: waitlist offer made | Admin | Implemented |

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
- **Age tiers are configurable** - Default CHILD <10 / YOUTH 10–17 / ADULT 18+; admin can adjust via AgeTierSetting model; age is computed at season start (April 1) so tier is stable for the whole season
- **DRAFT bookings expire** - 72h TTL; excluded from default booking listing; no Stripe charge or Xero invoice created until confirmed
- **$0 bookings skip Stripe** - When finalPriceCents=0 (e.g. 100% promo), booking goes straight to PAID status with a SUCCEEDED Payment record; Xero invoice still created
- **Family multi-membership via join table** - FamilyGroupMember replaces familyGroupId FK; members can be in multiple groups; legacy FK preserved as fallback
- **Email inheritance for dependents** - inheritEmailFromId on Member; getEffectiveEmail() used for all notification sends so dependent members receive emails via parent's address
- **Waitlist uses FIFO ordering** - `createdAt ASC` determines queue position; WAITLISTED/WAITLIST_OFFERED bookings do NOT count toward capacity (only CONFIRMED/PAID/PENDING do); 48h offer window (configurable via `WAITLIST_OFFER_HOURS`); no payment collected until offer confirmed; full-range-only offers (all requested nights must have capacity)

## Verification & Testing

- **Unit tests**: Vitest — `npm test` runs all tests. New features must include tests in `src/lib/__tests__/`
- **Build**: `npm run build` must succeed before any PR
- **Stripe**: Live keys in production (since 2026-04-08). Test mode for development.
- **Xero**: Connected to production org. Test against demo org for risky changes.

> Build history: see `docs/BUILD_HISTORY.md` and `docs/DELIVERY_PHASE_HISTORY.md`
