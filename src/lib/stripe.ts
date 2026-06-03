import Stripe from "stripe";
import { APP_STRIPE_CURRENCY } from "@/config/operational";

function getStripeClient(): Stripe {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) {
    throw new Error("STRIPE_SECRET_KEY is not set");
  }
  return new Stripe(key, {
    apiVersion: Stripe.API_VERSION,
    typescript: true,
  });
}

// Lazy-initialize to avoid throwing at import time during tests
let _stripe: Stripe | null = null;

export function getStripe(): Stripe {
  if (!_stripe) {
    _stripe = getStripeClient();
  }
  return _stripe;
}

export const stripe = new Proxy({} as Stripe, {
  get(_, prop) {
    return (getStripe() as unknown as Record<string | symbol, unknown>)[prop];
  },
});

/**
 * Create a PaymentIntent for confirmed bookings (immediate charge).
 * Used when all guests are members OR check-in is <= 7 days away.
 */
export const STRIPE_MINIMUM_AMOUNT_CENTS = 50; // Stripe NZD minimum charge

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
  return stripe.paymentIntents.retrieve(paymentIntentId);
}

const CANCELLABLE_PAYMENT_INTENT_STATUSES = new Set<Stripe.PaymentIntent.Status>([
  "requires_payment_method",
  "requires_confirmation",
  "requires_action",
  "requires_capture",
  "processing",
]);

export async function cancelPaymentIntentIfCancellableWithResult(
  paymentIntentId: string
): Promise<{ paymentIntent: Stripe.PaymentIntent; canceled: boolean }> {
  const paymentIntent = await getPaymentIntent(paymentIntentId);

  if (!CANCELLABLE_PAYMENT_INTENT_STATUSES.has(paymentIntent.status)) {
    return { paymentIntent, canceled: false };
  }

  return {
    paymentIntent: await stripe.paymentIntents.cancel(paymentIntentId, {
      cancellation_reason: "requested_by_customer",
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

  return stripe.setupIntents.cancel(setupIntentId);
}

/**
 * Construct and verify a Stripe webhook event.
 */
export function constructWebhookEvent(
  payload: string | Buffer,
  signature: string,
  webhookSecret: string
): Stripe.Event {
  return stripe.webhooks.constructEvent(payload, signature, webhookSecret);
}
