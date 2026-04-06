# Comprehensive Codebase Review - 2026-04-07

Full review of the TACBookings system covering all flows, integrations, security, and UI.
Findings are deduplicated, verified against source code, and false positives removed.

---

## CRITICAL ISSUES (Fix Before Production)

### C1. No Unique Constraint on Member.email
**File:** `prisma/schema.prisma:97`
**Impact:** The `email` field has only `@@index([email])`, not `@unique`. While application code checks for duplicates before insert, a race condition between check and insert can create duplicate primary member accounts. This breaks authentication (which email logs in?), Xero syncing, and email verification.
**Fix:** Add `@unique` to the email field, or a composite unique constraint allowing shared email only for dependents.

### C2. Calendar Availability Color Thresholds Wrong
**File:** `src/components/booking-calendar.tsx:93-99`
**Impact:** Current implementation: Green (>5 beds), Yellow (<=5), Red (0). Spec requires: Green (>15), Amber (6-15), Red (1-5), Grey (0). Missing grey color entirely for fully booked dates. Users see misleading availability signals.
**Fix:** Implement 4-tier coloring matching the spec. Add grey for 0 beds. Update legend at line 190.

### C3. Roster Auto-Suggest Race Condition
**File:** `src/app/api/admin/roster/[date]/route.ts:94-106`
**Impact:** The check for existing assignments + createMany is NOT in a transaction. Two concurrent requests for the same date can both find no assignments and both create duplicates. This creates duplicate roster entries.
**Fix:** Wrap the check + create in a `prisma.$transaction()` or use an advisory lock.

### C4. Hut Leader Wizard - Reassign Dropdown Missing Eligibility Filtering
**File:** `src/app/(lodge)/lodge/roster/[date]/setup/page.tsx:660-672`
**Impact:** The reassign dropdown shows ALL guests without filtering for chore eligibility. A hut leader can assign a CHILD to an ADULTS_ONLY chore. Validation happens on backend only; the UI allows invalid selections.
**Fix:** Filter dropdown options by chore eligibility (age, time-of-day).

### C5. Missing Max Length on Guest Name Fields in Booking/Guest APIs
**File:** `src/app/api/bookings/route.ts:32-33`, `src/app/api/bookings/[id]/guests/route.ts:23-24`
**Impact:** `firstName` and `lastName` use `.min(1)` but no `.max()`. An attacker can submit extremely large strings causing database bloat, email rendering issues, and potential DoS. Other routes like admin members properly use `.max(100)`.
**Fix:** Add `.max(100)` to both fields in both schemas.

---

## HIGH ISSUES (Fix Before UAT)

### H1. Stripe Webhook - No Amount Validation
**File:** `src/app/api/webhooks/stripe/route.ts:174`
**Impact:** When processing `payment_intent.succeeded`, the webhook stores `paymentIntent.amount` directly without validating it matches the expected `booking.finalPriceCents`. A misconfigured webhook replay could record incorrect amounts.
**Fix:** Compare `paymentIntent.amount` against the booking's `finalPriceCents` before updating the payment record.

### H2. Xero Credit Note - Potential Sign Issue
**File:** `src/lib/xero.ts:1466-1472, 1616-1622`
**Impact:** Credit notes use positive `unitAmount` values. Xero's API documentation states credit notes should have positive amounts (Xero handles the sign internally), so this may work correctly. However, this should be verified against actual Xero behavior in the connected org to ensure credit notes reduce the balance correctly.
**Fix:** Test credit note creation against the Xero demo org and verify the ledger entries are correct.

### H3. Xero findOrCreateContact Race Condition
**File:** `src/lib/xero.ts:359-421`
**Impact:** Two concurrent booking confirmations for the same member could both search for the contact, both not find it, and both create new Xero contacts. This creates duplicate contacts in Xero.
**Fix:** Use a mutex or advisory lock keyed on memberId before calling this function.

### H4. Booking.member Missing onDelete Cascade
**File:** `prisma/schema.prisma:281`
**Impact:** `member Member @relation(fields: [memberId], references: [id])` has no `onDelete` clause. While the current deletion workflow anonymizes members rather than deleting them, if a member record were ever hard-deleted, all their bookings would have dangling foreign keys. Other relations (BookingGuest, Payment, etc.) properly use `onDelete: Cascade`.
**Fix:** Add `onDelete: Cascade` or `onDelete: Restrict` to make the intent explicit.

### H5. PromoRedemption.member Missing onDelete
**File:** `prisma/schema.prisma:385`
**Impact:** Same issue as H4 - the PromoRedemption -> Member relation lacks an explicit onDelete clause.
**Fix:** Add `onDelete: Cascade`.

### H6. Email Verification Token Expiry Inconsistency
**File:** `src/lib/verification-tokens.ts:20`
**Impact:** Token expiry times vary wildly: email verification 24h, password reset 1h, email change 1h, admin invite 7 days. The 24h verification window means users who register late in the day may find their token expired the next morning. The resend endpoint is rate-limited to 3/hr.
**Fix:** Document the strategy. Consider aligning verification to 48h for better user experience.

### H7. Email Change Confirmation - Race Condition on Email Uniqueness
**File:** `src/app/api/auth/confirm-email-change/route.ts:34-57`
**Impact:** The uniqueness check and the email update happen in separate steps without a database-level unique constraint on email. Two simultaneous email-change confirmations targeting the same destination email could both succeed. (See also C1 - adding `@unique` on email would fix this at the DB level.)
**Fix:** Fix C1 first (unique constraint), which prevents this at the database level.

### H8. Kiosk Silent Action Failures
**File:** `src/app/(lodge)/lodge/kiosk/page.tsx:124-126, 147-149, 170-172`
**Impact:** Toggle actions (chores, arrival, departure) silently fail with no user feedback. On unreliable lodge WiFi, a hut leader won't know their action didn't save. Auto-refresh every 60s provides eventual correction but the user experience is poor.
**Fix:** Show a brief toast/snackbar on failure ("Action failed, please try again").

### H9. Roster Email Sending - All-or-Nothing Failure
**File:** `src/app/api/admin/roster/[date]/route.ts:363-383`
**Impact:** Uses `Promise.all()` for sending roster emails. If ANY email fails, the entire action returns 500, even if 29 of 30 emails sent successfully. No partial success reporting.
**Fix:** Use `Promise.allSettled()` and return a partial success response with per-guest status.

### H10. Guest Departure Doesn't Update Chore Assignments
**File:** Lodge guest departure endpoint
**Impact:** When a guest departs early, their pending chore assignments for remaining dates are not automatically cleaned up or reassigned. A departed guest may appear on the roster for subsequent days.
**Fix:** On departure, mark remaining SUGGESTED chore assignments as cancelled or trigger reassignment.

### H11. NavBar Branding Link Not Context-Aware
**File:** `src/components/nav-bar.tsx:64`
**Impact:** Branding link always routes to `/` (public homepage) even for authenticated users. The CLAUDE.md spec says it should go to `/dashboard` for authenticated users. Clicking the logo takes members away from the authenticated area.
**Fix:** Conditionally set `href` based on session state.

### H12. Missing Sentry Cron Monitoring on 5 Cron Jobs
**File:** `src/instrumentation.ts:240-404`
**Impact:** Five cron jobs (`pending-deadline-alerts`, `checkin-reminders`, `capacity-warnings`, `email-retry`, `feedback-requests`) only capture exceptions but don't implement `Sentry.captureCheckIn()`. If these jobs fail silently or hang, Sentry won't alert.
**Fix:** Add Sentry cron check-in/check-out signals matching the pattern used by the other 3 monitored jobs.

### H13. Fire-and-Forget EmailLog Updates Not Awaited
**File:** `src/lib/email.ts:77-118`
**Impact:** After sending email, the EmailLog status update is fire-and-forget with `.catch(() => {})`. If the DB update fails, the email retry cron won't find emails that need retrying, and the audit trail has gaps.
**Fix:** Await the update, or at minimum log failures at error level rather than swallowing them.

### H14. Check-in Reminder Deduplication Checks All Statuses
**File:** `src/lib/cron-checkin-reminders.ts:63-72`
**Impact:** The dedup check looks for ANY EmailLog entry with `checkin-reminder` template in the past 48h, regardless of status. If a previous attempt FAILED (status=FAILED), the reminder is still considered "sent" and won't be retried by this cron. Members may miss check-in reminders.
**Fix:** Filter to `status: "SENT"` only in the dedup check.

### H15. Cancellation Status Check Mismatch
**File:** `src/lib/cancellation.ts:147`
**Impact:** `calculateBookingRefund()` only checks for `status === "CONFIRMED"` but `cancelBooking()` allows both CONFIRMED and PAID statuses. This means `calculateBookingRefund()` returns null for PAID bookings, potentially giving incorrect preview data.
**Fix:** Include PAID in the status check, or unify refund calculation logic.

---

## MEDIUM ISSUES

### M1. Webhook Idempotency Not Atomic
**File:** `src/app/api/webhooks/stripe/route.ts:51-57`
**Impact:** The ProcessedWebhookEvent check and insert aren't in a transaction. Two identical webhooks arriving simultaneously could both pass the check. The unique constraint on `eventId` would catch the second insert, but the duplicate processing has already started.
**Fix:** Use `upsert` or wrap in a transaction with `SELECT FOR UPDATE`.

### M2. NZST Date Calculation Duplicated and Fragile
**Files:** `cron-checkin-reminders.ts:13-30`, `cron-capacity-warnings.ts:16-30`, `cron-feedback-requests.ts:18-29`
**Impact:** Multiple cron jobs manually calculate "today" in NZST using `Intl.DateTimeFormat` + `formatToParts()`. This is duplicated 3+ times and fragile - if the parsing logic has a bug, all cron jobs break silently.
**Fix:** Extract a shared `getNZSTToday()` utility function.

### M3. SMTP Health Check Only Validates Config
**File:** `src/app/api/health/route.ts:86-102`
**Impact:** The health check only verifies that SMTP env vars exist. It doesn't test actual connectivity. A misconfigured or unreachable SMTP server reports "ok".
**Fix:** Attempt a `transporter.verify()` call to test actual SMTP connectivity.

### M4. No Max Guest Count Validation
**File:** `src/app/api/bookings/route.ts:39`
**Impact:** The schema validates `guests.min(1)` but not `.max()`. A client could submit a booking with 1000 guests. While capacity checks prevent overbooking, processing the request wastes resources and the error message is unclear.
**Fix:** Add `.max(29)` (lodge capacity) to the guests array schema.

### M5. Capacity Warning Template Hardcodes 29 Beds
**File:** `src/lib/email-templates.ts:510`
**Impact:** `const pct = Math.round((d.occupiedBeds / 29) * 100)` hardcodes lodge capacity. If capacity ever changes, this percentage is wrong.
**Fix:** Use the `LODGE_CAPACITY` constant from `capacity.ts`.

### M6. CronJobRun and WebhookLog Pruning Coupled to Backup
**File:** `src/instrumentation.ts:198-205`
**Impact:** `pruneCronRuns()` and `pruneWebhookLogs()` are only called after the backup cron. If backup fails or is disabled, these tables grow indefinitely.
**Fix:** Create a separate daily pruning cron job.

### M7. Xero Membership Refresh Skips Members Without xeroContactId
**File:** `src/lib/xero.ts:1230-1231`
**Impact:** Members without a Xero contact ID will never have their subscription status automatically refreshed. This is by design but undocumented.
**Fix:** Document this behavior. Consider adding a warning in the admin UI for members without Xero links.

### M8. Xero Token Refresh Buffer May Be Insufficient
**File:** `src/lib/xero.ts:51, 304`
**Impact:** Tokens are refreshed 5 minutes before expiry. Long-running operations (bulk contact import, full membership sync) could exceed this buffer and fail mid-operation.
**Fix:** Consider a 10-15 minute buffer, or add mid-operation token refresh capability.

### M9. Register Page Password Requirement Shows "8 characters" Instead of "12"
**File:** `src/app/(public)/register/page.tsx:189`
**Impact:** The UI says "At least 8 characters" but the actual Zod schema enforces 12 characters. Users will be confused when their 8-11 character password is rejected.
**Fix:** Update the UI text to "At least 12 characters".

### M10. Xero Supplementary Invoices Not Linked to Original
**File:** `src/lib/xero.ts:1516-1582`
**Impact:** Supplementary invoices for price increases on modifications are created as standalone invoices with no reference to the original booking invoice. Accountants can't easily trace them.
**Fix:** Add the original invoice number to the supplementary invoice's reference field.

### M11. Email Inheritance Doesn't Prevent Circular Chains
**File:** `src/app/api/admin/members/[id]/route.ts:232-246`
**Impact:** The `inheritEmailFromId` validation checks for self-loops and ensures the source is an active adult, but doesn't prevent chains (A inherits from B, B later changed to inherit from C).
**Fix:** Enforce that only primary members (parentMemberId == null) can be email inheritance sources.

### M12. Guest Chore Token Generation Creates Duplicates
**File:** `src/app/api/admin/roster/[date]/route.ts:363-383`
**Impact:** Each time roster emails are sent, new tokens are generated without invalidating old ones. Calling the email action multiple times creates many valid tokens for the same guest/date combination.
**Fix:** Delete existing tokens for the same guest/date before creating new ones, or return existing valid tokens.

### M13. Sentry Edge Config Missing beforeSend Hook
**File:** `sentry.edge.config.ts`
**Impact:** The edge runtime Sentry config doesn't scrub sensitive data (unlike the server config which has a `beforeSend` hook). Edge errors may leak sensitive data to Sentry.
**Fix:** Add the same `beforeSend` scrubbing hook as `sentry.server.config.ts`.

### M14. Session Callback Doesn't Validate Member Is Still Active
**File:** `src/lib/auth.ts:89-95`
**Impact:** If an admin deactivates a member while they have an active JWT session, the member can still access APIs for up to 8 hours. Layout guards check active status on page loads, but direct API calls may bypass this.
**Fix:** Add an active check in frequently-called API routes (booking creation, payment), or reduce session maxAge.

### M15. Email Verification Token Cleanup Not Automated
**File:** `src/lib/verification-tokens.ts`
**Impact:** Expired email verification and password reset tokens are only cleaned up when used. No automated cleanup exists for abandoned tokens, causing gradual DB bloat.
**Fix:** Add a daily cron job to delete tokens older than 7 days.

### M16. Modification Change Fee Uses Original Check-In Date's Policy
**File:** `src/app/api/bookings/[id]/modify-dates/route.ts:228-229`
**Impact:** When calculating change fees for a date modification, the cancellation policy is loaded using the ORIGINAL check-in date. If the new check-in date falls in a different policy period, the fee may be calculated using the wrong tiers.
**Fix:** Evaluate whether the old or new date's policy should apply (business decision), then implement consistently.

---

## LOW ISSUES

### L1. Bumping Comment Says "FIFO" but Means "Last Booked First Bumped"
**File:** `src/lib/bumping.ts:84`
**Impact:** Comment "FIFO: most recent first" is confusing. The behavior (`createdAt: "desc"`) matches the spec ("last booked = first bumped") but the comment uses FIFO incorrectly.
**Fix:** Update comment to "Last booked = first bumped (most recent pending bookings bumped first)".

### L2. Advisory Lock ID Hardcoded to 1 Everywhere
**File:** Multiple files using `pg_advisory_xact_lock(1)`
**Impact:** All booking operations, modifications, and capacity checks share a single lock. At 29-bed lodge scale this is fine, but it means complete serialization of all booking writes.
**Fix:** Acceptable for current scale. Document the design decision.

### L3. Kiosk Auto-Refresh Continues During Error State
**File:** `src/app/(lodge)/lodge/kiosk/page.tsx:91-94`
**Impact:** If the API is down, the kiosk hammers it every 60 seconds with no backoff.
**Fix:** Implement exponential backoff or disable auto-refresh after N consecutive failures.

### L4. Print Roster Shows All Assignment Statuses
**File:** `src/app/(admin)/admin/roster/[date]/print/page.tsx`
**Impact:** Printed roster includes SUGGESTED assignments alongside CONFIRMED ones. A physical roster should probably only show confirmed assignments.
**Fix:** Filter to `status in ['CONFIRMED', 'COMPLETED']` before rendering.

### L5. No Dead Letter Queue for Failed Emails
**File:** Email retry system
**Impact:** After 3 failed retry attempts, emails stay FAILED forever with no admin alert or manual retry mechanism.
**Fix:** Send an admin alert when emails exhaust retry attempts. Consider an admin page listing failed emails.

### L6. Chore Frequency Validation - Empty Days Array Allowed
**File:** `src/app/api/admin/chores/route.ts:19`
**Impact:** `frequencyDaysOfWeek` doesn't validate non-empty array when `frequencyMode === "SPECIFIC_DAYS"`. A chore with SPECIFIC_DAYS and empty array can never be scheduled.
**Fix:** Add `.refine()` for non-empty array when frequencyMode is SPECIFIC_DAYS.

### L7. Admin Sidebar "Home" Link Ambiguity
**File:** `src/components/admin-sidebar.tsx:72`
**Impact:** "Home" link points to `/dashboard` (member dashboard), which works but is ambiguous for admins who spend most time in the admin section.
**Fix:** Label as "Member Dashboard" or point to `/admin/dashboard`.

### L8. HSTS max-age Could Be Longer
**File:** `Caddyfile:8`
**Impact:** Current: 1 year (31536000). OWASP recommends 2 years for established sites.
**Fix:** Consider `max-age=63072000; includeSubDomains; preload` if submitting to HSTS preload list.

### L9. Docker Container Not Read-Only
**File:** `docker-compose.yml`
**Impact:** The app container filesystem is writable. Best practice for production containers is read-only with tmpfs for writable directories.
**Fix:** Add `read_only: true` and `tmpfs: [/tmp]` to the app service.

### L10. Booking Notes Lacks Database-Level Length Constraint
**File:** `prisma/schema.prisma:276`
**Impact:** `notes String?` has no `@db.VarChar(500)`. API validation enforces 500 chars via Zod, but the DB has no constraint.
**Fix:** Add `@db.VarChar(500)` for defense-in-depth.

---

## FALSE POSITIVES (Investigated and Dismissed)

These items were flagged by review but verified as correct:

1. **Email `secure: false`** - Port 587 with `secure: false` is CORRECT for AWS SES. Nodemailer uses STARTTLS to upgrade the connection on port 587. `secure: true` is only for port 465 (implicit TLS).

2. **Bumping order is LIFO not FIFO** - The spec explicitly says "last booked = first bumped" with `createdAt DESC`. The implementation matches the spec. Only the comment "FIFO" is misleading (see L1).

3. **Booking.member onDelete missing = members get orphaned** - The deletion workflow NEVER hard-deletes members. It anonymizes them (sets active=false, clears PII). So orphaned FKs can't occur in practice. Still worth adding explicit `onDelete` for defensive coding (see H4).

4. **PasswordResetToken missing @unique on token** - Actually has `@unique` at schema line 164. The token field IS uniquely constrained.

5. **Xero credit note sign error** - Xero's API expects positive amounts on credit notes and handles the sign internally. The current implementation is likely correct, though should be verified against the actual Xero org (see H2).

6. **Draft booking capacity not validated** - By design. Drafts are ephemeral (72h TTL) and capacity is checked at confirmation time. This is acceptable architecture.

---

## SUMMARY BY SEVERITY

| Severity | Count |
|----------|-------|
| Critical | 5 |
| High | 15 |
| Medium | 16 |
| Low | 10 |
| **Total** | **46** |

## TOP PRIORITY REMEDIATION ORDER

### Must fix before production (same day):
1. **C1** - Add `@unique` on Member.email
2. **C5** - Add `.max(100)` to guest name fields
3. **M9** - Fix password requirement UI text

### Must fix before UAT:
4. **C2** - Fix calendar color thresholds
5. **H11** - Fix navbar branding link
6. **C3** - Fix roster auto-suggest race condition
7. **C4** - Fix hut leader reassign dropdown filtering
8. **H1** - Add Stripe webhook amount validation
9. **H14** - Fix check-in reminder dedup to check SENT only
10. **H15** - Fix cancellation status check mismatch

### Should fix before go-live:
11. **H3** - Xero contact creation race condition
12. **H9** - Roster email partial failure handling
13. **H12** - Sentry cron monitoring gaps
14. **H13** - EmailLog fire-and-forget fix
15. **M1** - Webhook idempotency atomicity
16. **M2** - NZST date utility extraction
17. **M3** - SMTP health check improvement
