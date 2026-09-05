/**
 * `import "server-only"` makes the production build REFUSE this module in a
 * browser bundle, at any depth (`INV-OPS-013`, #2850). Operator CLIs reach it
 * under plain Node, where that marker would throw at import, so every `tsx`
 * invocation that reaches it runs with `--conditions=react-server` — which
 * resolves `server-only` to an empty module. `cli-server-only-reach-census.test.ts`
 * enforces that pairing; `docs/invariants/operations.md` carries the reasoning.
 */
import "server-only";

import Stripe from "stripe";
import { APP_STRIPE_CURRENCY } from "@/config/operational";
import { getOperationalStripeSecretKey } from "@/lib/stripe-config";

// DB-only credential resolution (#2082): the secret key lives in the encrypted
// IntegrationCredential store, so client construction is now ASYNC. We memoize
// the client keyed on the resolved secret so a wizard key change (verify-reset)
// rebuilds the client on the next call instead of clinging to a stale key —
// important for the long-lived cron-leader process.
let _stripe: Stripe | null = null;
let _stripeKey: string | null = null;

export async function getStripe(): Promise<Stripe> {
  const key = await getOperationalStripeSecretKey();
  if (!key) {
    throw new Error("Stripe secret key is not configured");
  }
  if (!_stripe || _stripeKey !== key) {
    _stripe = new Stripe(key, {
      apiVersion: Stripe.API_VERSION,
      typescript: true,
    });
    _stripeKey = key;
  }
  return _stripe;
}

/**
 * Create a PaymentIntent for confirmed bookings (immediate charge).
 * Used when all guests are members OR check-in is <= 7 days away.
 */
const STRIPE_MINIMUM_AMOUNT_CENTS = 50; // Stripe NZD minimum charge

export async function createPaymentIntent({
  amountCents,
  currency = APP_STRIPE_CURRENCY,
  customerId,
  metadata,
  idempotencyKey,
}: {
  amountCents: number;
  currency?: string;
  customerId?: string;
  metadata?: Record<string, string>;
  idempotencyKey?: string;
}): Promise<Stripe.PaymentIntent> {
  if (amountCents > 0 && amountCents < STRIPE_MINIMUM_AMOUNT_CENTS) {
    throw new Error(`Amount ${amountCents} cents is below Stripe minimum (${STRIPE_MINIMUM_AMOUNT_CENTS} cents)`);
  }
  const stripe = await getStripe();
  return stripe.paymentIntents.create(
    {
      amount: amountCents,
      currency,
      customer: customerId,
      metadata: metadata ?? {},
      automatic_payment_methods: { enabled: true },
    },
    idempotencyKey ? { idempotencyKey } : undefined,
  );
}

/**
 * Create a SetupIntent for pending bookings (save card, charge later).
 * Used when booking has non-member guests AND check-in is > 7 days away.
 */
export async function createSetupIntent({
  customerId,
  metadata,
  idempotencyKey,
}: {
  customerId: string;
  metadata?: Record<string, string>;
  idempotencyKey?: string;
}): Promise<Stripe.SetupIntent> {
  const stripe = await getStripe();
  return stripe.setupIntents.create(
    {
      customer: customerId,
      metadata: metadata ?? {},
      automatic_payment_methods: { enabled: true },
    },
    idempotencyKey ? { idempotencyKey } : undefined,
  );
}

/**
 * Charge a saved PaymentMethod (used when pending booking auto-confirms).
 */
export async function chargePaymentMethod({
  amountCents,
  currency = APP_STRIPE_CURRENCY,
  customerId,
  paymentMethodId,
  metadata,
  idempotencyKey,
}: {
  amountCents: number;
  currency?: string;
  customerId: string;
  paymentMethodId: string;
  metadata?: Record<string, string>;
  idempotencyKey?: string;
}): Promise<Stripe.PaymentIntent> {
  if (amountCents > 0 && amountCents < STRIPE_MINIMUM_AMOUNT_CENTS) {
    throw new Error(`Amount ${amountCents} cents is below Stripe minimum (${STRIPE_MINIMUM_AMOUNT_CENTS} cents)`);
  }
  const stripe = await getStripe();
  return stripe.paymentIntents.create(
    {
      amount: amountCents,
      currency,
      customer: customerId,
      payment_method: paymentMethodId,
      off_session: true,
      confirm: true,
      metadata: metadata ?? {},
    },
    idempotencyKey ? { idempotencyKey } : undefined,
  );
}

/**
 * Create or retrieve a Stripe Customer for a member.
 */
export async function findOrCreateCustomer({
  email,
  name,
  memberId,
}: {
  email: string;
  name: string;
  memberId: string;
}): Promise<Stripe.Customer> {
  const stripe = await getStripe();
  const existing = await stripe.customers.list({
    email,
    limit: 100,
  });

  const matchingCustomer = existing.data.find((customer) => {
    if ("deleted" in customer && customer.deleted) {
      return false;
    }

    return customer.metadata?.memberId === memberId;
  });

  if (matchingCustomer) {
    return matchingCustomer;
  }

  return stripe.customers.create({
    email,
    name,
    metadata: { memberId },
  });
}

/**
 * Process a refund based on cancellation policy.
 */
export async function processRefund({
  paymentIntentId,
  amountCents,
  reason = "requested_by_customer",
  metadata,
  idempotencyKey,
}: {
  paymentIntentId: string;
  amountCents: number;
  reason?: Stripe.RefundCreateParams.Reason;
  metadata?: Record<string, string>;
  idempotencyKey?: string;
}): Promise<Stripe.Refund> {
  const stripe = await getStripe();
  const params = {
    payment_intent: paymentIntentId,
    amount: amountCents,
    reason,
    metadata: metadata ?? {},
  };

  if (idempotencyKey) {
    return stripe.refunds.create(params, { idempotencyKey });
  }

  return stripe.refunds.create(params);
}

export async function listRefundsForCharge(chargeId: string): Promise<Stripe.Refund[]> {
  const stripe = await getStripe();
  const refunds: Stripe.Refund[] = [];
  const list = stripe.refunds.list({ charge: chargeId, limit: 100 });

  for await (const refund of list) {
    refunds.push(refund);
  }

  return refunds;
}

/**
 * Retrieve a PaymentIntent by ID.
 */
export async function getPaymentIntent(
  paymentIntentId: string
): Promise<Stripe.PaymentIntent> {
  const stripe = await getStripe();
  return stripe.paymentIntents.retrieve(paymentIntentId);
}

/**
 * #3170 (epic #2797): raise what an EXISTING, unpaid PaymentIntent asks for.
 *
 * The one operation that lets a booking edit carry ONE request while more than
 * one review task contributes a share to it. Creating a second intent instead is
 * what loses money here: minting queues every other outstanding `ADDITIONAL`
 * transaction on the payment for cancellation, and the payment record carries a
 * single outstanding additional rather than a sum, so the second ask silently
 * replaced the first.
 *
 * Stripe's own idempotency cannot do this: replaying the create key returns the
 * ORIGINAL intent at its ORIGINAL amount, and replaying it with a different
 * amount is an `idempotency_error`. Updating is the only way to restate an ask.
 *
 * NOT a capture and NOT a charge - it changes what the member will be asked for
 * when they choose to pay. Stripe refuses an amount change on an intent that has
 * already succeeded or been cancelled, and the caller refuses those states before
 * it gets here, so a rejection from Stripe means the caller's pre-check raced
 * something and the failure is loud rather than silent.
 */
export async function updatePaymentIntentAmount(
  paymentIntentId: string,
  amountCents: number
): Promise<Stripe.PaymentIntent> {
  const stripe = await getStripe();
  return stripe.paymentIntents.update(paymentIntentId, {
    amount: amountCents,
  });
}

const CANCELLABLE_PAYMENT_INTENT_STATUSES = new Set<Stripe.PaymentIntent.Status>([
  "requires_payment_method",
  "requires_confirmation",
  "requires_action",
  "requires_capture",
  "processing",
]);

/**
 * WHY THE REASON IS A PARAMETER (#3220).
 *
 * Stripe stores `cancellation_reason` on the intent for good, and it is what the
 * club's own Stripe record says about why an ask died. Every caller before #3220
 * was cancelling because the member's booking went away, so
 * `requested_by_customer` was true for all of them and hard-coding it cost
 * nothing. #3220 added a caller for which it is simply UNTRUE: a payment
 * recovery that has run out of attempts is the club abandoning an ask the member
 * never declined, and recording that as the customer's request would misstate a
 * money decision in the provider's own ledger.
 *
 * A parameter rather than a second function, because the decision this helper
 * makes - IS this intent still cancellable at all - is the part that must not be
 * copied. `abandoned` is Stripe's own value for exactly this case.
 */
export type PaymentIntentCancellationReason =
  Stripe.PaymentIntentCancelParams.CancellationReason;

export async function cancelPaymentIntentIfCancellableWithResult(
  paymentIntentId: string,
  options?: { cancellationReason?: PaymentIntentCancellationReason }
): Promise<{ paymentIntent: Stripe.PaymentIntent; canceled: boolean }> {
  const paymentIntent = await getPaymentIntent(paymentIntentId);

  if (!CANCELLABLE_PAYMENT_INTENT_STATUSES.has(paymentIntent.status)) {
    return { paymentIntent, canceled: false };
  }

  const stripe = await getStripe();
  return {
    paymentIntent: await stripe.paymentIntents.cancel(paymentIntentId, {
      // The pre-#3220 callers all pass nothing and keep the reason they had.
      cancellation_reason: options?.cancellationReason ?? "requested_by_customer",
    }),
    canceled: true,
  };
}

/**
 * Best-effort cancellation of an in-flight PaymentIntent when the booking is
 * no longer payable (for example, after the booking is cancelled).
 */
export async function cancelPaymentIntentIfCancellable(
  paymentIntentId: string
): Promise<Stripe.PaymentIntent | null> {
  const result = await cancelPaymentIntentIfCancellableWithResult(paymentIntentId);
  return result.canceled ? result.paymentIntent : null;
}

/**
 * Retrieve a SetupIntent by ID.
 */
export async function getSetupIntent(
  setupIntentId: string
): Promise<Stripe.SetupIntent> {
  const stripe = await getStripe();
  return stripe.setupIntents.retrieve(setupIntentId);
}

/**
 * Best-effort cancellation of an in-flight SetupIntent when a pending booking
 * is cancelled or otherwise leaves the saved-card flow.
 */
export async function cancelSetupIntentIfCancellable(
  setupIntentId: string
): Promise<Stripe.SetupIntent | null> {
  const setupIntent = await getSetupIntent(setupIntentId);
  const cancellableStatuses = new Set([
    "requires_payment_method",
    "requires_confirmation",
    "requires_action",
    "processing",
  ]);

  if (!cancellableStatuses.has(setupIntent.status)) {
    return null;
  }

  const stripe = await getStripe();
  return stripe.setupIntents.cancel(setupIntentId);
}

/**
 * Construct and verify a Stripe webhook event.
 *
 * NOTE (#2082): the export NAME `constructWebhookEvent` is intentionally
 * preserved through the async migration — `api-route-boundaries.test.ts`
 * regex-pins it as the Stripe webhook signature boundary, and five test files
 * mock it by this name. It is now async because the underlying client resolves
 * its secret key from the DB store. The webhook signing secret is supplied by
 * the caller (the route resolves it fail-closed from the dedicated resolver).
 */
export async function constructWebhookEvent(
  payload: string | Buffer,
  signature: string,
  webhookSecret: string
): Promise<Stripe.Event> {
  const stripe = await getStripe();
  return stripe.webhooks.constructEvent(payload, signature, webhookSecret);
}
