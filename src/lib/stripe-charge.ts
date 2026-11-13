import { boundedStripeRequest, getStripe } from "@/lib/stripe";

/**
 * #4911 (`INV-PAY-153`): the PaymentIntent behind a charge, for a dispute event
 * whose own `payment_intent` is empty. Bounded, no retries: a webhook's read.
 * It lives beside `stripe.ts` only to keep that module within its size budget.
 */
export async function getChargePaymentIntentId(chargeId: string, timeoutMs: number): Promise<string | null> {
  const stripe = await getStripe();
  const charge = await stripe.charges.retrieve(chargeId, {}, boundedStripeRequest(timeoutMs));
  const intent = charge.payment_intent;
  if (!intent) return null;
  return typeof intent === "string" ? intent : intent.id;
}
