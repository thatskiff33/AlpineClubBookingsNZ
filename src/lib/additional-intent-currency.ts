import "server-only";

import { PaymentStatus, PaymentTransactionKind } from "@prisma/client";
import type Stripe from "stripe";

import type { AdditionalAsk } from "@/lib/additional-payment-ask";
import { queueSupersededAdditionalIntentCancellations } from "@/lib/booking-payment-cleanup";
import type { ClubFormat } from "@/lib/club-format";
import { stripeIdempotencyKeyForAskAmount } from "@/lib/payment-recovery-keys";
import {
  reconcilePaymentAggregates,
  upsertPaymentIntentTransaction,
} from "@/lib/payment-transactions";
import { createPaymentIntent, getPaymentIntent } from "@/lib/stripe";
import { stripeChargeCurrency } from "@/lib/stripe-charge-currency";

/**
 * An outstanding ADDITIONAL intent was minted in a currency the club no longer
 * charges in (#3567 review). Card charges follow the club's stored currency, so
 * handing back that intent's client secret — or raising its amount — would let
 * the member pay in the OLD currency while every screen shows the new one.
 *
 * True when Stripe's intent is in a different currency from the club's charge
 * currency. Read off the intent itself: `PaymentTransaction` stores no currency.
 */
export function intentCurrencyDiffers(
  intent: Pick<Stripe.PaymentIntent, "currency">,
  format: ClubFormat,
): boolean {
  return intent.currency.trim().toLowerCase() !== stripeChargeCurrency(format);
}

/**
 * What may be done with an intent in another currency (#3567 re-review), read
 * off Stripe's status — never assumed from the ledger, which lags the webhook:
 *
 * - `reissue`: the member has not paid (`requires_payment_method`,
 *   `requires_confirmation`, `requires_action`). Superseding it is safe.
 * - `in_flight`: `succeeded` or `processing` — the member HAS paid, or is paying,
 *   and the webhook has not landed yet (a 3DS return, a refresh). Re-issuing
 *   would queue the paid intent for cancellation, whose processor finds it
 *   captured and REFUNDS it, and then ask the member to pay again.
 * - `gone`: `canceled` (or `requires_capture`, which this product never asks
 *   for) — nothing to hand back and nothing to re-issue.
 */
export type StaleIntentAction = "reissue" | "in_flight" | "gone";

const REISSUABLE_STATUSES: ReadonlySet<string> = new Set([
  "requires_payment_method",
  "requires_confirmation",
  "requires_action",
]);

export function staleIntentAction(intent: Pick<Stripe.PaymentIntent, "status">): StaleIntentAction {
  if (REISSUABLE_STATUSES.has(intent.status)) return "reissue";
  if (intent.status === "succeeded" || intent.status === "processing") return "in_flight";
  return "gone";
}

/**
 * Re-issue an outstanding ADDITIONAL ask on a new intent in the club's current
 * currency, and supersede the old one — the same three steps, in the same order,
 * as `createModificationAdditionalPaymentIntent`:
 *
 * 1. mint the new intent, under a key discriminated by the intent it replaces,
 *    the new currency and the amount, so a retry converges on the same new
 *    intent and never collides with the key that minted the old one;
 * 2. write the new intent's ADDITIONAL row FIRST, carrying the same `reason` (a
 *    review-charge request is found by it) and the same carried balance;
 * 3. queue every other live ADDITIONAL intent on the payment for cancellation,
 *    which excludes the new one by id, then reconcile the payment so its
 *    additional pointer names the new intent.
 *
 * Stripe calls happen outside any transaction; nothing here takes a lock.
 */
export async function reissueAdditionalIntentInClubCurrency({
  format,
  bookingId,
  paymentId,
  staleIntentId,
  ask,
  reason,
  customerId,
}: {
  format: ClubFormat;
  bookingId: string;
  paymentId: string;
  staleIntentId: string;
  ask: AdditionalAsk;
  reason: string | null;
  customerId: string | null;
}): Promise<Stripe.PaymentIntent> {
  const currency = stripeChargeCurrency(format);
  const pi = await createPaymentIntent({
    format,
    amountCents: ask.amountCents,
    customerId: customerId ?? undefined,
    metadata: {
      bookingId,
      type: "modification_additional",
      reason: reason ?? "modification_additional_currency_reissue",
    },
    idempotencyKey: stripeIdempotencyKeyForAskAmount(
      `${staleIntentId}_reissue_${currency}`,
      ask.amountCents,
    ),
  });
  await upsertPaymentIntentTransaction({
    paymentId,
    kind: PaymentTransactionKind.ADDITIONAL,
    paymentIntentId: pi.id,
    amountCents: ask.amountCents,
    carriedAskCents: ask.carriedCents,
    status: PaymentStatus.PENDING,
    reason: reason ?? undefined,
    stripeCustomerId: customerId,
  });
  await queueSupersededAdditionalIntentCancellations({
    format,
    bookingId,
    paymentId,
    newPaymentIntentId: pi.id,
  });
  await reconcilePaymentAggregates({ paymentId });
  return pi;
}

/**
 * The edit review charge's RAISE (#3567 review). A later share raises the
 * request's existing intent with `updatePaymentIntentAmount`; if that intent was
 * minted in a currency the club no longer charges in, the raise would ask for
 * more in the OLD currency. So the raised ask is re-issued on a new intent in
 * the club's currency instead, and the old one superseded. The new row keeps the
 * request's `reason`, so the next share finds it. Returns the new intent's id,
 * or `null` when the currency is unchanged and the caller raises as before.
 */
export async function reissueRaisedAskIfCurrencyChanged(params: {
  format: ClubFormat;
  bookingId: string;
  paymentId: string;
  staleIntentId: string;
  ask: AdditionalAsk;
  reason: string;
}): Promise<string | null> {
  const live = await getPaymentIntent(params.staleIntentId);
  if (!intentCurrencyDiffers(live, params.format)) return null;
  // Paid, being paid, or gone: never superseded. `null` hands the raise back to
  // the caller's own path, where a captured or cancelled intent refuses the
  // amount update and the durable recovery takes over (#3567 re-review).
  if (staleIntentAction(live) !== "reissue") return null;
  const customerId = live.customer
    ? typeof live.customer === "string"
      ? live.customer
      : live.customer.id
    : null;
  const reissued = await reissueAdditionalIntentInClubCurrency({ ...params, customerId });
  return reissued.id;
}
