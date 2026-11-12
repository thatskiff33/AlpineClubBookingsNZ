/**
 * F16 (#1887): the ProcessedWebhookEvent claim is a processing LEASE. A
 * PROCESSING claim older than this window is treated as a crashed prior
 * attempt and taken over; a fresher one forces a provider retry. Sized well
 * above real handler runtime (seconds) and far below Stripe's redelivery
 * backoff, so a live handler is never pre-empted by a concurrent redelivery.
 *
 * A plain module (#4532) so a handler's own claim - the alert of a Stripe
 * payment the app did not create (`unrecognised-stripe-payment.ts`) - can use
 * the same bound for "the sender died" without importing the dispatcher.
 */
export const STRIPE_WEBHOOK_PROCESSING_LEASE_MINUTES = 15;
