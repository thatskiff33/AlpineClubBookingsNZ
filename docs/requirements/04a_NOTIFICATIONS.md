# 04a: Notifications Requirements

**Date:** 2026-04-05

## Current State

7 transactional email templates exist in `src/lib/email-templates.ts`, sent via nodemailer/AWS SES (`src/lib/email.ts`):

1. Welcome (registration)
2. Password reset
3. Booking confirmed
4. Booking pending (non-member hold)
5. Booking bumped
6. Booking cancelled
7. Chore roster

**Gaps identified:**
- No check-in reminders
- No admin alert emails (new bookings, capacity warnings, payment failures, sync errors)
- No bulk/broadcast communication
- No notification preferences or opt-out
- No email delivery tracking or retry
- No "pending -> confirmed" email distinct from initial confirmation (cron auto-confirm uses the same template but this is already wired)
- Dev mode logs to console only; no email preview/testing tooling

---

## Feature Requirements

### N-01: Check-In Reminder Email

- **Description:** Send an automated reminder email to the booking member N days before check-in (e.g., 3 days). Include dates, guest list, lodge info (directions, check-in time, what to bring), and a link to their booking.
- **Acceptance Criteria:**
  - Cron job (daily, e.g., 9 AM NZST) identifies CONFIRMED bookings with `checkIn` = today + N days
  - Sends one reminder per booking (not per guest)
  - Skips bookings that have already received a reminder (track via a `reminderSentAt` field on Booking or a separate log)
  - N is configurable via env var (default: 3)
  - Email includes: dates, guest names, guest count, total paid, lodge address/directions placeholder, link to booking detail
  - New HTML template in `email-templates.ts` matching existing brand style
  - Does not send for CANCELLED/BUMPED bookings
- **Dependencies:** Existing cron infrastructure in `instrumentation.ts`, `email.ts`
- **Complexity:** S

### N-02: Admin Alert — New Booking Created

- **Description:** Notify admin(s) when a new booking is created, with booking summary.
- **Acceptance Criteria:**
  - Email sent to `CONTACT_EMAIL` (or a new `ADMIN_NOTIFICATION_EMAIL` env var) on booking creation
  - Includes: member name, dates, guest count, member/non-member mix, total price, booking status
  - Sent after successful booking creation in `POST /api/bookings`
  - Fire-and-forget (booking creation does not fail if email fails)
  - New HTML template
- **Dependencies:** `POST /api/bookings` route, `email.ts`
- **Complexity:** S

### N-03: Admin Alert — Capacity Warning

- **Description:** Alert admin when lodge occupancy for any upcoming date crosses a threshold (e.g., 25 of 29 beds booked).
- **Acceptance Criteria:**
  - Checked as part of a daily cron job (can share the reminder cron schedule)
  - Looks 30 days ahead, finds dates where confirmed guest count >= threshold
  - Threshold configurable via env var (default: 25)
  - Sends one summary email listing all dates above threshold with bed counts
  - Does not re-alert for dates already alerted (track last alert date, or only alert once per date)
  - New HTML template
- **Dependencies:** `capacity.ts` (getAvailableBeds), cron infrastructure, `email.ts`
- **Complexity:** M

### N-04: Admin Alert — Payment Failure

- **Description:** Notify admin when a Stripe charge fails during cron auto-confirmation of pending bookings or manual charge.
- **Acceptance Criteria:**
  - Email sent when `confirmPendingBookings()` encounters a Stripe charge failure
  - Email sent when `POST /api/payments/charge-saved-method` fails
  - Includes: member name, email, booking dates, error summary, link to admin booking view
  - Fire-and-forget
  - New HTML template
- **Dependencies:** `cron-confirm-pending.ts`, `charge-saved-method/route.ts`, `email.ts`
- **Complexity:** S

### N-05: Admin Alert — Xero Sync Errors

- **Description:** Notify admin when Xero integration encounters errors (token refresh failure, invoice creation failure, membership sync errors).
- **Acceptance Criteria:**
  - Email sent on: Xero token refresh failure, invoice creation failure, credit note failure, bulk membership refresh with errors
  - Includes: error type, affected member/booking if applicable, error message, timestamp
  - Batched for bulk operations (membership refresh sends one summary email, not one per member)
  - Fire-and-forget
  - New HTML template (or reuse a generic "admin alert" template with variable content)
- **Dependencies:** `xero.ts`, cron Xero job, `email.ts`
- **Complexity:** M

### N-06: Admin Alert — Pending Bookings Approaching Deadline

- **Description:** Warn admin about pending (non-member) bookings that will auto-confirm within 48 hours.
- **Acceptance Criteria:**
  - Daily cron (can share schedule with N-01/N-03) finds PENDING bookings where `nonMemberHoldUntil` is within 48 hours
  - Sends one summary email listing all such bookings with member name, dates, guest count, hold deadline
  - Admin can then manually intervene if needed
  - New HTML template
- **Dependencies:** Cron infrastructure, `email.ts`
- **Complexity:** S

### N-07: Admin Alert — Booking Bumped

- **Description:** Notify admin when a non-member booking is bumped by member priority.
- **Acceptance Criteria:**
  - Email sent to admin when `bumpPendingBookings()` bumps one or more bookings
  - Includes: list of bumped bookings (member name, dates, guest count), triggering member booking details
  - One email per bump event (may contain multiple bumped bookings)
  - Fire-and-forget
  - New HTML template
- **Dependencies:** `bumping.ts`, `email.ts`
- **Complexity:** S

### N-08: Notification Preferences (Member)

- **Description:** Allow members to control which non-essential emails they receive.
- **Acceptance Criteria:**
  - New `NotificationPreference` model (or JSON field on Member) storing opt-in/out per category
  - Categories: `CHECK_IN_REMINDER`, `CHORE_ROSTER`, `BULK_COMMUNICATION`
  - Transactional emails (booking confirmed/cancelled/bumped, password reset) are always sent — no opt-out
  - UI: toggle switches on member profile page (`/profile`)
  - API: `GET/PUT /api/profile/notifications`
  - All non-essential email sends check preference before sending
  - Unsubscribe link in email footer for non-essential emails, linking to profile preferences
- **Dependencies:** Prisma schema change (migration), profile page, `email.ts`, all non-essential email send points
- **Complexity:** M

### N-09: Bulk Member Communication

- **Description:** Admin can send a broadcast email to all active members, or a filtered subset.
- **Acceptance Criteria:**
  - Admin UI page at `/admin/communications` (or similar)
  - Compose form: subject, rich-text body (or markdown), recipient filter (all members, members with upcoming bookings, members by subscription status)
  - Preview before sending
  - Sends via existing SES transport, rate-limited to avoid SES throttling (e.g., 10/sec)
  - Tracks send count and any failures
  - Respects `BULK_COMMUNICATION` notification preference (N-08)
  - Wraps content in existing branded email layout
  - Audit log entry for each bulk send
- **Dependencies:** N-08 (preferences), `email.ts`, `email-templates.ts`, `audit.ts`, new admin page
- **Complexity:** L

### N-10: Email Delivery Tracking

- **Description:** Track email send attempts and outcomes for debugging and audit.
- **Acceptance Criteria:**
  - New `EmailLog` model: `id`, `to`, `subject`, `templateName`, `status` (SENT/FAILED), `error` (nullable), `bookingId` (nullable), `memberId` (nullable), `createdAt`
  - `sendEmail()` in `email.ts` writes a log entry on every send attempt
  - Admin UI: viewable at `/admin/email-log` (or tab on existing admin page) with filters by status, date, recipient
  - Retention: auto-cleanup of logs older than 90 days (cron)
- **Dependencies:** Prisma schema change (migration), `email.ts`, new admin page
- **Complexity:** M

### N-11: Email Retry on Failure

- **Description:** Retry failed email sends with exponential backoff.
- **Acceptance Criteria:**
  - `sendEmail()` retries up to 3 times on transient failures (network errors, SES throttling) with exponential backoff (1s, 2s, 4s)
  - Permanent failures (invalid address, SES rejection) are not retried
  - Each attempt logged in `EmailLog` (N-10)
  - Final failure logged with error detail
  - Does not block the calling operation (fire-and-forget with retry handled async)
- **Dependencies:** N-10 (email logging), `email.ts`
- **Complexity:** S

### N-12: Post-Stay Feedback Request

- **Description:** Send a feedback request email after checkout, asking members about their stay.
- **Acceptance Criteria:**
  - Cron job (daily) finds CONFIRMED bookings where `checkOut` = yesterday
  - Sends email with a link to a simple feedback form or external survey URL (configurable via env var)
  - Skips CANCELLED/BUMPED bookings
  - Respects notification preferences (new category: `POST_STAY_FEEDBACK`)
  - Track `feedbackRequestSentAt` on Booking to prevent duplicates
  - New HTML template
- **Dependencies:** N-08 (preferences), cron infrastructure, `email.ts`, Prisma schema change (field on Booking)
- **Complexity:** S

### N-13: Admin Digest Email

- **Description:** Daily summary email to admin with key operational metrics.
- **Acceptance Criteria:**
  - Sent daily (e.g., 8 AM NZST) to `ADMIN_NOTIFICATION_EMAIL`
  - Includes: bookings created yesterday, bookings checking in today, current occupancy for next 7 days, any payment failures in last 24h, pending bookings approaching deadline
  - Single consolidated email (reduces admin alert fatigue from N-02 through N-07)
  - Configurable: admin can choose real-time alerts (N-02 to N-07) vs digest-only vs both (env var or admin setting)
  - New HTML template
- **Dependencies:** N-02 through N-07 (can be built independently, but conceptually replaces some), `capacity.ts`, `email.ts`, cron infrastructure
- **Complexity:** M

---

## Summary

| ID | Feature | Complexity |
|----|---------|------------|
| N-01 | Check-in reminder | S |
| N-02 | Admin alert: new booking | S |
| N-03 | Admin alert: capacity warning | M |
| N-04 | Admin alert: payment failure | S |
| N-05 | Admin alert: Xero sync errors | M |
| N-06 | Admin alert: pending approaching deadline | S |
| N-07 | Admin alert: booking bumped | S |
| N-08 | Notification preferences | M |
| N-09 | Bulk member communication | L |
| N-10 | Email delivery tracking | M |
| N-11 | Email retry on failure | S |
| N-12 | Post-stay feedback request | S |
| N-13 | Admin digest email | M |

**Totals:** 6x S, 5x M, 1x L, 0x XL
