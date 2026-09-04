/**
 * `import "server-only"` — this module reaches the Stripe client through
 * `stripe.ts`, which refuses a browser bundle (`INV-OPS-013`); saying so here
 * keeps the refusal at the first server-only edge rather than a transitive one.
 */
import "server-only";

import logger from "@/lib/logger";
import { getPaymentMethod } from "@/lib/stripe";
import { isStripeResourceMissingError } from "@/lib/stripe-errors";

/**
 * The id behind a Stripe reference, which the SDK types as either a bare id or
 * an expanded object.
 */
export function stripeReferenceId(
  reference: string | { id: string } | null | undefined,
): string | null {
  if (typeof reference === "string") return reference;
  return reference?.id ?? null;
}

/**
 * #3266 — asks STRIPE whether the card a succeeded SetupIntent saved is still
 * attached to the customer this booking charges with.
 *
 * `create-setup-intent` reaches this only when the Payment row carries a
 * succeeded SetupIntent and NO card. Two very different histories produce that
 * state, and nothing local tells them apart: the member confirmed a card
 * seconds ago and the `setup_intent.succeeded` webhook has not landed yet
 * (re-adopt the card), or a charge path met a terminal Stripe refusal,
 * detached the card and cleared it from the row (#3268 — never re-adopt it).
 * The provider knows: a detached or deleted PaymentMethod no longer names this
 * customer, or no longer exists. That is `INV-PAY-054`.
 *
 * Only `resource_missing` is read as "gone". Any other failure — outage, bad
 * key, rate limit — is rethrown, because it says nothing about the card and
 * guessing either way would be wrong: re-adopting risks charging a dead card,
 * minting afresh would strip a live one.
 */
export async function setupIntentCardStillAttached({
  bookingId,
  setupIntentId,
  paymentMethodId,
  customerId,
}: {
  bookingId: string;
  setupIntentId: string;
  paymentMethodId: string;
  customerId: string | null;
}): Promise<boolean> {
  try {
    const paymentMethod = await getPaymentMethod(paymentMethodId);
    const attachedTo = stripeReferenceId(paymentMethod.customer);
    return customerId !== null && attachedTo === customerId;
  } catch (error) {
    if (isStripeResourceMissingError(error)) {
      logger.info(
        { bookingId, setupIntentId, paymentMethodId },
        "SetupIntent payment method no longer exists at Stripe; treating the saved card as retired",
      );
      return false;
    }
    throw error;
  }
}
