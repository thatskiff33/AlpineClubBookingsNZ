# Issue #820: Email, Notification, Retry, and Suppression Review

## Issue

Review SES/email send, retry, suppression, templates, important lifecycle emails, failure visibility, redaction, and whether failed emails can leave users/admins unclear about next steps.

## Scope reviewed

- Static review of email sending, retry, suppression, SES/SNS feedback, admin health surfaces, and lifecycle email call sites.
- No live SES, SMTP, production data, app-code edits, browser automation, DAST, or load tests were run.

## Files/directories inspected

- `src/lib/email.ts`
- `src/lib/cron-email-retry.ts`
- `src/lib/ses-sns.ts`
- `src/lib/email-suppression.ts`
- `src/lib/email-failure-review.ts`
- `src/app/api/webhooks/ses-sns/route.ts`
- `src/app/(admin)/admin/health/_components/email-deliverability-section.tsx`
- `src/app/api/admin/email-suppressions/[id]/clear/route.ts`
- `src/app/api/admin/email-failures/[id]/review/route.ts`
- `src/lib/waitlist.ts`
- `src/lib/nomination.ts`
- `src/lib/membership-cancellation-requests.ts`
- `src/lib/membership-cancellation-admin.ts`
- `prisma/schema.prisma`

## Main observations

- Email sends are logged as `QUEUED`, `SENT`, `FAILED`, or `BOUNCED`.
- Sensitive/token-bearing templates avoid persisted HTML bodies and are not retried automatically.
- Non-sensitive failed emails with persisted HTML can be retried by `retryFailedEmails`, with limited attempts and admin alerting on exhaustion.
- SES/SNS feedback is signature-verified and idempotency-claimed before suppression ingestion.
- Suppression handling records permanent bounce/complaint and transient-bounce thresholds.
- Admin health UI exposes active suppressions and exhausted email failures, with clear/review actions.

## Top risks to verify

- Important token-bearing lifecycle emails are intentionally non-retryable. If sending fails after state changes, users may have no self-service next step unless admin recovery is visible and reliable.
- No dedicated `src/app/api/cron/email-retry/route.ts` was found in static route inspection. Verify how `retryFailedEmails` is scheduled.
- `sendToAdmins` catches per-admin failures. Verify critical alerts still reach an operator if all admin recipients are suppressed or undeliverable.
- Suppression clear/review actions exist, but static review did not find a guided resend path for the affected lifecycle email.
- Exhausted failure review appears audit-based while the `EmailLog` remains failed. Verify metrics and admin screens clearly distinguish reviewed from unresolved failures.

## Likely follow-up issues

- Add operator recovery for failed token-bearing lifecycle emails: reissue/resend action plus clear next-step guidance.
- Verify and document the email retry scheduler entrypoint, or add one if missing.
- Add health/dashboard visibility for critical non-retryable email failures.
- Add tests for suppression ingestion, clear action, and lifecycle resend/reissue flows.
- Add alert escalation if critical admin notifications cannot be delivered to any admin recipient.

## Recommended tests/static checks

- Unit tests for retryable versus non-retryable template behavior.
- SES/SNS duplicate notification and suppression-threshold tests.
- Scheduler/cron test proving `retryFailedEmails` runs in the deployed environment.
- Admin UI tests for exhausted email failures and suppression clearing.
- Static check that new token-bearing templates choose retry/redaction behavior explicitly.

## Sensitive findings requiring private handling, if any

- Keep exact token email failure and recovery mechanics private until any gaps are fixed.
- Do not publish email addresses, token URLs, or provider payload examples.

## Uncertainty/to-verify list

- To verify: actual scheduler wiring for email retry.
- To verify: whether non-retryable email failures are reviewed daily by operators.
- To verify: whether suppression-cleared users receive automatic or manual resend guidance.
- To verify: whether email content redaction is consistent across logs, audit, and admin screens.

## Validation notes

- Static review only.
- No live email, SES/SNS, or SMTP calls were performed.
