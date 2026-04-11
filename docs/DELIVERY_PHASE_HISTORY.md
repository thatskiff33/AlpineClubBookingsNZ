# Delivery Phase History

Extracted from CLAUDE.md on 2026-04-11. This file contains the detailed build history for all 12 delivery phases, bugfix rounds, and the waitlist feature. For current state, see CLAUDE.md.

---

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

### Delivery Phase 7: Hut Leader Tools & Lodge Chore System - COMPLETED

**Date:** 2026-04-06
**Branch:** phase-7-lodge
**Tests:** 575 (was 411, +164 new across 4 sub-phases)

**Sub-phase 7a: Foundation**
1. **F1 - LODGE Role**: Added LODGE to Role enum, lodge account in seed, 30-day JWT for iPad, route guards
2. **F3 - Time-of-Day**: ChoreTimeOfDay enum (MORNING/EVENING/ANYTIME) on ChoreTemplate, allocator integration, grouped display
3. **F4 - Frequency Settings**: ChoreFrequencyMode (DAILY/EVERY_X_DAYS/SPECIFIC_DAYS), filterChoresByFrequency, admin UI
4. **F5 - Family Allocation**: Allocator family-grouping tie-breaker for same-booking guests

**Sub-phase 7b: Kiosk & Routing**
5. **F2 - iPad Kiosk Page**: /lodge/kiosk with lodge list and chore roster, touch-optimised, auto-refresh
6. **F7 - Arriving/Departing Routing**: isArriving/isDeparting flags, time-of-day eligibility filtering
7. **F11 - Frequency Lookback**: choreLastRosteredDates parameter, frequency-info API endpoint

**Sub-phase 7c: Guest Interaction**
8. **F9 - Guest Arrival/Departure**: completedAt/completedVia on ChoreAssignment, arrivedAt/departedAt on BookingGuest, kiosk toggle endpoints
9. **F6 - Hut Leader Wizard**: 4-step wizard at /lodge/roster/[date]/setup, generate/confirm/reassign APIs

**Sub-phase 7d: Hut Leader & Guest Links**
10. **F8 - Hut Leader Role Assignment**: HutLeaderAssignment model, admin CRUD UI at /admin/hut-leaders, isHutLeader date-scoped auth, lodge layout and all lodge API endpoints accept hut leaders, nav bar shows "Hut Leader" link for active assignments
11. **F10 - Per-Guest Chore Link**: GuestChoreToken model (48h expiry, crypto.randomBytes), public /chores/[token] page with completion toggle, /api/chores/[token] GET/PUT endpoints, roster email includes per-guest "Mark Chores Complete" link with completedVia: "GUEST_LINK"

**New files (7d):**
- `src/lib/hut-leader.ts` - isHutLeader and hasActiveHutLeaderAssignment helpers
- `src/lib/lodge-auth.ts` - Shared lodge auth check (LODGE/ADMIN/hut-leader)
- `src/lib/guest-chore-token.ts` - Token generation, creation, validation
- `src/app/api/admin/hut-leaders/route.ts` - GET/POST hut leader assignments
- `src/app/api/admin/hut-leaders/[id]/route.ts` - PUT/DELETE hut leader assignments
- `src/app/(admin)/admin/hut-leaders/page.tsx` - Hut leaders admin page
- `src/app/api/chores/[token]/route.ts` - Public guest chore token API
- `src/app/(public)/chores/[token]/page.tsx` - Public guest chore page
- `src/lib/__tests__/phase7d.test.ts` - 35 tests for F8 and F10

**New Prisma models (require migration):**
- `HutLeaderAssignment` - Date-scoped hut leader elevation (memberId, startDate, endDate)
- `GuestChoreToken` - Time-limited guest chore access (token, bookingGuestId, date, expiresAt)

**Modified files (7d):**
- `prisma/schema.prisma` - HutLeaderAssignment, GuestChoreToken models, relations on Member and BookingGuest
- `src/app/(lodge)/layout.tsx` - Now accepts MEMBER with active hut leader assignment
- `src/app/api/lodge/*/route.ts` - All 7 lodge API routes updated to use checkLodgeAuth (hut leader support)
- `src/components/admin-sidebar.tsx` - Added Hut Leaders nav entry
- `src/components/nav-bar.tsx` - Shows "Hut Leader" link for active assignments
- `src/app/(authenticated)/layout.tsx` - Passes isHutLeader to NavBar
- `src/lib/email-templates.ts` - choreRosterTemplate accepts optional choreLink
- `src/lib/email.ts` - sendChoreRosterEmail accepts optional choreLink
- `src/app/api/admin/roster/[date]/route.ts` - Generates GuestChoreToken per guest on roster email

### Delivery Phase 8: Booking Modifications - COMPLETED

**Date:** 2026-04-06
**Branch:** phase-8-booking-mods
**Tests:** 688 (was 575, +113 new across 4 sub-phases)

**Sub-phase 8a: Change Fee Calculation**
1. **FEE-02**: `calculateChangeFee()` in `src/lib/change-fee.ts` - late-notice fee based on cancellation tier transitions
2. **FEE-03**: Cancellation service updated to exclude change fees from refundable base
3. **MOD-05**: `POST /api/bookings/[id]/modify-quote` - read-only modification preview endpoint

**Sub-phase 8b: Booking Modification APIs & UI**
4. **MOD-01**: `PUT /api/bookings/[id]/modify-dates` - date change with capacity check, advisory lock, repricing, promo recalc, non-member hold update, Stripe refund/charge
5. **MOD-03**: `POST /api/bookings/[id]/guests` - add guests with capacity check, repricing
6. **MOD-04**: `DELETE /api/bookings/[id]/guests/[guestId]` - remove guest with repricing, Stripe refund
7. **UI-03**: Modification history card on booking detail page

**Sub-phase 8c: Integrations**
8. **CHR-01**: `cleanupChoreAssignmentsForDateChange()` in `src/lib/chore-cleanup.ts` - deletes SUGGESTED assignments for removed dates, warns about CONFIRMED/COMPLETED
9. **XER-01**: `createXeroSupplementaryInvoice()` and `createXeroCreditNoteForModification()` in `src/lib/xero.ts` - supplementary invoice for price increase, credit note for decrease, fire-and-forget
10. **EML-01**: `bookingModifiedTemplate` with old/new details, change fee display, `escapeHtml` on user values

**Sub-phase 8d: Modification UI**
11. **UI-01**: Change Dates dialog on booking detail page - date picker, availability check via modify-quote API, price/change fee preview, confirm calls modify-dates API, only visible for PENDING/CONFIRMED bookings with future check-in
12. **UI-02**: Manage Guests UI on booking detail page - Add Guest form with price impact preview via modify-quote, Remove Guest with confirmation dialog showing refund amount, only visible for PENDING/CONFIRMED bookings with future check-in

**New files:**
- `src/lib/change-fee.ts` - Late-notice change fee calculation
- `src/lib/chore-cleanup.ts` - Chore assignment cleanup for date changes
- `src/app/api/bookings/[id]/modify-dates/route.ts` - Date change API
- `src/app/api/bookings/[id]/modify-quote/route.ts` - Modification quote API
- `src/app/api/bookings/[id]/guests/route.ts` - Add guests API
- `src/app/api/bookings/[id]/guests/[guestId]/route.ts` - Remove guest API
- `src/components/change-dates-dialog.tsx` - Change Dates dialog component
- `src/components/manage-guests.tsx` - Manage Guests component (add/remove with quote previews)
- `src/lib/__tests__/phase8a-change-fee.test.ts` - Change fee tests
- `src/lib/__tests__/phase8b-booking-mods.test.ts` - Modification API tests
- `src/lib/__tests__/phase8c-integrations.test.ts` - Integration tests (CHR-01, XER-01, EML-01)
- `src/lib/__tests__/phase8d-ui.test.ts` - 24 tests for UI logic (canModify, quote handling, API contracts)

**Modified files:**
- `src/lib/xero.ts` - Added `createXeroSupplementaryInvoice`, `createXeroCreditNoteForModification`
- `src/lib/email-templates.ts` - Added `bookingModifiedTemplate`
- `src/lib/email.ts` - Added `sendBookingModifiedEmail`
- `src/lib/cancellation.ts` - Exclude change fees from refund base
- `src/app/(authenticated)/bookings/[id]/page.tsx` - Modification history UI, Change Dates button, Manage Guests UI

### Delivery Phase 10: Compliance & Public Content - COMPLETED

**Date:** 2026-04-07
**Branch:** phase-10-compliance
**Tests:** 783 (was 688, +95 new across 2 sub-phases)

**Sub-phase 10a: Public Pages (F-COMP-01, F-COMP-02, F-PUB-01 through F-PUB-04)**
- Privacy Policy page at `/privacy`, Terms of Service at `/terms`
- Committee page at `/committee` with data-file-driven content
- Join page at `/join` with membership fees from config
- Contact page at `/contact` with rate-limited contact form
- FAQ page at `/faq` with collapsible accordion from data file
- Footer and nav links updated

**Sub-phase 10b: Data Compliance (F-COMP-03, F-COMP-04)**
1. **F-COMP-03**: Personal data export — `GET /api/member/data-export` returns JSON with profile/bookings/guests/payments/promos/chores/subscriptions/audit log. Excludes passwordHash and internal IDs. Rate limited 5/day per member ID. `Content-Disposition: attachment` header with dated filename.
2. **F-COMP-04**: Account deletion workflow — `POST /api/member/request-deletion` creates a `DeletionRequest` (PENDING), admin page `/admin/deletion-requests` lists/approves/rejects. On approve: cancels future bookings with refunds, anonymises member record (name→"Deleted Member", email→random@deleted.invalid, phone/DOB cleared, passwordHash cleared, active=false), anonymises BookingGuest references, sends confirmation email before anonymisation. On reject: sends email with admin note. Admins blocked from self-deletion. Booking/payment/audit history retained.

**New files (10b):**
- `src/app/api/member/data-export/route.ts` - Personal data export API
- `src/app/api/member/request-deletion/route.ts` - Deletion request API
- `src/app/api/admin/deletion-requests/route.ts` - Admin list deletion requests
- `src/app/api/admin/deletion-requests/[id]/route.ts` - Admin approve/reject
- `src/app/(admin)/admin/deletion-requests/page.tsx` - Admin deletion requests page
- `src/app/(authenticated)/profile/data-export-button.tsx` - Download My Data button
- `src/app/(authenticated)/profile/delete-account-button.tsx` - Request deletion button with modal
- `src/lib/__tests__/phase10b.test.ts` - 30 tests for phase 10b

**New Prisma models (require migration):**
- `DeletionRequest` - Account deletion requests with PENDING/APPROVED/REJECTED status

**Modified files (10b):**
- `prisma/schema.prisma` - Added DeletionRequestStatus enum, DeletionRequest model, relation on Member
- `src/lib/rate-limit.ts` - Added dataExport (5/day) and deletionRequest (3/day) limiters
- `src/lib/email-templates.ts` - Added accountDeletionApprovedTemplate, accountDeletionRejectedTemplate
- `src/lib/email.ts` - Added sendAccountDeletionApprovedEmail, sendAccountDeletionRejectedEmail
- `src/app/(authenticated)/profile/page.tsx` - Added Privacy & Data section with both buttons
- `src/components/admin-sidebar.tsx` - Added Deletion Requests nav entry

### Delivery Phase 11: Xero Account Mapping Configuration - COMPLETED

**Date:** 2026-04-07
**Branch:** phase-11-xero-mapping
**Tests:** 805 (was 783, +22 new)

**Features built:**
1. **XAM-01**: `XeroAccountMapping` Prisma model — key/value store (keys: `hutFeesIncome`, `hutFeeRefunds`, `stripeBankAccount`, `stripeFees`, `subscriptionIncome`). Seeded with current defaults (200, 200, 606, null, 203).
2. **XAM-02**: `GET /api/admin/xero/chart-of-accounts` — fetches accounts from Xero API, 1-hour in-memory cache, returns `{code, name, type, class}` per account, admin-only.
3. **XAM-03**: Account Mappings section on `/admin/xero` page — dropdown selectors per mapping, filtered by account type (BANK/REVENUE/EXPENSE), save button, real-time account list from chart-of-accounts.
4. **XAM-04**: `GET/PUT /api/admin/xero/account-mappings` — read and update mappings, admin-only, audit logged.
5. **XAM-05**: `getAccountMapping(key)` exported helper in `src/lib/xero.ts` reads from DB with fallback to hard-coded defaults. All 5 hardcoded account codes refactored: `createXeroInvoiceForBooking`, `createXeroCreditNote`, `createXeroSupplementaryInvoice`, `createXeroCreditNoteForModification`, and `findSubscriptionInvoice` (now accepts optional `subscriptionAccountCode` parameter, backwards-compatible with tests).

**New files:**
- `src/app/api/admin/xero/account-mappings/route.ts` - GET/PUT account mappings API
- `src/app/api/admin/xero/chart-of-accounts/route.ts` - Chart of accounts API with 1-hour cache
- `src/lib/__tests__/phase11.test.ts` - 22 tests for XAM-01 through XAM-05

**New Prisma models (require migration):**
- `XeroAccountMapping` — key/value account code mappings with unique key constraint

**Modified files:**
- `prisma/schema.prisma` — Added XeroAccountMapping model
- `prisma/seed.ts` — Seeds 5 XeroAccountMapping records with defaults
- `src/lib/xero.ts` — Added `getAccountMapping()`, `ACCOUNT_MAPPING_DEFAULTS`, refactored all hardcoded account codes, added `subscriptionAccountCode` param to `findSubscriptionInvoice`, added `accountCode` param to `buildInvoiceLineItems`
- `src/app/(admin)/admin/xero/page.tsx` — Added Account Mappings card with filtered dropdowns

### Delivery Phase 2: Dashboard & Booking Notes - COMPLETED

**Date:** 2026-04-06
**Tests:** +10 new

**Features built:**
1. **Booking notes**: `PUT /api/bookings/[id]/notes` — members and admins can save freetext notes on a booking. HTML tags stripped server-side. Max 500 characters (Zod validation). Owner or ADMIN only.

**New files:**
- `src/app/api/bookings/[id]/notes/route.ts` - Booking notes API
- `src/lib/__tests__/phase2-dashboard.test.ts` - 10 tests

### Delivery Phase 3: Admin Member Management - COMPLETED

**Date:** 2026-04-06
**Tests:** +51 new (32 + 19 across 2 sub-phases)

**Features built:**
1. **A1/A11 - Pagination & Sorting**: `GET /api/admin/members` supports `page`, `pageSize` (max 100), `sortBy`, `sortDir`; returns `{total, totalPages, page, pageSize, members}`.
2. **A2 - Advanced Filtering**: filter by `role`, `active`, `type` (primary/dependent), `subscriptionStatus` (including NONE for no record), free-text search (name/email AND logic).
3. **A3 - CSV Export**: `GET /api/admin/members/export` streams CSV with all filter params applied; correct `Content-Disposition` header; special chars escaped.
4. **A4 - CSV Import**: `POST /api/admin/members/import` — validates required fields, detects intra-file duplicate emails, skips already-existing DB emails, all-or-nothing Prisma transaction.
5. **A5/A6 - Bulk Operations**: `POST /api/admin/members/bulk-update` — bulk deactivate or set-role; guards against self-demotion/self-deactivation; all changes audit-logged in transaction.
6. **A8 - Member Detail**: `GET /api/admin/members/[id]` returns member with booking history, aggregate stats, and recent audit log entries.
7. **A8 - Member Detail Edit**: `PUT /api/admin/members/[id]` — edit name, email (conflict check), role, DOB (recomputes ageTier), active (cascades to dependents), forcePasswordChange; updates Xero contact if connected.

**New files:**
- `src/app/api/admin/members/export/route.ts` - CSV export
- `src/app/api/admin/members/import/route.ts` - CSV import
- `src/app/api/admin/members/bulk-update/route.ts` - Bulk operations
- `src/app/api/admin/members/[id]/route.ts` - Member detail GET/PUT
- `src/app/(admin)/admin/members/[id]/page.tsx` - Member detail admin page
- `src/lib/__tests__/phase3-admin-members.test.ts` - 32 tests
- `src/lib/__tests__/phase3b-member-detail-edit.test.ts` - 19 tests

**Modified files:**
- `src/app/api/admin/members/route.ts` - Added pagination, sorting, advanced filtering

### Delivery Phase 12: Xero Phone Number Sync - COMPLETED

**Date:** 2026-04-06

**Features built:**
1. **XPH-01/XPH-02 - Phone read helpers**: `formatXeroPhone()` assembles Xero's split `phoneCountryCode`/`phoneAreaCode`/`phoneNumber` fields into a single formatted string (e.g. `"+64 27 4224115"`). `getXeroContactPhone()` finds the best number from a contact's phones array (prefers MOBILE type).
2. **XPH-03 - Phone backfill in sync**: `syncContactsFromXero()` now backfills `phone` from Xero for already-linked contacts that have a null phone in the DB, using `getXeroContactPhone()`.

**Modified files:**
- `src/lib/xero.ts` - Added `formatXeroPhone`, `getXeroContactPhone`, phone backfill in `syncContactsFromXero` (both already-linked and email-match branches)

### Bugfix: Zero-Dollar Payments - COMPLETED

**Date:** 2026-04-07
**Tests:** +25 new (`src/lib/__tests__/zero-dollar-booking.test.ts`)

- Booking creation: $0 CONFIRMED bookings skip Stripe PaymentIntent, create SUCCEEDED Payment + PAID booking status in same transaction
- Cron confirm-pending: $0 PENDING bookings confirmed without Stripe charge; existing $0 payment record updated to SUCCEEDED
- Xero: `createXeroInvoiceForBooking` now records $0 payment for $0 bookings
- UI: `BookingPaymentWrapper` shows "Booking Complete" when `amountCents === 0`

### Bugfix: Modification Payment Collection - COMPLETED

**Date:** 2026-04-07
**Tests:** +18 new (`src/lib/__tests__/fix-mod-payment.test.ts`)

- `modify-dates` and `add-guests` routes: price increases now create an additional PaymentIntent and return `clientSecret` to the UI
- `POST /api/bookings/[id]/confirm-modification-payment` — verifies PI succeeded and updates DB
- `GET /api/bookings/[id]/additional-payment-secret` — returns `clientSecret` for pending additional PI
- Stripe webhook: `payment_intent.succeeded` handles additional PIs for modifications
- Change Dates and Add Guest dialogs updated to collect payment when `clientSecret` is returned

### Bugfix: Draft Bookings - COMPLETED

**Date:** 2026-04-07
**Tests:** +15 new (`src/lib/__tests__/issue7-8-draft-subscription.test.ts`)

- New `DRAFT` booking status; booking wizard has "Save as Draft" button
- `GET /api/bookings/drafts` — returns active (non-expired) drafts for current member
- `DELETE /api/bookings/[id]` with DRAFT status — deletes draft without refund logic
- Draft expiry: 72 hours from creation; cron auto-expires via status check
- Booking listing (`GET /api/bookings`) defaults to `status != DRAFT` to hide drafts from main list

### Bugfix: Subscription Enforcement - COMPLETED

**Date:** 2026-04-07
**Tests:** (covered in `issue7-8-draft-subscription.test.ts`)

- `POST /api/bookings` checks `MemberSubscription` for the booking member; UNPAID or OVERDUE → 403 with `SUBSCRIPTION_REQUIRED` error code
- Members can still view, modify, and cancel existing bookings

### Bugfix: Age Tier Calculation & Configurable Age Groups - COMPLETED

**Date:** 2026-04-07
**Tests:** +13 new (`src/lib/__tests__/age-tier-settings.test.ts`)

- Age boundaries corrected: CHILD = age 0–9, YOUTH = 10–17, ADULT = 18+ (was 0–11, 12–17, 18+)
- Reference date is season start (April 1 of the season year), not today — prevents mid-season tier changes
- `AgeTierSetting` Prisma model: key/value store (`childMaxAge`, `youthMaxAge`) with DB-level cache
- `computeAgeTierWithSettings()` reads from DB with fallback to hardcoded defaults
- Admin UI at `/admin/age-tiers` — edit boundaries with contiguity validation
- `invalidateAgeTierCache()` clears in-memory cache when settings saved

**New Prisma models:**
- `AgeTierSetting` — key/value age tier configuration

### Bugfix: Calendar UI - COMPLETED

**Date:** 2026-04-07
**Tests:** (covered in status-colors and nav-content tests)

- Availability calendar shows bed count per day (e.g. "12 beds")
- Background color tiers: green (>15 beds), amber (6–15), red (1–5), grey (full/closed)
- Season boundary indicators show season name and type on the first day of each season
- Booking detail status badge uses centralized color utility

### Bugfix: Status Colors - COMPLETED

**Date:** 2026-04-07
**Tests:** +19 new (`src/lib/__tests__/status-colors.test.ts`)

- New `src/lib/status-colors.ts` — maps every booking/payment/subscription status to a unique Tailwind color class
- Booking: DRAFT=slate, PENDING=yellow, CONFIRMED=green, PAID=blue, BUMPED=orange, CANCELLED=red, COMPLETED=purple
- Payment: PENDING=yellow, PROCESSING=blue, SUCCEEDED=green, PAID=blue, FAILED=red, REFUNDED=orange, PARTIALLY_REFUNDED=amber
- Subscription: PAID=green, UNPAID=red, OVERDUE=orange
- Helper functions `bookingStatusClass()`, `paymentStatusClass()`, `subscriptionStatusClass()` with unknown-status fallback

### Bugfix: Navigation & Content - COMPLETED

**Date:** 2026-04-07
**Tests:** +22 new (`src/lib/__tests__/nav-content-fixes.test.ts`)

- Admin sidebar: Home link points to `/dashboard` (not `/admin/dashboard`)
- Nav bar branding link: → `/` (public homepage) for unauthenticated, `/dashboard` for authenticated
- All 6 dashboard KPI cards are clickable and link to filtered admin list pages
- Booking list default filter excludes DRAFT status (`status != DRAFT`)
- About page: Waldvogel Lodge photo caption corrected; catering info added
- Join page: correct membership fee table; links to `tokoroa.org.nz`
- Contact page footer links updated

### Bugfix: Family Group Multi-Membership - COMPLETED

**Date:** 2026-04-07
**Tests:** +20 new (`src/lib/__tests__/family-group-multi.test.ts`)

- `FamilyGroupMember` join table replaces single `familyGroupId` FK — members can now belong to multiple family groups
- `GET /api/admin/family-groups` and `[id]` routes query via join table; inactive members filtered from response
- `POST/PUT /api/admin/family-groups/[id]` manage join table rows (add/remove members); rejects dependents and inactive members
- `GET /api/members/family` returns deduplicated peers from all groups the member belongs to; falls back to legacy `familyGroupId` for un-migrated records
- Admin member list: family group badge shows one chip per group with correct `?edit=GROUP_ID` URL
- Migration: `20260407_family_group_member` inserts existing `Member.familyGroupId` rows into join table (idempotent ON CONFLICT DO NOTHING)

**New Prisma models:**
- `FamilyGroupMember` — join table (memberId, familyGroupId, unique constraint)

### Bugfix: Family Email Inheritance - COMPLETED

**Date:** 2026-04-07
**Tests:** +9 new (`src/lib/__tests__/member-email.test.ts`)

- `inheritEmailFromId` field on `Member` — nullable FK to another Member whose email to use
- `getEffectiveEmail(member)` helper in `src/lib/member-email.ts` — returns inherited email if set, own email otherwise; accepts pre-loaded relation to avoid extra DB round-trip
- All notification sends (check-in reminders, roster emails, etc.) call `getEffectiveEmail()` for dependent guests
- Profile page: shows "Email inherited from [parent name]" when inheritance is active; link to change

**New files:**
- `src/lib/member-email.ts` - `getEffectiveEmail()` helper

### Waitlist Feature - COMPLETED

**Date:** 2026-04-09
**Branch:** feature/waitlist
**Tests:** 1258 (was 948, +310 across waitlist + admin-book-on-behalf + security hardening)

**Features built:**
1. **Schema**: `WAITLISTED` and `WAITLIST_OFFERED` added to `BookingStatus` enum; `waitlistPosition`, `waitlistOfferedAt`, `waitlistOfferExpiresAt` fields on `Booking`; `bookingWaitlist` preference on `NotificationPreference`; composite index for efficient waitlist queries
2. **Core logic** (`src/lib/waitlist.ts`): FIFO queue with advisory lock serialization; `getWaitlistPosition`, `getWaitlistForDates`, `processWaitlistForDates` (main orchestrator), `confirmWaitlistOffer`, `expireStaleOffers`, `updateWaitlistPositions`
3. **Booking creation**: 409 response with `canWaitlist: true` when capacity exceeded; `waitlist: true` flag creates WAITLISTED booking with pricing/promo locked in
4. **Capacity release triggers**: cancellation, date modification, and pending-booking bumping all fire `processWaitlistForDates()` to offer freed capacity to the next waitlisted member
5. **Offer flow**: 48-hour time-limited offers (configurable via `WAITLIST_OFFER_HOURS` env var); expired offers revert to WAITLISTED and cascade to next candidate
6. **Member confirmation**: `POST /api/bookings/[id]/waitlist-confirm` — re-checks capacity, transitions to CONFIRMED/PENDING, handles $0 bookings
7. **Admin force-confirm**: `POST /api/admin/bookings/[id]/force-confirm` — with overbook detection and `allowOverbook` option
8. **Admin waitlist page**: `/admin/waitlist` with table, force-confirm buttons, overbook dialog
9. **Cron** (`src/lib/cron-waitlist.ts`): every 30 min, expires stale offers and auto-cancels past-date waitlist entries
10. **Emails**: 4 new templates (waitlist confirmation, offer, offer expired, admin alert); preference-gated via `bookingWaitlist`
11. **UI**: booking wizard shows waitlist prompt on capacity exceeded; booking detail shows position or offer countdown with `WaitlistOfferCard` component

**New files:**
- `src/lib/waitlist.ts` - Core waitlist service module
- `src/lib/cron-waitlist.ts` - Waitlist cron job
- `src/app/api/bookings/[id]/waitlist-confirm/route.ts` - Member offer confirmation
- `src/app/api/admin/bookings/[id]/force-confirm/route.ts` - Admin force-confirm
- `src/app/api/admin/waitlist/route.ts` - Admin waitlist listing
- `src/app/(admin)/admin/waitlist/page.tsx` - Admin waitlist page
- `src/components/waitlist-offer-card.tsx` - Offer countdown component
- `src/lib/__tests__/waitlist.test.ts` - 25 waitlist tests

**New Prisma fields (require migration):**
- `Booking.waitlistPosition` (Int?) — FIFO position
- `Booking.waitlistOfferedAt` (DateTime?) — when offer was made
- `Booking.waitlistOfferExpiresAt` (DateTime?) — offer deadline
- `NotificationPreference.bookingWaitlist` (Boolean, default true)

**New env vars:**
- `WAITLIST_OFFER_HOURS` - Hours before waitlist offer expires (default: 48)

**Modified files:**
- `prisma/schema.prisma` - New fields, enum values, index
- `src/app/api/bookings/route.ts` - Waitlist path in booking creation
- `src/lib/booking-cancel.ts` - Waitlist cancellation + capacity release triggers
- `src/lib/cron-confirm-pending.ts` - Waitlist trigger after bumping
- `src/app/api/bookings/[id]/modify-dates/route.ts` - Waitlist trigger after date change
- `src/lib/email-templates.ts` - 4 new templates
- `src/lib/email.ts` - 4 new send functions + preference mapping
- `src/lib/status-colors.ts` - WAITLISTED (purple) and WAITLIST_OFFERED (teal)
- `src/components/admin-sidebar.tsx` - Waitlist nav entry
- `src/instrumentation.ts` - Waitlist cron registration
- `src/app/(authenticated)/book/page.tsx` - Waitlist prompt UI
- `src/app/(authenticated)/bookings/[id]/page.tsx` - Waitlist status display

## What's Next

All delivery phases (1–12), post-launch bugfix rounds, and waitlist feature are complete. The system is ready for UAT testing and production deployment.

**Recommended next steps:**
1. UAT: Club committee tests with real member data against the staging/production instance
2. Production deployment: `docker compose up -d --build` + `docker compose run --rm migrate` on Lightsail
3. Switch Stripe to live keys and Xero to production org
4. Seed production database and import existing Checkfront member data via CSV import

