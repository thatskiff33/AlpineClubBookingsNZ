/**
 * F16 (#1887): the Stripe webhook's ProcessedWebhookEvent claim is a processing
 * LEASE. A PROCESSING claim older than this window is treated as a crashed prior
 * attempt and taken over; a fresher one forces a provider retry. Sized well
 * above real handler runtime (seconds) and far below Stripe's redelivery
 * backoff, so a live handler is never pre-empted by a concurrent redelivery.
 *
 * A leaf module (#4647), so a handler that sizes its own window from the lease
 * (`unrecognised-stripe-payment.ts`) reads the one value without importing the
 * webhook service that imports it.
 */
export const STRIPE_WEBHOOK_PROCESSING_LEASE_MINUTES = 15;
