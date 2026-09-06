/**
 * `import "server-only"` — this module reaches the Stripe client through
 * `stripe.ts`, which refuses a browser bundle (`INV-OPS-013`); saying so here
 * keeps the refusal at the first server-only edge rather than a transitive one.
 */
import "server-only";

import type Stripe from "stripe";
import logger from "@/lib/logger";
import { getPaymentMethod } from "@/lib/stripe";
import { isStripeResourceMissingError } from "@/lib/stripe-errors";
import { stripeReferenceId } from "@/lib/stripe-references";

/**
 * #3266 — asks STRIPE whether the card a succeeded SetupIntent saved is still
 * attached to the customer this booking charges with.
 *
 * Reached only when a succeeded SetupIntent names a card the Payment row does
 * not carry. Two very different histories produce that state, and nothing
 * local tells them apart: the member confirmed a card seconds ago and the
 * `setup_intent.succeeded` webhook has not landed yet (re-adopt the card), or a
 * charge path met a terminal Stripe refusal, detached the card and cleared it
 * from the row (#3268 — never re-adopt it). The provider knows: a detached or
 * deleted PaymentMethod no longer names this customer, or no longer exists.
 * That is `INV-PAY-052`.
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

/**
 * What a SUCCEEDED SetupIntent may do to the card column of the Payment row
 * that names it (#3266, `INV-PAY-052`).
 */
export type SucceededSetupIntentCardVerdict =
  /** The intent names no payment method; there is nothing to adopt. */
  | { outcome: "no_payment_method" }
  /** The row already carries exactly this intent's card; a stamp changes nothing. */
  | { outcome: "already_on_row"; paymentMethodId: string }
  /** Stripe still holds the card for the row's customer; it may be stamped. */
  | { outcome: "attached"; paymentMethodId: string }
  /** Detached, another customer's, or gone; it must never be stamped. */
  | { outcome: "detached"; paymentMethodId: string };

/**
 * The one rule for adopting a succeeded SetupIntent's card onto a Payment row,
 * shared by `create-setup-intent`'s `alreadySaved` arm and the
 * `setup_intent.succeeded` webhook so the two cannot drift (`INV-SSOT-001`).
 *
 * The fast path is deliberately narrow: only a row that ALREADY carries this
 * intent's own card skips the provider. A row carrying no card, or a different
 * card, gets the attached-check — a row naming card B while intent X saved card
 * A is not evidence that A may still be charged, and neither is the bare fact
 * that X once succeeded. The caller supplies the row it read; whether that row
 * still names this intent is the caller's guard (`markBookingSetupIntentSucceeded`
 * re-checks it under the write), not this function's.
 */
export async function classifySucceededSetupIntentCard({
  bookingId,
  setupIntent,
  row,
}: {
  bookingId: string;
  setupIntent: Pick<Stripe.SetupIntent, "id" | "payment_method" | "customer">;
  row: { stripePaymentMethodId: string | null; stripeCustomerId: string | null };
}): Promise<SucceededSetupIntentCardVerdict> {
  const paymentMethodId = stripeReferenceId(setupIntent.payment_method);
  if (!paymentMethodId) {
    return { outcome: "no_payment_method" };
  }
  if (row.stripePaymentMethodId === paymentMethodId) {
    return { outcome: "already_on_row", paymentMethodId };
  }
  const customerId =
    row.stripeCustomerId ?? stripeReferenceId(setupIntent.customer);
  const attached = await setupIntentCardStillAttached({
    bookingId,
    setupIntentId: setupIntent.id,
    paymentMethodId,
    customerId,
  });
  return { outcome: attached ? "attached" : "detached", paymentMethodId };
}
