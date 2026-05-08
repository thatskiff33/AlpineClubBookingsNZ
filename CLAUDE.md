# TACBookings

## How to Run

```bash
npm ci
npx prisma generate
npm test              # run all tests
npm run build         # must succeed before any PR
npm run dev           # development server

# Docker deployment:
./scripts/run-production-blue-green-deploy.sh  # supported production deploy path
docker compose up -d --build                   # local full-stack rebuild
docker compose build migrate                   # rebuild migrate image (has its own build block)
docker compose run --rm migrate                # run database migrations

# Seed database (requires running PostgreSQL):
npx prisma migrate dev --name initial
npm run db:seed
```

**Seed account:** support@tokoroa.org.nz / admin123 (password change required on first login)

**Note:** nodemailer is currently on v8. Auth.js/next-auth still declares an optional `nodemailer@^7` peer range, so `npm ls nodemailer next-auth` reports a known peer-range mismatch. The app uses credentials auth only; mail is sent through app-owned Nodemailer transports. See `docs/PRODUCTION_DEPENDENCY_AUDIT.md`.

## Context

Tokoroa Alpine Club (TAC) is a not-for-profit operating a 29-bed alpine lodge with ~410 members. This system replaces Checkfront with a bespoke booking + membership platform integrated with Xero (accounting) and Stripe (payments). No developers on the team — hosted on AWS Lightsail. The codebase is complete and live in production.

## Current State

All build phases complete (9-phase improvement sprint + 12 delivery phases + post-launch bugfix rounds). Security audit done. Stripe live since 2026-04-08. All tests pass, build succeeds.

**Features in production:** booking wizard + availability calendar, advisory lock concurrency, waitlist (FIFO, 48h offers), DRAFT/PENDING/CONFIRMED/PAID status flow, non-member 7-day hold + FIFO bumping, booking modifications, account credit system, promo codes (PERCENTAGE/FIXED_AMOUNT/FREE_NIGHTS), refund request appeals, group discounts, minimum stay policies, family groups (multi-membership via join table), INFANT/CHILD/YOUTH/ADULT age tiers, membership nomination workflow, chore roster (round-robin allocator + printable A4), hut leader management, lodge kiosk (PIN auth, 4 permission tiers), Xero bidirectional sync (invoices, contacts, credit notes, item codes, incremental cache), Stripe (PaymentIntents + SetupIntents + webhooks), AWS SES email (24+ event types + retry), admin panel (members, bookings, seasons, reports, audit log, health dashboard, bulk comms), Sentry + pino logging, pg_dump backups to S3.

> Full architecture reference: `docs/ARCHITECTURE.md` — project structure, DB schema, business logic, cron schedule, email events, deployment details.

## Tech Stack

| Layer | Choice | Rationale |
|-------|--------|-----------|
| **Framework** | Next.js 16 (App Router) | Full-stack TypeScript monolith |
| **Language** | TypeScript | Type safety |
| **Database** | PostgreSQL 16 | Robust relational DB |
| **ORM** | Prisma 6 | Type-safe DB access, declarative schema, auto migrations |
| **Auth** | NextAuth.js v5 (Auth.js) | Credentials provider (email+password), JWT sessions (8h) |
| **UI** | Tailwind CSS + shadcn/ui | Production-quality components |
| **Payments** | Stripe (PaymentIntents + SetupIntents) | Industry standard |
| **Accounting** | Xero API via `xero-node` SDK | Full bidirectional sync |
| **Email** | AWS SES via `nodemailer` | Transactional emails |
| **Deployment** | Docker Compose on Lightsail | Blue/green web deploy with cron-leader fallback |
| **Reverse Proxy** | Caddy 2 | Automatic HTTPS via Let's Encrypt |
| **Scheduled Jobs** | `node-cron` in `instrumentation.ts` | No external scheduler needed at this scale |

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
  - Sentry (error tracking)
```

## Key Design Decisions

These are active constraints — violating them introduces bugs:

- **All prices in cents as integers** — prevents float rounding bugs (e.g. $45.50 = 4550)
- **Timezone: Pacific/Auckland (NZST/NZDT)** — dates stored as date-only; bookings are per-night with no time component
- **JWT sessions (not database sessions)** — 8hr expiry; can't instantly revoke, acceptable at ~410 members
- **Capacity-based booking (not room-based)** — 29 beds total; members book beds, admin assigns rooms separately
- **Season year = April to March** — `if month >= April: seasonYear = currentYear; else: currentYear - 1`
- **Fixed advisory lock key** — `pg_advisory_xact_lock(1)` serializes all booking creation to prevent double-booking
- **Promo codes cleaned up on cancel/bump** — `PromoRedemption` deleted and `currentRedemptions` decremented
- **Age tiers computed at season start (Apr 1)** — tier is stable for the full season; INFANT/CHILD/YOUTH/ADULT; configurable via `AgeTierSetting`
- **DRAFT bookings expire after 72h** — excluded from default booking listing; no Stripe charge or Xero invoice until confirmed
- **$0 bookings skip Stripe** — `finalPriceCents=0` → status = PAID with SUCCEEDED Payment record; Xero invoice still created
- **Email inheritance for dependents** — `inheritEmailFromId` on Member; `getEffectiveEmail()` used for all sends so dependents receive email via parent's address
- **Waitlist is FIFO, capacity-exclusive** — `createdAt ASC` ordering; WAITLISTED/WAITLIST_OFFERED do NOT count toward capacity; 48h offer window (`WAITLIST_OFFER_HOURS`); full-range-only offers; no payment until confirmed
- **Account credit is a ledger** — `MemberCredit` rows are individual debit/credit entries (positive = added, negative = spent); no mutable balance field; reconciliation cron runs daily at 5 AM
- **Family multi-membership via join table** — `FamilyGroupMember` is the primary relationship; legacy `familyGroupId` FK on Member preserved as nullable fallback
- **Xero tokens encrypted at rest** — AES-256-GCM; retry queue (`XeroSyncOperation`) for transient failures; incremental contact/group cache to avoid API rate limits

## Verification & Testing

- **Unit tests**: Vitest — `npm test` runs all tests. New features must include tests in `src/lib/__tests__/`
- **Build**: `npm run build` must succeed before any PR
- **Stripe**: Live keys in production. Use test mode (`STRIPE_SECRET_KEY=sk_test_...`) for development
- **Xero**: Connected to production org. Test against demo org for risky changes

> Build history: `docs/BUILD_HISTORY.md` | Delivery history: `docs/DELIVERY_PHASE_HISTORY.md` | Architecture: `docs/ARCHITECTURE.md`
