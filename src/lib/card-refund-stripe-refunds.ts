import type Stripe from "stripe";

import { listRefundsForPaymentIntent } from "@/lib/stripe";
import { stripeReferenceId } from "@/lib/stripe-references";

/**
 * #4368 review F3 (`INV-SSOT`; `INV-PAY-145`): THE ONE BOUNDED READ OF THE
 * REFUNDS STRIPE HOLDS ON ONE CARD CHARGE, before a card refund row asks
 * Stripe again or is put back to: one request for the intent, 100 results, a
 * ten-second timeout and no network retries; more results than one page, or a
 * failed read, throws, so nothing unread can authorise a request. The list is
 * by intent already, so a refund naming another intent is not this charge's.
 * Read outside every transaction. Its readers: the charge-backed recovery
 * preflight (`checkCardRefundResend`), a superseded intent's first request
 * (`superseded-first-request-answer.ts`) and "Try the card again"
 * (`card-refund-dead-row-actions.ts`).
 */
export async function listRefundsOnCardCharge(paymentIntentId: string): Promise<Stripe.Refund[]> {
  const refunds = await listRefundsForPaymentIntent(paymentIntentId, { timeoutMs: 10_000, singlePage: true });
  return refunds.filter((refund) => !refund.payment_intent || stripeReferenceId(refund.payment_intent) === paymentIntentId);
}
