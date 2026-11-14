/**
 * The one webhook processing lease (`INV-INT-039`; F16, #1887). Every "claim
 * before you work" marker on an inbound provider event expires after this
 * window, and an expired claim is a crashed prior attempt that a later attempt
 * takes over, fenced so exactly one racer wins:
 *
 * - the Stripe and SES/SNS `ProcessedWebhookEvent` claim
 *   (`webhook-claim-lease.ts`): a PROCESSING claim older than this is taken
 *   over on redelivery; a fresher one forces a provider retry;
 * - a stored Xero inbound event left PROCESSING
 *   (`STALE_PROCESSING_XERO_INBOUND_EVENT_MINUTES` in `xero-stale-operations.ts`
 *   is this value): the automatic worker takes it over.
 *
 * Sized well above a live attempt's runtime (seconds; a Xero reconcile makes a
 * few calls of at most `XERO_HTTP_TIMEOUT_MS` each, plus rate-limit waits) and
 * far below Stripe's redelivery backoff, so a live attempt is not normally
 * pre-empted. A pre-empted one is harmless: every handler behind a lease is
 * idempotent on replay.
 *
 * A leaf module (#4647), so a handler that sizes its own window from the lease
 * (`unrecognised-stripe-payment.ts`) reads the one value without importing the
 * webhook service that imports it.
 */
export const WEBHOOK_PROCESSING_LEASE_MINUTES = 15;
