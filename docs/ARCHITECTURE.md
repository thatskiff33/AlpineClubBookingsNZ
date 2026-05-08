# TACBookings — Architecture Reference

> This document covers project structure, database schema, business logic, and integrations in detail.
> For day-to-day operational instructions see `CLAUDE.md`.

---

## Project Structure

```
TACBookings/
├── prisma/
│   ├── schema.prisma              # Single source of truth for DB
│   └── seed.ts                    # Seed rooms, default chores
├── src/
│   ├── app/
│   │   ├── layout.tsx             # Root layout with auth provider
│   │   ├── api/
│   │   │   ├── auth/[...nextauth]/route.ts
│   │   │   ├── bookings/          # Create, list, cancel, modify bookings
│   │   │   ├── availability/      # Bed availability check
│   │   │   ├── payments/          # PaymentIntent, SetupIntent, charge
│   │   │   ├── webhooks/          # Stripe + Xero webhook handlers
│   │   │   ├── cron/              # Manual cron trigger endpoints
│   │   │   ├── promo-codes/       # Validate promo codes
│   │   │   └── admin/             # All admin API routes (see below)
│   │   ├── (public)/              # No auth: login, register, reset password
│   │   ├── (authenticated)/       # Member pages: dashboard, book, bookings, profile
│   │   └── (admin)/               # Admin pages: all management + reports
│   ├── lib/                       # Business logic (see below)
│   ├── instrumentation.ts         # Sentry init + all cron job scheduling
│   └── components/
│       ├── ui/                    # shadcn/ui components
│       └── ...                    # Feature components
├── docs/                          # Reference documentation
├── docker-compose.yml
├── Dockerfile
├── Caddyfile
├── .env.example
└── package.json
```

### Admin API Routes (`src/app/api/admin/`)
age-tier-settings, audit-log, booking-policies, bookings, chores, committee, communications, deletion-requests, family-groups, family-suggestions, health, hut-leaders, lodge, member-applications, members, notifications, payments, promo-codes, refund-requests, reports, roster, seasons, subscriptions, waitlist, xero

### Key lib/ Modules
| Module | Purpose |
|--------|---------|
| `pricing.ts` | Rate calculation engine |
| `capacity.ts` | Bed availability calculation |
| `cancellation.ts` / `cancellation-rules.ts` | Refund calculation |
| `bumping.ts` | Non-member last-booked-first bumping |
| `waitlist.ts` / `cron-waitlist.ts` | Waitlist FIFO + offer expiry |
| `promo.ts` | Promo code validation & redemption |
| `chore-allocator.ts` | Auto-suggest chore roster |
| `age-tier.ts` / `cron-age-up.ts` | Age tier computation + season ageing |
| `member-credit.ts` | Account credit (hold refunds as credit) |
| `nomination.ts` | Membership nomination workflow |
| `booking-policies.ts` | Minimum stay + booking rules |
| `booking-cancel.ts` | Shared cancellation service |
| `xero.ts` + `xero-*.ts` | Operational Xero OAuth2, sync, reconciliation, cache |
| `finance-*.ts` | Finance access, finance Xero boundary, snapshots, sync, and report models |
| `stripe.ts` | Stripe client + helpers |
| `email.ts` / `email-templates.ts` | AWS SES transactional emails |
| `email-suppression.ts` / `/api/webhooks/ses-sns` | SES bounce/complaint feedback and recipient suppression |
| `audit.ts` | Audit logging helper |
| `backup.ts` | Automated pg_dump to S3 |
| `rate-limit.ts` | In-memory rate limiter |
| `kiosk-access.ts` / `lodge-auth.ts` | Lodge kiosk PIN auth |
| `report-pdf.ts` | Server-side PDF generation for reports |
| `health-check.ts` | DB/Stripe/Xero/SMTP health probes |

---

## Database Schema

Full source of truth: `prisma/schema.prisma`. Key entities below.

### Core Entities

**Member**
```
id, email, passwordHash, firstName, lastName, dateOfBirth, phone
role: MEMBER | ADMIN
ageTier: INFANT | CHILD | YOUTH | ADULT  (computed at season start Apr 1)
xeroContactId, active, parentMemberId (nullable self-FK for dependents)
address fields (street, city, postcode, region, country)
inheritEmailFromId (for dependents — must point to a primary adult using their own email)
familyGroupId (legacy nullable FK, preserved for backwards compatibility)
```

**MemberSubscription** — Annual season subscription from Xero
```
id, memberId, seasonYear (e.g. 2025 = Apr 2025–Mar 2026)
status: NOT_INVOICED | UNPAID | PAID | OVERDUE, xeroInvoiceId, paidAt
```

**MemberCredit** — Ledger entries for account credit (positive = added, negative = spent)
```
id, memberId, amountCents (positive = credit added, negative = credit used)
type (CreditType), description
sourceBookingId (cancellation that generated the credit)
appliedToBookingId (booking where credit was spent), xeroCreditNoteId
```

**Season / SeasonRate**
```
Season: id, name, type: WINTER | SUMMER, startDate, endDate, active
SeasonRate: id, seasonId, ageTier (INFANT|CHILD|YOUTH|ADULT), isMember, pricePerNightCents
```

**Booking / BookingGuest**
```
Booking: id, memberId, checkIn, checkOut, notes
  status: DRAFT | PENDING | CONFIRMED | PAID | BUMPED | CANCELLED | COMPLETED | WAITLISTED | WAITLIST_OFFERED
  totalPriceCents, discountCents, finalPriceCents, hasNonMembers, nonMemberHoldUntil
  waitlistPosition, waitlistOfferedAt, waitlistOfferExpiresAt
  expectedArrivalTime (for kiosk)
BookingGuest: id, bookingId, firstName, lastName, ageTier, isMember, memberId, priceCents
```
Note: DRAFT expires 72h. PAID set for $0 bookings. COMPLETED set by daily cron after checkout.

**BookingModification** — Audit trail for guest/date changes
```
id, bookingId, changedBy, changeType, previousValue, newValue, changeFeeCents
```

**Payment**
```
id, bookingId (unique), amountCents, stripePaymentIntentId (unique)
stripePaymentMethodId, xeroInvoiceId (unique)
status: PENDING | PROCESSING | SUCCEEDED | FAILED | REFUNDED | PARTIALLY_REFUNDED
refundedAmountCents, changeFeeCents
```

**RefundRequest** — Member-submitted refund appeals
```
id, bookingId, memberId, reason, requestedAmountCents (optional)
status: PENDING | APPROVED | REJECTED
adminNotes, approvedAmountCents, reviewedBy, reviewedAt
```

**PromoCode / PromoRedemption / PromoCodeAssignment**
```
PromoCode: type (PERCENTAGE|FIXED_AMOUNT|FREE_NIGHTS), valueCents, percentOff, freeNights
  maxRedemptions, currentRedemptions, validFrom, validUntil, membersOnly, singleUse
PromoRedemption: promoCodeId, bookingId (unique), memberId, discountCents
PromoCodeAssignment: promoCodeId, memberId (member-specific code assignment)
```

**ChoreTemplate / ChoreAssignment**
```
ChoreTemplate: name, description, recommendedPeople, minAge, ageRestriction, isEssential
ChoreAssignment: choreTemplateId, bookingId, bookingGuestId, date, status (SUGGESTED|CONFIRMED|COMPLETED)
GuestChoreToken: one-time token for guest self-serve chore updates
```

**FamilyGroup / FamilyGroupMember / FamilyGroupJoinRequest**
```
FamilyGroup: id, name, primaryMemberId
FamilyGroupMember: familyGroupId, memberId (join table; members can be in multiple groups)
FamilyGroupJoinRequest: invitee email + token flow
```

**MinimumStayPolicy**
```
id, seasonType (WINTER|SUMMER|ALL), minNights, appliesFrom, appliesTo
```

**GroupDiscountSetting**
```
id, minGuests, discountPercent, active
```

**HutLeaderAssignment**
```
id, memberId, date, notes, status (SUGGESTED|CONFIRMED)
```

**MemberApplication / NominationToken**
```
MemberApplication: applicant details, nominators (2 required), status: PENDING|APPROVED|REJECTED
NominationToken: one-time token sent to nominator to confirm nomination
```

**CommitteeMember** — Public committee page content
```
id, name, role, bio, photoUrl, displayOrder
```

**IssueReport** — In-stay issue reporting from kiosk
```
id, bookingId, description, category, resolvedAt
```

**Xero-related tables:**
`XeroToken`, `XeroAccountMapping`, `XeroItemCodeMapping`, `XeroObjectLink`, `XeroAdminCache`, `XeroContactCache`, `XeroContactGroupCache`, `XeroContactGroupMembershipCache`, `XeroSyncCursor`, `XeroSyncOperation`, `XeroInboundEvent`, `XeroApiUsageDaily`, `XeroApiUsageEvent`

**Finance-related tables:**
`FinanceXeroToken`, `FinanceSyncRun`, `FinanceSnapshot`, `FinanceXeroApiUsageDaily`, `FinanceXeroApiUsageEvent`; finance access is controlled by `Member.financeAccessLevel` (`NONE`, `VIEWER`, `MANAGER`).

**Infrastructure/Ops tables:**
`AuditLog`, `CronJobRun`, `EmailLog`, `NotificationPreference`, `WebhookLog`, `ProcessedWebhookEvent`, `PasswordResetToken`, `EmailVerificationToken`, `EmailChangeToken`, `DeletionRequest`, `BookingDefaults`, `BookingPeriod`, `AgeTierSetting`, `CancellationPolicy`

---

## Core Business Logic

### 1. Booking Flow
1. Member selects dates on availability calendar
2. System shows available beds (29 minus confirmed guests per night in range)
3. Minimum stay policy checked (e.g. 2 nights in winter peak)
4. Member adds themselves + guests (name, age tier, member/non-member)
5. System calculates price: SeasonRate for each guest's ageTier + isMember for each night; group discount applied if minGuests threshold met
6. Member optionally applies promo code, then account credit (MemberCredit ledger entries)
7. **If all guests are members OR checkIn ≤ 7 days away**: status = CONFIRMED, collect Stripe payment immediately
8. **If any guest is non-member AND checkIn > 7 days away**: status = PENDING, collect card via SetupIntent (no charge yet), set `nonMemberHoldUntil = checkIn - 7 days`
9. **If capacity exceeded on any night**: return 409 with `canWaitlist: true`; member can re-submit with `waitlist: true` (status = WAITLISTED, no payment)

### 2. Non-Member Priority Bumping (Last Booked = First Bumped)
When a member booking would fill the lodge past 29 beds on any night:
1. Find all PENDING bookings overlapping those nights
2. Sort by `createdAt DESC` (most recent first)
3. Bump one at a time until capacity restored
4. Each bumped booking: status = BUMPED, promo redemption cleaned up, notification sent

Concurrency guardrail:
- Capacity-sensitive booking, waitlist, force-confirm, and payment-intent writes share the same `pg_advisory_xact_lock(1)` inside the transaction.
- This intentionally serializes overlapping lodge-capacity decisions at current scale so overlapping date ranges cannot both consume the same beds.
- External payment and Xero calls are kept outside the lock-scoped transaction where possible to avoid holding the lock during network I/O.

### 3. Pending Booking Confirmation (Cron — every 3 hours)
1. Find PENDING bookings where `nonMemberHoldUntil <= now()`
2. Atomic claim (`updateMany WHERE status=PENDING`) before charging
3. Beds available + payment method saved → charge card, confirm, Xero invoice, email
4. No beds → bump + email

### 4. Pricing Engine
- For each night: determine Season, look up SeasonRate for guest's ageTier + isMember
- Group discount applied at booking level if minGuests threshold met
- All prices as integer cents
- Promo: FREE_NIGHTS (subtract cheapest N nights), PERCENTAGE (% off total), FIXED_AMOUNT (flat $ off)
- Account credit applied after promo discount

### 5. Cancellation & Refunds
- Admin-configurable policy: e.g. 14+ days = 100% refund, 7–14 days = 50%, <7 days = 0%
- Members cancel from booking detail page; if refund > $0, choose Stripe refund or account credit
- Stripe refund processed, Xero credit note created, promo redemption cleaned up
- Members can submit RefundRequest for out-of-policy appeals; admin reviews in admin panel

### 6. Waitlist
- WAITLISTED/WAITLIST_OFFERED bookings do NOT count toward capacity
- FIFO ordering by `createdAt ASC`; offer only when full date range has capacity
- 48h offer window (configurable via `WAITLIST_OFFER_HOURS`); no payment until confirmed
- Offer expiry handled by `cron-waitlist.ts` (every 30 min)

### 7. Chore Roster
- Admin configures chore templates (name, people count, min age, age restriction)
- Auto-suggests assignments via round-robin (4-day history lookback, occupancy scaling)
- Hut leader reviews, reassigns, confirms; printable A4 with `@media print`
- Guest chore tokens allow self-serve updates from kiosk

### 8. Membership Nomination Workflow
- New members submit MemberApplication with two nominator email addresses
- Nominators receive NominationToken via email; confirm via link
- Once both confirm, application goes to admin review
- Approval creates Member account + sends welcome email

### 9. Xero Integration (Bidirectional)
- **OAuth2:** Admin connects via admin panel; tokens encrypted with AES-256-GCM
- **Membership Verification:** Daily cron queries Xero invoices for subscription keywords, but only for members already linked to a `xeroContactId`; unlinked members remain `NOT_INVOICED` until linked
- **Booking Invoices:** On CONFIRMED + payment: find/create Contact, create Invoice with per-guest line items (item codes from XeroItemCodeMapping), record payment
- **Refund Sync:** Stripe refund → Xero credit note against original invoice
- **Inbound Reconciliation:** Xero webhook events stored as XeroInboundEvent, processed by 15-min cron safety net
- **Contact Sync:** Bidirectional — push member changes to Xero, pull contact updates back
- **Incremental Cache:** XeroContactCache/GroupCache for efficient sync without hammering API limits

### 10. Lodge Kiosk
- Separate PIN-based auth (`lodge-auth.ts`, `kiosk-access.ts`, `lodge-pin-session.ts`)
- 4 permission tiers: VIEW_ONLY, GUEST, HUT_LEADER, ADMIN
- Features: arrival display, expected arrival times, chore updates, issue reporting

### 11. Finance Dashboard
- Finance routes live under `/finance` and require explicit finance access through `Member.financeAccessLevel`; `ADMIN` alone does not grant finance visibility.
- `VIEWER` can read the landed finance workspace and reports. `MANAGER` can use manager-only finance actions such as Xero connection and manual sync controls.
- Finance Xero uses a separate OAuth app, token table, encryption key, tenant linkage, usage metering, and callback path from the operational Xero integration.
- Daily finance sync writes durable `FinanceSnapshot` rows for reporting datasets such as profit and loss, bank balances, and balance sheet data. Native booking reports use TACBookings booking/payment data directly.
- Finance report pages read stored snapshots or first-party booking data; normal report navigation does not make live Xero API calls.
- The legacy finance dashboard remains a fallback path until the rollout, freeze, and retirement runbooks in `docs/finance-dashboard/` are completed.

### 12. Token Storage
- Password reset, email verification, email change, and guest chore bearer tokens are stored as SHA-256 hashes in `tokenHash` columns.
- Incoming raw token values are hashed before lookup, so plaintext bearer tokens are not stored in the database after migration.
- Membership nomination tokens currently remain in their own `NominationToken` workflow and are not part of the hashed action-token migration documented in `docs/HASHED_TOKEN_MIGRATION.md`.

---

## Cron Job Schedule

| Job | Schedule | Purpose |
|-----|----------|---------|
| confirm-pending | Every 3 hours | Confirm PENDING bookings past hold date |
| waitlist | Every 30 min | Expire waitlist offers |
| email-retry | Every 30 min | Retry failed email sends |
| xero-retry | Every 15 min | Process queued Xero operation retries |
| xero-reconcile | Every 15 min | Process stored inbound Xero events |
| complete-bookings | Daily 1 AM | Mark past bookings COMPLETED |
| xero-membership | Daily 2 AM | Sync Xero membership invoices |
| xero-link-backfill | Daily 2:20 AM | Backfill Xero object links |
| data-pruning | Daily 3:30 AM | Prune expired auth/guest tokens plus old cron and webhook records |
| draft-cleanup | Daily 4 AM | Delete expired DRAFT bookings (72h TTL) |
| credit-reconciliation | Daily 5 AM | Reconcile member credit balances |
| hut-leader-auto-assign | Daily 6 AM | Auto-suggest hut leaders |
| age-up | Daily 6:30 AM | Age-up members who have turned 18 |
| capacity-warnings | Daily 7 AM | Alert admin when lodge near capacity |
| admin-digest | Daily 7:30 AM | Daily admin summary email |
| pending-deadline-alerts | Daily 8 AM | Alert admin on approaching PENDING deadlines |
| checkin-reminders | Daily 9 AM | Pre-arrival reminder emails |
| feedback-requests | Daily 10 AM | Post-stay feedback request emails |
| backup | Configurable | pg_dump to S3 |

---

## Email Notifications

| Event | Recipient |
|-------|-----------|
| Registration | New member |
| Email verification | Member |
| Password reset | Member |
| Email change confirmation | Member |
| Booking confirmed | Booking member |
| Booking pending (non-member hold) | Booking member |
| Pending → confirmed | Booking member |
| Booking bumped | Booking member |
| Booking cancelled | Booking member |
| Booking modification | Booking member |
| Check-in reminder | Booking member |
| Post-stay feedback request | Booking member |
| Waitlist confirmation | Booking member |
| Waitlist offer (spot opened) | Booking member |
| Waitlist offer expired | Booking member |
| Chore roster | All guests for date |
| Nomination request | Nominator |
| Admin: new booking | Admin |
| Admin: capacity warning | Admin |
| Admin: pending approaching deadline | Admin |
| Admin: waitlist offer made | Admin |
| Admin: daily digest | Admin |
| Admin: Xero error alert | Admin |
| Bulk communications | Selected members |
| Deletion request confirmation | Member |

---

## Deployment (AWS Lightsail)

**Instance:** 4 GB RAM, 2 vCPUs, 80 GB SSD, Ubuntu 24.04 LTS.

**Docker Compose services:** `caddy` (reverse proxy, auto HTTPS), `app` (cron leader and warm fallback upstream), `app_blue` / `app_green` (blue/green web slots), `postgres` (PostgreSQL 16 on port 5432), `migrate` (Prisma migration runner).

**Deploy process:**
```bash
./scripts/run-production-blue-green-deploy.sh
```

**Current deploy behavior:** `scripts/run-production-blue-green-deploy.sh` is the single supported production entrypoint. It snapshots the resolved `origin/main` commit into a clean workspace under `~/tacbookings-deployments/`, copies the production `.env`, preserves the live Caddy upstream state, invokes the low-level `scripts/blue-green-deploy.sh` runner there, then fast-forwards the clean `~/TACBookings` checkout to the deployed commit and prunes stale deploy workspaces after success.

**Blue/green guidance:** The blue/green path keeps Postgres shared, runs cron only on `app`, and keeps `app_blue` / `app_green` web-only by setting `CRON_ENABLED=false` on the color services. Caddy routes to the active color first and `app` second using readiness checks on `/api/health/ready`. During cutover, the previous color is kept running until the public domain verifies against the target color and the drain period ends. After a successful cutover, the non-target web-slot containers are removed so old code cannot continue running outside the active slot. Prisma changes must follow the expand-contract policy in `docs/BLUE_GREEN_MIGRATION_POLICY.md` so old and new app versions can overlap safely during cutover. The deploy runner validates pending migration SQL against `docs/BLUE_GREEN_MIGRATION_SAFETY.tsv`; hot-table migrations require a documented lock-impact plan, and potentially breaking migrations also require explicit operator acknowledgement through `ALLOW_BREAKING_BLUE_GREEN_MIGRATIONS=1` plus `BLUE_GREEN_MIGRATION_OVERRIDE_REASON`. The low-level runner also supports `SKIP_APP_IMAGE_BUILD=1` when operators intentionally want to reuse existing app images.

**Backups:** Lightsail snapshots + daily pg_dump to S3 (env vars: `BACKUP_ENABLED`, `BACKUP_S3_BUCKET`, `BACKUP_S3_REGION`, `BACKUP_S3_ACCESS_KEY_ID`, `BACKUP_S3_SECRET_ACCESS_KEY`, `BACKUP_RETENTION_DAYS`, `BACKUP_CRON_SCHEDULE`).

**Environment variables:** See `.env.example` for full list. Key vars:
- `DATABASE_URL`, `AUTH_SECRET`, `NEXTAUTH_SECRET`, `NEXTAUTH_URL`
- `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`
- `XERO_CLIENT_ID`, `XERO_CLIENT_SECRET`, `XERO_ENCRYPTION_KEY`
- `FINANCE_XERO_CLIENT_ID`, `FINANCE_XERO_CLIENT_SECRET`, `FINANCE_XERO_REDIRECT_URI`, `FINANCE_XERO_ENCRYPTION_KEY`
- `SMTP_HOST`, `SMTP_PORT`, `AWS_SES_ACCESS_KEY_ID`, `AWS_SES_SECRET_ACCESS_KEY`, `SES_SNS_TOPIC_ARN`, `EMAIL_FROM`
- `NEXT_PUBLIC_SENTRY_DSN`, `SENTRY_AUTH_TOKEN`

**Stripe:** Live keys in production (since 2026-04-08). Use test mode for development.
**Xero:** Connected to production org. Test against demo org for risky changes.
