# Issue #815: Stripe/Xero/SES Idempotency and Replay Review

## Issue

Review Stripe, Xero, and SES/SNS provider boundaries for idempotency, replay handling, retry safety, duplicate processing, provider/local mismatch, token handling, redaction, outbox/reconciliation, and failure visibility.

## Scope reviewed

- Static review only.
- No live Stripe, Xero, SES, Sentry, production database, production backup, webhook replay, DAST, load test, or browser automation was used.
- Sensitive attack details are intentionally kept high-level.

## Files/directories inspected

- `src/app/api/webhooks/stripe/route.ts`
- `src/app/api/webhooks/xero/route.ts`
- `src/app/api/webhooks/ses-sns/route.ts`
- `src/lib/stripe-webhook-service.ts`
- `src/lib/xero-inbound-reconciliation.ts`
- `src/lib/xero-operation-outbox.ts`
- `src/lib/xero-token-store.ts`
- `src/lib/xero-api-client.ts`
- `src/lib/ses-sns.ts`
- `src/lib/email-suppression.ts`
- `prisma/schema.prisma`
- Prior reports: `issue-812-security-route-boundary-review.md`, `issue-813-lifecycle-state-machine-review.md`

## Main observations

- Stripe webhooks are signature-verified, bounded in size, and processed through a `ProcessedWebhookEvent` claim. Duplicate Stripe event IDs return success without reprocessing.
- Stripe webhook processing deletes the idempotency claim when handler work fails, allowing retry. Amount mismatch and late-captured-cancelled-booking paths raise admin visibility.
- Xero webhooks are HMAC-verified, bounded, persisted as `XeroInboundEvent`, and reconciled asynchronously. Event correlation is based on category/type/resource/date.
- SES/SNS webhooks are bounded, SNS-signature verified, idempotency-claimed, and routed into suppression handling.
- Xero OAuth tokens are encrypted at rest with AES-GCM, and refresh failure paths notify admins to reconnect.
- Xero outbound work uses an operational outbox with idempotency/correlation metadata and admin retry/requeue routes.

## Top risks to verify

- `ProcessedWebhookEvent.eventId` is globally unique rather than source-scoped. Verify this is intentional and cannot cause cross-provider collision or replay side effects.
- Stripe and SES/SNS replay defense appears to rely mainly on provider signature verification plus durable event ID dedupe. Verify whether any additional freshness-window policy is required for captured webhook bodies.
- SES/SNS signature version 1 is accepted. Verify whether SHA1-based SNS signatures remain acceptable for current security policy.
- Xero inbound events can be claimed as `PROCESSING`; no automatic stale `PROCESSING` reset was found in static review. Worker failure after claim may block replay.
- Xero outbound operations may remain `RUNNING` if an unexpected dispatch-level error happens outside a helper that marks the operation failed.
- Admin health summaries do not appear to make every provider-local mismatch equally visible, especially stale `RUNNING`/`PROCESSING` provider work.

## Likely follow-up issues

- Add source-scoped provider idempotency tests and document whether global event ID uniqueness is intentional.
- Add stale `PROCESSING` recovery for Xero inbound events, or make manual replay safely claim stale rows.
- Add stale `RUNNING` recovery and admin visibility for Xero outbox operations.
- Add a security review item for SNS signature-version policy.
- Add operator-facing provider mismatch checks for stuck provider work that is neither `PENDING` nor freshly failed.

## Recommended tests/static checks

- Unit tests for duplicate Stripe, SES/SNS, and Xero webhook delivery.
- Unit tests for failed webhook handling that releases idempotency claims where retry is intended.
- Static check or migration test for `ProcessedWebhookEvent` uniqueness semantics.
- Xero inbound reconciliation tests for stale `PROCESSING` recovery.
- Xero outbox tests for unexpected dispatch errors and admin health counts.

## Sensitive findings requiring private handling, if any

- If stale provider work or replay gaps are confirmed, keep exact trigger sequences and replay mechanics out of public issue bodies.
- Do not publish provider token, signature, or webhook payload details beyond high-level remediation language.

## Uncertainty/to-verify list

- To verify: whether webhook delivery timestamp/freshness checks exist elsewhere in middleware or infrastructure.
- To verify: whether background schedulers already reset stale Xero inbound/outbound processing states.
- To verify: whether all provider mismatch alerts reach a monitored admin channel.
- To verify: whether production SNS configuration only allows modern signature behavior.

## Validation notes

- Static review only.
- No application code was changed.
- No provider calls or production-like scans were run.
