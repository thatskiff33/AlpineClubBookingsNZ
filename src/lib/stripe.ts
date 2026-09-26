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
import { getOperationalStripeSecretKey } from "@/lib/stripe-config";
import { formatCents } from "@/lib/utils";
import type { ClubFormat } from "@/lib/club-format";
import {
  currencyHasTwoDecimalPlaces,
  twoDecimalPlacesRequiredMessage,
} from "@/lib/club-currency-minor-unit";

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
 * THE CHARGE CURRENCY IS THE CLUB'S STORED CURRENCY, AND NO CALLER STATES IT
 * (owner decision D1 on #3567; INV-SSOT-003, INV-CONFIG-006).
 *
 * Both wire calls below already require the club's `format`, for the
 * below-minimum refusal (#3565). The currency the card is charged in is worked
 * out from that same value here, so what a member is shown and what their card
 * is charged cannot come from two places: there is no `currency` argument left
 * to pass a second answer through. Until #3567 each of the six callers passed
 * `APP_STRIPE_CURRENCY`, which followed the server's `CURRENCY` variable, so a
 * club that changed its currency in the panel was shown one currency and
 * charged another. That constant is gone.
 *
 * WHAT A CHANGE OF CURRENCY DOES TO A CHARGE, stated because a Full Admin's save
 * is now a money-affecting act. An intent Stripe already holds keeps the
 * currency it was created in. A saved card charged later is charged in the new
 * one. A recovery retry that replays an idempotency key across the change sends
 * a different currency under the same key, which Stripe refuses. The panel's
 * confirmation counts those in-flight payments before the save (D2).
 *
 * A currency that does not count in hundredths is refused before Stripe is
 * called (D3): the amount is an integer of hundredths, and Stripe would read it
 * in the currency's own smallest unit. The rule's one home is
 * `club-currency-minor-unit.ts`.
 */
export class UnsupportedChargeCurrencyError extends Error {
  constructor(readonly currencyCode: string) {
    super(twoDecimalPlacesRequiredMessage(currencyCode));
    this.name = "UnsupportedChargeCurrencyError";
  }
}

/** The Stripe `currency` for a charge: the club's code, lower-cased. */
export function stripeChargeCurrency(format: ClubFormat): string {
  if (!currencyHasTwoDecimalPlaces(format.currencyCode)) {
    throw new UnsupportedChargeCurrencyError(format.currencyCode);
  }
  return format.currencyCode.toLowerCase();
}

/**
 * Stripe's minimum charge for the two-decimal currencies this product charges
 * in, as 50 of the currency's hundredths (owner decision D7 on #3567). Stripe's
 * real minimum varies a little by currency (GBP's is 30p), and Stripe refuses a
 * charge below its own figure itself, so this check only has to stop the
 * obviously-too-small amount early with a readable message.
 */
const STRIPE_MINIMUM_AMOUNT_CENTS = 50;

function refuseBelowMinimum(amountCents: number, format: ClubFormat): void {
  if (amountCents > 0 && amountCents < STRIPE_MINIMUM_AMOUNT_CENTS) {
    throw new Error(`Amount ${formatCents(amountCents, format)} is below the Stripe minimum (${formatCents(STRIPE_MINIMUM_AMOUNT_CENTS, format)})`);
  }
}

/**
 * Create a PaymentIntent for confirmed bookings (immediate charge).
 * Used when all guests are members OR check-in is <= 7 days away.
 */
export async function createPaymentIntent({
  amountCents,
  format,
  customerId,
  metadata,
  idempotencyKey,
}: {
  amountCents: number;
  /** The club's format: the charge currency and the below-minimum refusal. */
  format: ClubFormat;
  customerId?: string;
  metadata?: Record<string, string>;
  idempotencyKey?: string;
}): Promise<Stripe.PaymentIntent> {
  const currency = stripeChargeCurrency(format);
  refuseBelowMinimum(amountCents, format);
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
  format,
  customerId,
  paymentMethodId,
  metadata,
  idempotencyKey,
}: {
  amountCents: number;
  /** The club's format: the charge currency and the below-minimum refusal. */
  format: ClubFormat;
  customerId: string;
  paymentMethodId: string;
  metadata?: Record<string, string>;
  idempotencyKey?: string;
}): Promise<Stripe.PaymentIntent> {
  const currency = stripeChargeCurrency(format);
  refuseBelowMinimum(amountCents, format);
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
  organisationId,
}: {
  email: string;
  name: string;
  /**
   * The OWNING MEMBER, or null when the booking is owned by an organisation
   * (#3369). Exactly one of this and {@link organisationId} is set, which is
   * what `Booking_owner_exactly_one` guarantees at the database.
   */
  memberId: string | null;
  /** The owning organisation, when there is one (#3369). */
  organisationId?: string | null;
}): Promise<Stripe.Customer> {
  const stripe = await getStripe();
  const existing = await stripe.customers.list({
    email,
    limit: 100,
  });

  // #3369: the stored customer is matched on WHO OWNS THE BOOKING, and a school
  // is now an organisation rather than an invented person. Matching a null
  // member id against absent metadata would never match, so every payment link
  // for a school would mint a fresh Stripe customer — a duplicate per payment,
  // which is precisely the provider-side mess this programme exists to end.
  const ownerKey: "memberId" | "organisationId" = memberId
    ? "memberId"
    : "organisationId";
  const ownerValue = memberId ?? organisationId ?? null;
  if (!ownerValue) {
    throw new Error(
      "A Stripe customer needs an owner: neither a member nor an organisation was given (#3369).",
    );
  }

  const matchingCustomer = existing.data.find((customer) => {
    if ("deleted" in customer && customer.deleted) {
      return false;
    }

    return customer.metadata?.[ownerKey] === ownerValue;
  });

  if (matchingCustomer) {
    return matchingCustomer;
  }

  return stripe.customers.create({
    email,
    name,
    metadata: { [ownerKey]: ownerValue },
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
 * Retrieve a PaymentMethod by ID (#3266).
 *
 * Thin wrapper, and deliberately so: it throws the SDK error unchanged. The
 * caller decides what a failure means, because the two failures matter
 * differently — `resource_missing` (see `isStripeResourceMissingError` in
 * `stripe-errors.ts`) says Stripe no longer holds the card, while anything else
 * says nothing about the card at all. `create-setup-intent` uses it to ask the
 * PROVIDER whether a succeeded SetupIntent's card is still attached to the
 * customer before re-adopting it onto a Payment row that carries no card.
 */
export async function getPaymentMethod(
  paymentMethodId: string
): Promise<Stripe.PaymentMethod> {
  const stripe = await getStripe();
  return stripe.paymentMethods.retrieve(paymentMethodId);
}

/**
 * Detach a saved PaymentMethod from its Customer (#3268). Used when the
 * auto-charge cron has classified the card as permanently unusable: detaching
 * it at the provider is what makes "this card may not be re-adopted anywhere"
 * true — the setup-intent route (#3266) asks Stripe whether a candidate pm is
 * still attached before re-adopting it, and a detached pm answers no. Plain
 * call, no idempotency key: detaching an already-detached or never-attached pm
 * fails with `invalid_request_error`, and ONLY that failure does the caller
 * (`retireUnusableSavedCard`) treat as success — the pm is unusable either way.
 * Any other failure (an `api_error`, a rate limit, a connection error) is
 * rethrown there so no row is cleared while the card may still be attached
 * (INV-PAY-054).
 */
export async function detachPaymentMethod(
  paymentMethodId: string
): Promise<Stripe.PaymentMethod> {
  const stripe = await getStripe();
  return stripe.paymentMethods.detach(paymentMethodId);
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
