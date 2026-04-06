## Phase 5: Notification & Cron Reliability

**Priority:** High/Medium — should complete before go-live
**Depends on:** None
**Reference:** [docs/CODEBASE_REVIEW_2026-04-07.md](../CODEBASE_REVIEW_2026-04-07.md)

### Issues Addressed

| ID | Severity | Description |
|----|----------|-------------|
| H12 | High | 5 cron jobs missing Sentry monitoring (check-in/check-out signals) |
| H13 | High | EmailLog status updates are fire-and-forget, swallowing DB errors |
| H14 | High | Check-in reminder dedup counts FAILED emails as "sent" |
| M2 | Medium | NZST date calculation duplicated across 3+ cron files |
| M3 | Medium | SMTP health check only validates config, doesn't test connectivity |
| M5 | Medium | Capacity warning template hardcodes 29-bed capacity |
| M6 | Medium | CronJobRun/WebhookLog pruning only runs inside backup cron |
| M15 | Medium | Expired verification/reset tokens never auto-cleaned |
| L3 | Low | Kiosk auto-refresh has no backoff on repeated errors |
| L5 | Low | No admin alert when emails exhaust 3 retry attempts |

### Checklist

- [ ] **H12** — Add Sentry cron monitoring to 5 jobs in `src/instrumentation.ts`:
  - `pending-deadline-alerts`, `checkin-reminders`, `capacity-warnings`, `email-retry`, `feedback-requests`
  - Follow existing pattern from `confirm-pending-bookings` / `xero-membership-refresh` / `database-backup`
  - Add `Sentry.captureCheckIn()` at start (in_progress) and end (ok/error)
- [ ] **H13** — Fix `src/lib/email.ts:77-118`:
  - Change fire-and-forget `.catch(() => {})` to proper error logging
  - At minimum: `.catch(err => logger.error({ err }, "Failed to update EmailLog"))`
  - Consider awaiting the update for critical emails (confirmation, password reset)
- [ ] **H14** — Fix `src/lib/cron-checkin-reminders.ts:63-72`:
  - Change dedup query to only count `status: "SENT"` (not QUEUED/FAILED)
- [ ] **M2** — Create `src/lib/nzst-date.ts`:
  - Extract shared `getNZSTToday(): Date` utility
  - Replace manual NZST calculation in `cron-checkin-reminders.ts`, `cron-capacity-warnings.ts`, `cron-feedback-requests.ts`
- [ ] **M3** — Fix `src/app/api/health/route.ts:86-102`:
  - Add `await transporter.verify()` to test SMTP connectivity
  - Wrap in try-catch to handle connection failures gracefully
- [ ] **M5** — Fix `src/lib/email-templates.ts:510`:
  - Import `LODGE_CAPACITY` from `src/lib/capacity.ts`
  - Replace hardcoded `29` with `LODGE_CAPACITY`
- [ ] **M6** — Add a dedicated pruning cron in `src/instrumentation.ts`:
  - Run daily (e.g., 3:00 AM NZST)
  - Call `pruneCronRuns()`, `pruneWebhookLogs()`, and new `pruneExpiredTokens()`
  - Remove these calls from the backup cron job
- [ ] **M15** — Create token cleanup in the new pruning cron:
  - Delete `EmailVerificationToken` where `expiresAt < now()`
  - Delete `EmailChangeToken` where `expiresAt < now()`
  - Delete `PasswordResetToken` where `expiresAt < now() AND used = true`
  - Delete `GuestChoreToken` where `expiresAt < now()`
- [ ] **L3** — Fix `src/app/(lodge)/lodge/kiosk/page.tsx:91-94`:
  - Track consecutive fetch failures in state
  - After 3 failures, increase interval to 5 minutes
  - Reset on successful fetch
- [ ] **L5** — In `src/lib/cron-email-retry.ts`:
  - After an email reaches 3 failed attempts and is NOT retried, send an admin alert
  - Use existing `sendAdminAlert` pattern
- [ ] Write tests for the NZST utility and dedup fix
- [ ] Run full test suite: `npm test`
- [ ] Run build: `npm run build`

### Agent Prompt

```
Fix 10 notification and cron reliability issues from the codebase review (docs/CODEBASE_REVIEW_2026-04-07.md, Phase 5).

1. src/instrumentation.ts — Add Sentry.captureCheckIn() monitoring (in_progress + ok/error)
   to these 5 cron jobs: pending-deadline-alerts, checkin-reminders, capacity-warnings,
   email-retry, feedback-requests. Follow the existing pattern from confirm-pending-bookings.

2. src/lib/email.ts:77-118 — Replace fire-and-forget .catch(() => {}) on EmailLog updates
   with proper error logging: .catch(err => logger.error({ err }, "Failed to update EmailLog"))

3. src/lib/cron-checkin-reminders.ts:63-72 — Change the dedup query to only match
   status: "SENT" emails, not QUEUED or FAILED.

4. Create src/lib/nzst-date.ts with a getNZSTToday() utility. Replace manual NZST
   calculations in cron-checkin-reminders.ts, cron-capacity-warnings.ts, and
   cron-feedback-requests.ts.

5. src/app/api/health/route.ts:86-102 — Add transporter.verify() call to actually test
   SMTP connectivity instead of just checking env vars exist.

6. src/lib/email-templates.ts:510 — Replace hardcoded 29 with LODGE_CAPACITY imported
   from src/lib/capacity.ts.

7. src/instrumentation.ts — Create a dedicated daily pruning cron job (3:00 AM NZST) that
   calls pruneCronRuns(), pruneWebhookLogs(), and a new pruneExpiredTokens() function.
   Remove the pruning calls from the backup cron.

8. Create pruneExpiredTokens() that deletes expired EmailVerificationToken, EmailChangeToken,
   PasswordResetToken (where used=true), and GuestChoreToken records.

9. src/app/(lodge)/lodge/kiosk/page.tsx:91-94 — Add exponential backoff: track consecutive
   failures, increase refresh interval to 5min after 3 failures, reset on success.

10. src/lib/cron-email-retry.ts — Send admin alert when an email reaches 3 failed attempts
    and is abandoned.

Write tests for getNZSTToday() and the dedup fix.
After all changes: npm test && npm run build. Commit on branch: fix/phase-5-cron-reliability
```
