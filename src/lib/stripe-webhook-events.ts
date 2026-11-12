/**
 * #4104 review (ops 11): THE STRIPE EVENTS THE CLUB'S WEBHOOK ENDPOINT MUST BE
 * SUBSCRIBED TO - the one list the setup wizard shows (`WebhookStep`),
 * `DEPLOYMENT.md` points at, and `stripe-webhook-events.test.ts` holds to the
 * dispatcher (`processStripeWebhookEvent`): every event here has a handler. Plain
 * module, so the client wizard can import it.
 *
 * `refund.failed` (#4104) tells the app that a card refund Stripe first accepted
 * as pending has failed, so it is owed again; the payments cron's read-back
 * finds one only while it is still recorded pending.
 *
 * The four `charge.dispute.*` events (#4911, `INV-PAY-151`) record a
 * cardholder's dispute, alert Finance, and hold the capture's refunds and
 * credits while it is open or lost.
 */
export const STRIPE_WEBHOOK_EVENT_TYPES = [
  "payment_intent.succeeded",
  "payment_intent.payment_failed",
  "payment_intent.canceled",
  "payment_intent.requires_action",
  "payment_intent.processing",
  "setup_intent.succeeded",
  "setup_intent.setup_failed",
  "setup_intent.canceled",
  "charge.refunded",
  "refund.failed",
  "charge.dispute.created",
  "charge.dispute.funds_withdrawn",
  "charge.dispute.funds_reinstated",
  "charge.dispute.closed",
] as const;
