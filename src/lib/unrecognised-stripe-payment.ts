/**
 * #4532 (`INV-INT-032`): a succeeded Stripe payment the app did not create.
 *
 * A club can take money on its booking Stripe account outside the app — a
 * Stripe Payment Link for donations, a Checkout page, a dashboard charge. Its
 * `payment_intent.succeeded` carries none of the app's metadata
 * (`isAppCreatedPaymentIntent`), so no booking path claims it. Before #4532 the
 * webhook logged a warning and completed the event, and the money sat in the
 * Stripe clearing account with nothing in Xero or the app to explain it.
 *
 * Now the webhook writes ONE durable `UnrecognisedStripePayment` row and raises
 * ONE admin alert per PaymentIntent, both claimed by a unique key:
 * - the row by its unique `stripePaymentIntentId` (insert, duplicates skipped),
 *   so a redelivery, a lease takeover or a concurrent delivery writes nothing
 *   more; a later delivery reads the stored row and makes no Stripe call;
 * - the alert by its once-ever `AlertCooldown` key, claimed before the send.
 *   Every delivery asks for it, so a delivery that died between the row and the
 *   send is finished by the next one, and the key makes every later ask a no-op.
 *   A send that throws gives the claim back and this throws, so the webhook
 *   answers 500 and Stripe redelivers; the row is already there.
 *
 * No advisory lock: nothing here touches a booking, settlement money, capacity
 * or credit, and the only race — two deliveries of one payment — is decided by
 * the two unique keys. No transaction: the Checkout read is a provider call and
 * runs before any write (`INV-INT-003`). Nothing is posted to Xero.
 */
import type Stripe from "stripe";
import type { UnrecognisedStripePayment } from "@prisma/client";

import { findHeldOnceEverAlertKeys, sendAdminAlertOnceEver } from "@/lib/admin-alert-once";
import { currencyHasTwoDecimalPlaces, canonicalCurrencyCode } from "@/lib/club-currency-minor-unit";
import type { ClubFormat } from "@/lib/club-format";
import { sendAdminUnrecognisedStripePaymentAlert } from "@/lib/email";
import { UNMUTEABLE_ALERT_SENT } from "@/lib/email/admin-alert-send-result";
import type { UnrecognisedStripePaymentAlertFields } from "@/lib/email-templates/admin-unrecognised-stripe-payment";
import { emailClubDateTime } from "@/lib/email-templates-club-time";
import logger from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import { findCheckoutSessionForPaymentIntent } from "@/lib/stripe";
import { formatCents } from "@/lib/utils";

/** The stored description's cap: line items are short; a typed description is not. */
export const UNRECOGNISED_PAYMENT_DESCRIPTION_MAX_LENGTH = 500;

/** What an absent Stripe reference reads as in the alert. */
const NONE = "None";

/** The once-ever claim of one payment's alert. */
export function unrecognisedStripePaymentAlertKey(paymentIntentId: string): string {
  return `unrecognised-stripe-payment:${paymentIntentId}`;
}

/** The alert was neither sent nor left claimed, so the webhook must fail and Stripe redeliver. */
export class UnrecognisedStripePaymentAlertNotSentError extends Error {
  constructor(readonly paymentIntentId: string) {
    super(`The alert for Stripe payment ${paymentIntentId}, which the app did not create, was not sent; Stripe will redeliver`);
    this.name = "UnrecognisedStripePaymentAlertNotSentError";
  }
}

/**
 * Record a succeeded PaymentIntent the app did not create, and alert about it,
 * once each. The caller has already decided the intent is not the app's.
 */
export async function recordUnrecognisedStripePayment(
  paymentIntent: Stripe.PaymentIntent,
  event: Stripe.Event,
  format: ClubFormat,
): Promise<void> {
  const row = await claimRecord(paymentIntent, event);
  logger.warn(
    {
      paymentIntentId: row.stripePaymentIntentId,
      paymentLinkId: row.stripePaymentLinkId,
      amountCents: row.amountCents,
      currency: row.currency,
    },
    "Stripe payment the app did not create: recorded for the treasurer to code in Xero (#4532)",
  );

  const key = unrecognisedStripePaymentAlertKey(row.stripePaymentIntentId);
  const fields = alertFields(row, event.livemode, format);
  const kept = await sendAdminAlertOnceEver({
    key,
    label: "unrecognised Stripe payment alert",
    context: { paymentIntentId: row.stripePaymentIntentId },
    send: async () => {
      await sendAdminUnrecognisedStripePaymentAlert(fields);
      return UNMUTEABLE_ALERT_SENT;
    },
  });
  if (kept) return;
  // Not kept: either an earlier delivery holds the claim (sent, or sending now),
  // or this send threw and gave it back. Only the second must fail the event.
  const held = await findHeldOnceEverAlertKeys([key], new Date());
  if (!held.has(key)) {
    throw new UnrecognisedStripePaymentAlertNotSentError(row.stripePaymentIntentId);
  }
}

/** The stored row for this intent: the existing one, or the one this delivery inserts. */
async function claimRecord(
  paymentIntent: Stripe.PaymentIntent,
  event: Stripe.Event,
): Promise<UnrecognisedStripePayment> {
  const where = { stripePaymentIntentId: paymentIntent.id };
  const existing = await prisma.unrecognisedStripePayment.findUnique({ where });
  if (existing) return existing;

  const session = await readCheckoutSession(paymentIntent.id);
  await prisma.unrecognisedStripePayment.createMany({
    data: [buildRecord(paymentIntent, event, session)],
    skipDuplicates: true,
  });
  // Ours or a concurrent delivery's: both describe the same payment.
  const stored = await prisma.unrecognisedStripePayment.findUnique({ where });
  if (!stored) {
    throw new Error(`The record of Stripe payment ${paymentIntent.id} was not found after it was written`);
  }
  return stored;
}

/**
 * The Checkout Session the payment went through, or `null`. Best effort: a
 * failed read records the payment without it rather than leaving it unrecorded,
 * and the alert's PaymentIntent id still finds it in Stripe.
 */
async function readCheckoutSession(paymentIntentId: string): Promise<Stripe.Checkout.Session | null> {
  try {
    return await findCheckoutSessionForPaymentIntent(paymentIntentId);
  } catch (err) {
    logger.warn(
      { err, paymentIntentId },
      "Could not read the Checkout Session of a Stripe payment the app did not create; recording it without one (#4532)",
    );
    return null;
  }
}

function idOf(value: string | { id: string } | null | undefined): string | null {
  if (!value) return null;
  return typeof value === "string" ? value : value.id;
}

/** What was bought: the Checkout line items, else the intent's own description. */
export function describeUnrecognisedPayment(
  paymentIntent: Pick<Stripe.PaymentIntent, "description">,
  session: Pick<Stripe.Checkout.Session, "line_items"> | null,
): string | null {
  const lines = (session?.line_items?.data ?? [])
    .map((item) => {
      const text = item.description?.trim();
      if (!text) return null;
      return item.quantity && item.quantity !== 1 ? `${item.quantity} x ${text}` : text;
    })
    .filter((line): line is string => line !== null);
  const text = lines.length > 0 ? lines.join("; ") : paymentIntent.description?.trim() || null;
  return text ? text.slice(0, UNRECOGNISED_PAYMENT_DESCRIPTION_MAX_LENGTH) : null;
}

function buildRecord(
  paymentIntent: Stripe.PaymentIntent,
  event: Stripe.Event,
  session: Stripe.Checkout.Session | null,
) {
  return {
    stripePaymentIntentId: paymentIntent.id,
    stripeChargeId: idOf(paymentIntent.latest_charge),
    stripeCheckoutSessionId: session?.id ?? null,
    stripePaymentLinkId: idOf(session?.payment_link),
    amountCents: paymentIntent.amount_received || paymentIntent.amount,
    currency: paymentIntent.currency,
    stripeCreatedAt: new Date(paymentIntent.created * 1000),
    description: describeUnrecognisedPayment(paymentIntent, session),
    stripeEventId: event.id,
  };
}

/**
 * The amount in the payment's OWN currency, which a Payment Link may set apart
 * from the club's: the club's money formatter in that currency when it counts in
 * hundredths, else Stripe's integer with its code, never a guessed decimal.
 */
export function unrecognisedPaymentAmountLabel(amountCents: number, currency: string, format: ClubFormat): string {
  const code = canonicalCurrencyCode(currency);
  if (currencyHasTwoDecimalPlaces(code)) {
    return formatCents(amountCents, { locale: format.locale, currencyCode: code });
  }
  return `${amountCents} ${code} (Stripe's smallest unit)`;
}

/** The Stripe dashboard page of the payment, in the mode the event came from. */
export function stripeDashboardPaymentUrl(paymentIntentId: string, livemode: boolean): string {
  return `https://dashboard.stripe.com/${livemode ? "" : "test/"}payments/${encodeURIComponent(paymentIntentId)}`;
}

function alertFields(
  row: UnrecognisedStripePayment,
  livemode: boolean,
  format: ClubFormat,
): UnrecognisedStripePaymentAlertFields {
  return {
    amount: unrecognisedPaymentAmountLabel(row.amountCents, row.currency, format),
    receivedAt: emailClubDateTime(row.stripeCreatedAt),
    description: row.description ?? NONE,
    paymentIntentId: row.stripePaymentIntentId,
    chargeId: row.stripeChargeId ?? NONE,
    checkoutSessionId: row.stripeCheckoutSessionId ?? NONE,
    paymentLinkId: row.stripePaymentLinkId ?? NONE,
    stripeDashboardUrl: stripeDashboardPaymentUrl(row.stripePaymentIntentId, livemode),
  };
}
