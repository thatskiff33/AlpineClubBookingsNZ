import "server-only";

import { PaymentStatus, PaymentTransactionKind } from "@prisma/client";
import type Stripe from "stripe";

import type { AdditionalAsk } from "@/lib/additional-payment-ask";
import { cancelSupersededAdditionalIntentsNow, queueSupersededAdditionalIntentCancellationRows } from "@/lib/booking-payment-cleanup";
import { withAdditionalAskQueueTransaction } from "@/lib/additional-ask-queue-transaction";
import type { ClubFormat } from "@/lib/club-format";
import logger from "@/lib/logger";
import { ADDITIONAL_ASK_INTENT_TYPE } from "@/lib/ordinary-ask-request";
import { stripeIdempotencyKeyForAskAmount } from "@/lib/payment-recovery-keys";
import { staleIntentAction } from "@/lib/stale-intent-action";
import { prisma } from "@/lib/prisma";
import {
  reconcilePaymentAggregates,
  upsertPaymentIntentTransaction,
} from "@/lib/payment-transactions";
import { createPaymentIntent, getPaymentIntent } from "@/lib/stripe";
import { bookingEndedBeforeAskMint, retireAskOnEndedBooking } from "@/lib/ended-booking-ask-guard";
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
 * Re-issue an outstanding ADDITIONAL ask on a new intent in the club's current
 * currency, and supersede the old one — the same three steps, in the same order,
 * as `createModificationAdditionalPaymentIntent`:
 *
 * 1. mint the new intent, under a key discriminated by the intent it replaces,
 *    the new currency and the amount, so a retry converges on the same new
 *    intent and never collides with the key that minted the old one;
 * 2. write the new intent's ADDITIONAL row FIRST, carrying the same `reason` (a
 *    review-charge request is found by it) and the same carried balance - and
 *    the stale row's provenance (#3954 round 8): its edit's invoice answer and
 *    the edit itself, which a later reduction reads off the live row;
 * 3. queue every other live ADDITIONAL intent on the payment for cancellation,
 *    which excludes the new one by id, then reconcile the payment so its
 *    additional pointer names the new intent.
 *
 * Stripe calls happen outside the global-then-Payment-row queue transaction.
 *
 * #4316 (`INV-ADDPAY-044`): it is a mint like the door's, so it runs the door's
 * two checks. A booking ended (CANCELLED or BUMPED) before the mint gets no new
 * intent; one ended by a cancel that landed before the row write has the new
 * intent retired as the cancel retires one. Either way it returns `null`, and
 * nothing is offered.
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
}): Promise<Stripe.PaymentIntent | null> {
  if (await bookingEndedBeforeAskMint(bookingId, null)) return null;
  const currency = stripeChargeCurrency(format);
  const pi = await createPaymentIntent({
    format,
    amountCents: ask.amountCents,
    customerId: customerId ?? undefined,
    metadata: {
      bookingId,
      type: ADDITIONAL_ASK_INTENT_TYPE,
      reason: reason ?? "modification_additional_currency_reissue",
    },
    idempotencyKey: stripeIdempotencyKeyForAskAmount(
      `${staleIntentId}_reissue_${currency}`,
      ask.amountCents,
    ),
  });
  // #3954 round 8: the same ask, so the same provenance. Read off the stale
  // row - which the supersede below retires - before the new row is written.
  // Best-effort: a failed read leaves both unrecorded, which a later
  // reduction reads as unsure (reported for a person), never as a guess.
  let stale: { hadIssuedXeroInvoice: boolean | null; bookingModificationId: string | null } | null = null;
  try {
    stale = await prisma.paymentTransaction.findUnique({
      where: { stripePaymentIntentId: staleIntentId },
      select: { hadIssuedXeroInvoice: true, bookingModificationId: true },
    });
  } catch (err) {
    logger.warn(
      { err, bookingId, staleIntentId },
      "Could not read a stale additional ask's provenance for its currency re-issue (#3954); the re-issue records none",
    );
  }
  const queued = await withAdditionalAskQueueTransaction(paymentId, ask, async (store) => {
    await upsertPaymentIntentTransaction({
      paymentId,
      store,
      kind: PaymentTransactionKind.ADDITIONAL,
      paymentIntentId: pi.id,
      amountCents: ask.amountCents,
      carriedAskCents: ask.carriedCents,
      status: PaymentStatus.PENDING,
      reason: reason ?? undefined,
      stripeCustomerId: customerId,
      ...(stale?.hadIssuedXeroInvoice != null ? { hadIssuedXeroInvoice: stale.hadIssuedXeroInvoice } : {}),
      ...(stale?.bookingModificationId ? { bookingModificationId: stale.bookingModificationId } : {}),
    });
    return queueSupersededAdditionalIntentCancellationRows({ bookingId, paymentId, newPaymentIntentId: pi.id, store });
  });
  await cancelSupersededAdditionalIntentsNow({ format, bookingId, paymentId, newPaymentIntentId: pi.id, queued });
  await reconcilePaymentAggregates({ paymentId });
  if (await retireAskOnEndedBooking({ format, bookingId, paymentId, paymentIntentId: pi.id })) return null;
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
 * #4316: a booking that ended meanwhile THROWS, with nothing offered: the
 * caller's debt goes to its recovery row, whose replay takes the cancelled path.
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
  if (!reissued) {
    throw new Error(`Booking ${params.bookingId} ended before its review charge could be re-issued in the club's currency; nothing was offered (#4316)`);
  }
  return reissued.id;
}
