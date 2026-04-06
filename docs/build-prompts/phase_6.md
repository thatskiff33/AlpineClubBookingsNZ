# Phase 6: Notifications — Build Prompts

## Overview

**Features:** N-01 to N-13
**Dependencies:** None (uses existing cron/email infra)
**Effort:** XL
**Security review:** Required — introduces email delivery tracking, notification preferences (new schema + profile UI), bulk member communication (mass email from admin), and retry logic that could amplify failures.

---

## 1. Build Prompt

```
Read CLAUDE.md. Build Phase 6: Notifications.

This phase adds 13 notification features across three sub-phases. Build them in order (6a, 6b, 6c) since later features depend on earlier ones.

### Sub-phase 6a: Core Alerts (no internal dependencies)

#### N-10: Email Delivery Tracking

Build this FIRST — N-11 depends on it, and having the model early lets all other email sends benefit.

- Add `EmailLog` Prisma model:
  - `id` (cuid), `to` (string), `subject` (string), `templateName` (string), `status` (enum: QUEUED | SENT | FAILED | BOUNCED), `errorMessage` (string, nullable), `attempts` (int, default 1), `lastAttemptAt` (DateTime), `sentAt` (DateTime, nullable), `messageId` (string, nullable — from SES response), `createdAt`, `updatedAt`
  - Index on `to`, `status`, `createdAt`
- Modify `sendEmail()` in `src/lib/email.ts`:
  - Before sending, create an EmailLog record with status QUEUED.
  - On success, update to SENT with sentAt and messageId.
  - On failure, update to FAILED with errorMessage.
  - Make logging fire-and-forget (don't let logging failures break email delivery).
  - Add a `templateName` parameter to sendEmail and pass it through from all call sites.

#### N-01: Check-in Reminder Email

- Create `src/lib/cron-checkin-reminders.ts`:
  - Query CONFIRMED bookings where `checkIn = tomorrow` (Pacific/Auckland timezone).
  - For each, send a check-in reminder email to the booking member.
  - Skip bookings where a reminder was already sent (check EmailLog for templateName='checkin-reminder' + bookingId in subject or a dedicated field).
- Add email template `checkinReminderEmail` in `src/lib/email-templates.ts`:
  - Booking dates, guest list, lodge address/directions placeholder, any chore assignments for arrival day.
- Register the cron job in `src/instrumentation.ts` — run daily at 9:00 AM NZST. Use an overlap guard like the existing crons.

#### N-02: Admin Alert — New Booking Created

- After successful booking creation in `src/app/api/bookings/route.ts`, send a notification email to all ADMIN users.
- Add email template `adminNewBookingEmail` in `src/lib/email-templates.ts`:
  - Member name, dates, guest count, total price, booking status (CONFIRMED/PENDING).
- Query admin emails: `prisma.member.findMany({ where: { role: 'ADMIN', active: true }, select: { email: true } })`.
- Fire-and-forget — don't block the booking response on email delivery.

#### N-04: Admin Alert — Payment Failure

- In the Stripe webhook handler (`src/app/api/webhooks/stripe/route.ts`), when a `payment_intent.payment_failed` event is received, send an alert to all admins.
- Add email template `adminPaymentFailureEmail`:
  - Member name, booking dates, amount, Stripe error message (from the event), payment intent ID.
- Also trigger on charge-saved-method failures in `src/lib/cron-confirm-pending.ts`.

#### N-06: Admin Alert — Pending Approaching Deadline

- Create `src/lib/cron-pending-deadline-alerts.ts`:
  - Query PENDING bookings where `nonMemberHoldUntil` is within the next 48 hours.
  - Send a single digest email to admins listing all approaching-deadline bookings.
- Add email template `adminPendingDeadlineEmail`:
  - Table of bookings: member name, dates, guest count, deadline datetime, hours remaining.
- Register in `src/instrumentation.ts` — run daily at 8:00 AM NZST.

#### N-07: Admin Alert — Booking Bumped

- In `src/lib/bumping.ts`, after a booking is bumped, send an admin alert.
- Add email template `adminBookingBumpedEmail`:
  - Bumped member name, dates, guest count, reason (which member booking triggered it).
- Fire-and-forget, sent inside the bump loop after the member notification.

### Sub-phase 6b: Depends on 6a

#### N-03: Admin Alert — Capacity Warning

- Create `src/lib/cron-capacity-warnings.ts`:
  - For each of the next 14 days, calculate occupancy using existing `getAvailableBeds()` from capacity.ts.
  - If any day has <= 5 beds remaining (or >= 83% occupancy), include it in the alert.
  - Send a single digest email to admins (only if there are high-occupancy days).
- Add email template `adminCapacityWarningEmail`:
  - Table of dates with occupancy numbers and remaining beds, colour-coded.
- Register in `src/instrumentation.ts` — run daily at 7:00 AM NZST.

#### N-05: Admin Alert — Xero Sync Errors

- In `src/lib/xero.ts`, in `getAuthenticatedXeroClient()` catch block, and in any Xero API call that fails, send an admin alert.
- Add email template `adminXeroSyncErrorEmail`:
  - Error type, affected operation, error message, timestamp.
- Deduplicate: don't send more than one Xero error alert per hour (use a simple in-memory timestamp check, or check EmailLog).

#### N-08: Notification Preferences

- Add `NotificationPreference` Prisma model:
  - `id` (cuid), `memberId` (relation to Member, unique), `bookingConfirmation` (boolean, default true), `bookingReminder` (boolean, default true), `bookingBumped` (boolean, default true), `bookingCancelled` (boolean, default true), `choreRoster` (boolean, default true), `marketingEmails` (boolean, default false), `createdAt`, `updatedAt`
- Create `GET/PUT /api/notifications/preferences` routes:
  - GET: Return current member's preferences (create defaults if not exists).
  - PUT: Update preferences. Validate with Zod.
- Add a "Notification Preferences" section on the profile page (`src/app/(authenticated)/profile/page.tsx`):
  - Toggle switches for each preference category.
  - Auto-save on toggle (optimistic update).
- Modify relevant email sends to check preferences before sending:
  - `bookingConfirmation` gates confirmation and pending emails.
  - `bookingReminder` gates check-in reminders (N-01).
  - `bookingBumped` gates bumped notifications.
  - `bookingCancelled` gates cancellation emails.
  - `choreRoster` gates chore roster emails.
  - Admin alerts (N-02 through N-07) are NOT gated by preferences — admins always receive them.
- Create a helper `shouldSendEmail(memberId: string, category: string): Promise<boolean>` in `src/lib/email.ts`.

#### N-11: Email Retry with Backoff (depends on N-10)

- Create `src/lib/cron-email-retry.ts`:
  - Query EmailLog records with status FAILED and attempts < 3.
  - For each, re-attempt sending using the stored to/subject/template info.
  - Increment attempts, update lastAttemptAt.
  - On success, update to SENT. On failure, keep FAILED (will retry next run if attempts < 3).
  - After 3 failed attempts, leave as FAILED permanently.
- Store enough info in EmailLog to reconstruct the email. Add `htmlBody` (text) field to EmailLog for retry purposes.
- Register in `src/instrumentation.ts` — run every 30 minutes.

#### N-13: Admin Digest Email

- Create `src/lib/cron-admin-digest.ts`:
  - Consolidates all admin alerts from the past 24 hours into a single morning digest.
  - Query EmailLog for admin alert templates sent in the last 24h.
  - Group by alert type with counts and summaries.
  - Send a single digest email to all admins.
- Add email template `adminDailyDigestEmail`:
  - Sections for each alert type with counts: new bookings, payment failures, capacity warnings, bumped bookings, pending deadline, Xero errors.
  - Link to relevant admin pages for each section.
- Register in `src/instrumentation.ts` — run daily at 7:30 AM NZST.
- The individual alerts (N-02 through N-07) continue to send in real-time. The digest is a summary, not a replacement.

### Sub-phase 6c: Depends on 6b

#### N-09: Bulk Member Communication (depends on N-08)

- Create `POST /api/admin/communications/send` route:
  - Admin-only. Accepts `{ subject, body, recipientFilter }`.
  - `recipientFilter`: `all`, `members-only`, `admins-only`, or `custom` with list of member IDs.
  - Validate with Zod. Subject max 200 chars, body max 10000 chars.
  - Filter out members who have `marketingEmails: false` in NotificationPreference.
  - Queue emails (create EmailLog records with QUEUED status) and return immediately with count.
  - Process queue in background (or let the retry cron pick them up).
- Create `GET /api/admin/communications/history` route:
  - Returns past bulk sends with stats (sent, failed, total).
- Create `/admin/communications` page:
  - Compose form: subject, rich-text body (or plain textarea), recipient filter selector.
  - Preview with recipient count before sending.
  - History table showing past communications.
- Add "Communications" entry to admin sidebar nav.
- Rate limit: max 1 bulk send per hour.

#### N-12: Post-Stay Feedback Request (depends on N-08)

- Create `src/lib/cron-feedback-requests.ts`:
  - Query CONFIRMED/COMPLETED bookings where `checkOut = yesterday`.
  - For each, check `bookingReminder` preference (reuse as general booking comms preference).
  - Send a post-stay feedback email.
- Add email template `postStayFeedbackEmail`:
  - Thank the member for their stay, ask for feedback.
  - Include a link (placeholder URL — actual feedback form is out of scope).
- Register in `src/instrumentation.ts` — run daily at 10:00 AM NZST.

### General requirements

- All new cron jobs must have overlap guards (isRunning pattern from existing crons).
- All new API routes: check auth(), verify role where appropriate, Zod validation.
- All email templates follow the existing branded template style in `src/lib/email-templates.ts` (TAC header, responsive layout, styled CTAs).
- Use `escapeHtml()` on all user-provided values in email templates.
- Run `npx prisma migrate dev --name add-notification-models` after schema changes.
- Write tests for:
  - EmailLog creation/update in sendEmail (mock nodemailer transport).
  - NotificationPreference API routes (auth, CRUD, defaults).
  - shouldSendEmail helper.
  - Each cron job's query logic (mock Prisma, verify correct date filtering).
  - Bulk communication endpoint (auth, rate limiting, preference filtering).
  - Email retry logic (attempt counting, status transitions).
- Commit after each sub-phase (6a, 6b, 6c). Push after all are complete.
- When done, update CLAUDE.md build status with Phase 6 completion details. Push all commits.
```

---

## 2. Review & Test Prompt

```
Read CLAUDE.md. Review Phase 6 (Notifications) code for:

1. **Email injection**: Verify all user-provided content in email templates is escaped with escapeHtml(). Check that bulk communication body cannot inject headers or scripts. Verify subject lines are sanitised.
2. **Auth & authorisation**: All admin API routes must check auth() + role === ADMIN. Notification preferences routes must verify the member is accessing their own preferences. Bulk communication must be admin-only.
3. **Rate limiting**: Verify bulk communication has rate limiting (max 1 per hour). Verify Xero error alerts have deduplication (max 1 per hour). Check that email retry cron won't amplify a failure into an email storm.
4. **Cron safety**: All new cron jobs must have overlap guards. Verify timezone handling (Pacific/Auckland) for "tomorrow" and "yesterday" queries. Check that cron jobs handle empty result sets gracefully.
5. **Email retry correctness**: Verify max 3 attempts enforced. Verify FAILED status is set correctly on final attempt. Verify retry doesn't re-send already-SENT emails. Check that htmlBody storage doesn't leak sensitive data.
6. **Notification preferences**: Verify defaults are created on first access. Verify preferences are checked before sending. Verify admin alerts bypass preferences. Verify marketingEmails defaults to false.
7. **Data exposure**: EmailLog should not expose htmlBody in API responses (could contain personal data). Bulk communication history should not include full email bodies in list view.
8. **Performance**: Check that cron queries are indexed (checkIn, checkOut, nonMemberHoldUntil, EmailLog.status+createdAt). Verify bulk communication doesn't attempt to send 410 emails synchronously.
9. **Schema migration**: Verify migration is clean, fields have correct types and defaults, indexes are present.
10. **Test coverage**: Every new API route needs auth tests (401/403), valid request tests, and edge case tests. Every cron job needs query logic tests.

Run `npm test` and `npm run build` to verify. Fix any issues found. Commit fixes and push.
```

---

## 3. Merge Prompt

```
Read CLAUDE.md. Merge the Phase 6 branch into main.

1. Run `npm test` and `npm run build` on the current branch to confirm green.
2. Switch to main: `git checkout main && git pull origin main`.
3. Merge: `git merge <phase-6-branch> --no-ff -m "Merge Phase 6: Notifications"`.
4. Run `npm test` and `npm run build` again to confirm no merge regressions.
5. If there are Prisma schema conflicts (likely if other phases ran concurrently), accept both sets of model additions, re-generate the client, and re-run tests.
6. Push main: `git push origin main`.
7. If there are merge conflicts, resolve them preserving Phase 6 functionality, re-run tests, then push.
```

---

## Security Review

**Required.** This phase introduces several security-sensitive features:

1. **Bulk member communication (N-09)**: Admin can send emails to all 410 members. Must verify admin-only auth, rate limiting, input sanitisation (no HTML/header injection in subject/body), and preference opt-out enforcement.
2. **Email retry (N-11)**: Stores full HTML email bodies in the database for retry. Risk of sensitive data at rest (booking details, member info). Retry logic must not amplify failures into email storms.
3. **Notification preferences (N-08)**: New user-facing API. Must verify ownership checks (member can only modify their own preferences), Zod validation, and that preference bypass is impossible from client side.
4. **EmailLog data exposure**: Contains recipient emails, subjects, and potentially body content. Admin audit log viewer or communications history endpoints must not inadvertently expose email content to unauthorised users.

Run the review prompt above with extra focus on these areas. Consider a dedicated security review session if the bulk communication feature handles rich HTML input.
