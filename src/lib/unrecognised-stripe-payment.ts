/**
 * #4532 (`INV-INT-032`): a succeeded Stripe payment the app did not create.
 *
 * A club can take money on its booking Stripe account outside the app — a
 * Stripe Payment Link for donations, a Checkout page, a dashboard charge. Its
 * `payment_intent.succeeded` carries none of the app's metadata
 * (`isAppCreatedPaymentIntent`), so no booking path claims it. Before #4532 the
 * webhook logged a warning and completed the event, and the money sat in the
 * Stripe clearing account with nothing in the app to explain it.
 *
 * Now every delivery writes, or finds, ONE durable `UnrecognisedStripePayment`
 * row, claimed by its unique `stripePaymentIntentId` (insert, duplicates
 * skipped); a later delivery reads the stored row and asks Stripe nothing.
 *
 * And one alert covers each payment, recorded on the row as `alertSentAt`:
 * - **Its own alert**, claimed once ever by an `AlertCooldown` key before the
 *   send, and stamped on the row after it. A claim held with no stamp means a
 *   sender is at work: a fresh one is left alone (its own event is redelivered
 *   if it dies), one older than the webhook lease
 *   (`STRIPE_WEBHOOK_PROCESSING_LEASE_MINUTES`) means it died between claim and
 *   send, so it is released and sent again.
 * - **Capped.** Once `UNRECOGNISED_PAYMENT_ALERTS_PER_HOUR` single-payment alerts
 *   were claimed in the last hour, a new payment gets none; instead one "more
 *   payments" alert goes out per rolling hour (its own cooldown key), so a
 *   card-testing burst sends a handful of emails, not one per charge. The cap
 *   reads the count before claiming, so racing deliveries can pass it by one or
 *   two; it bounds a flood, it is not an exact quota.
 * - **Failure.** The unmuteable sender swallows a transport failure (the copy is
 *   left FAILED and `cron-email-retry` re-sends it), so that counts as sent. Only
 *   a failure before any copy is attempted (recipients or rendering) throws: the
 *   claim is given back and this throws, so the webhook answers 500 and Stripe
 *   redelivers; the row is already there.
 *
 * No advisory lock: nothing here touches a booking, settlement money, capacity
 * or credit, and the races (two deliveries of one payment, or of two) are
 * decided by unique keys. No transaction: the Checkout read is a provider call
 * and runs before any write (`INV-INT-003`). Nothing is posted to Xero.
 */
import type Stripe from "stripe";
import type { UnrecognisedStripePayment } from "@prisma/client";

import { readHeldOnceEverAlertTimes, sendAdminAlertOnceEver } from "@/lib/admin-alert-once";
import { claimAlertCooldown, countAlertClaimsSince, releaseAlertCooldown } from "@/lib/alert-cooldown";
import { currencyHasTwoDecimalPlaces, canonicalCurrencyCode } from "@/lib/club-currency-minor-unit";
import type { ClubFormat } from "@/lib/club-format";
import {
  sendAdminUnrecognisedStripePaymentAlert,
  sendAdminUnrecognisedStripePaymentsPausedAlert,
} from "@/lib/email";
import { UNMUTEABLE_ALERT_SENT } from "@/lib/email/admin-alert-send-result";
import type { UnrecognisedStripePaymentAlertFields } from "@/lib/email-templates/admin-unrecognised-stripe-payment";
import { emailClubDateTime } from "@/lib/email-templates-club-time";
import logger from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import { findCheckoutSessionForPaymentIntent } from "@/lib/stripe";
import {
  stripeDashboardPaymentsUrl,
  stripeDashboardPaymentUrl,
  type StripeDashboardMode,
} from "@/lib/stripe-dashboard-links";
import { STRIPE_WEBHOOK_PROCESSING_LEASE_MINUTES } from "@/lib/stripe-webhook-lease";
import {
  UNRECOGNISED_PAYMENT_ALERTS_PER_HOUR,
  unrecognisedPaymentApplicationNote,
} from "@/lib/unrecognised-stripe-payment-note";
import { formatCents } from "@/lib/utils";

/** The stored description's cap: line items are short; a typed description is not. */
export const UNRECOGNISED_PAYMENT_DESCRIPTION_MAX_LENGTH = 500;

/** The rolling window of the alert cap, and the "more payments" alert's cooldown. */
export const UNRECOGNISED_PAYMENT_ALERT_WINDOW_MS = 60 * 60_000;

/** A claim held this long with no `alertSentAt` was taken by a sender that died. */
export const UNRECOGNISED_PAYMENT_STALE_CLAIM_MS = STRIPE_WEBHOOK_PROCESSING_LEASE_MINUTES * 60_000;

/** What an absent Stripe reference reads as in the alert. */
const NONE = "None";

/** The prefix every single-payment alert's claim carries; the cap counts it. */
const ALERT_KEY_PREFIX = "unrecognised-stripe-payment:";

/** The once-ever claim of one payment's alert. */
export function unrecognisedStripePaymentAlertKey(paymentIntentId: string): string {
  return `${ALERT_KEY_PREFIX}${paymentIntentId}`;
}

/** The hourly claim of the "more payments" alert; outside the single-payment prefix. */
export const UNRECOGNISED_PAYMENTS_PAUSED_ALERT_KEY = "unrecognised-stripe-payments-paused";

/** The alert was neither sent nor left claimed, so the webhook must fail and Stripe redeliver. */
export class UnrecognisedStripePaymentAlertNotSentError extends Error {
  constructor(readonly paymentIntentId: string) {
    super(`The alert for Stripe payment ${paymentIntentId}, which the app did not create, was not sent; Stripe will redeliver`);
    this.name = "UnrecognisedStripePaymentAlertNotSentError";
  }
}

/**
 * Record a succeeded PaymentIntent the app did not create, and see an alert
 * covers it. The caller has already decided the intent is not the app's.
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
      applicationId: row.stripeApplicationId,
      amountCents: row.amountCents,
      currency: row.currency,
    },
    "Stripe payment the app did not create: recorded for the treasurer to code in Xero (#4532)",
  );
  if (row.alertSentAt) return;

  const mode: StripeDashboardMode = event.livemode ? "live" : "test";
  const now = new Date();
  const key = unrecognisedStripePaymentAlertKey(row.stripePaymentIntentId);
  const claimedAt = (await readHeldOnceEverAlertTimes([key], now)).get(key);
  if (claimedAt) {
    // A sender holds the claim but has not stamped the row. Fresh: it is at
    // work, and if it dies its own event is redelivered. Stale: it died between
    // claim and send, so give its claim back and send it here.
    if (now.getTime() - claimedAt.getTime() < UNRECOGNISED_PAYMENT_STALE_CLAIM_MS) return;
    logger.warn(
      { paymentIntentId: row.stripePaymentIntentId, claimedAt },
      "An unrecognised Stripe payment's alert was claimed but never sent; sending it again (#4532)",
    );
    await releaseAlertCooldown({ key, claimedAt });
  } else if (await capReached(now)) {
    await sendPausedAlert(now, mode);
    await stampAlertSent(row.id, now);
    return;
  }

  const fields = alertFields(row, mode, format);
  const kept = await sendAdminAlertOnceEver({
    key,
    label: "unrecognised Stripe payment alert",
    context: { paymentIntentId: row.stripePaymentIntentId },
    send: async () => {
      await sendAdminUnrecognisedStripePaymentAlert(fields);
      return UNMUTEABLE_ALERT_SENT;
    },
  });
  if (kept) {
    await stampAlertSent(row.id, new Date());
    return;
  }
  // Not kept: a racing delivery claimed it first (and stamps it), or this
  // send threw and gave the claim back. Only the second must fail the event.
  if (!(await readHeldOnceEverAlertTimes([key], new Date())).has(key)) {
    throw new UnrecognisedStripePaymentAlertNotSentError(row.stripePaymentIntentId);
  }
}

/** Forward only: the first alert's time stands. */
async function stampAlertSent(id: string, at: Date): Promise<void> {
  await prisma.unrecognisedStripePayment.updateMany({ where: { id, alertSentAt: null }, data: { alertSentAt: at } });
}

/** Whether the rolling hour already carried its single-payment alerts. */
async function capReached(now: Date): Promise<boolean> {
  const claimed = await countAlertClaimsSince({
    prefix: ALERT_KEY_PREFIX,
    since: new Date(now.getTime() - UNRECOGNISED_PAYMENT_ALERT_WINDOW_MS),
  });
  return claimed >= UNRECOGNISED_PAYMENT_ALERTS_PER_HOUR;
}

/**
 * The "more payments" alert, at most once per rolling hour. A send that throws
 * gives the hour's claim back and fails the event, as the single alert does.
 */
async function sendPausedAlert(now: Date, mode: StripeDashboardMode): Promise<void> {
  const claimed = await claimAlertCooldown({
    key: UNRECOGNISED_PAYMENTS_PAUSED_ALERT_KEY,
    windowMs: UNRECOGNISED_PAYMENT_ALERT_WINDOW_MS,
    now,
  });
  if (!claimed) return;
  try {
    const since = new Date(now.getTime() - UNRECOGNISED_PAYMENT_ALERT_WINDOW_MS);
    const paymentCount = await prisma.unrecognisedStripePayment.count({ where: { createdAt: { gte: since } } });
    await sendAdminUnrecognisedStripePaymentsPausedAlert({
      paymentCount: String(paymentCount),
      pausedUntil: emailClubDateTime(new Date(now.getTime() + UNRECOGNISED_PAYMENT_ALERT_WINDOW_MS)),
      stripeDashboardUrl: stripeDashboardPaymentsUrl(mode),
    });
  } catch (err) {
    await releaseAlertCooldown({ key: UNRECOGNISED_PAYMENTS_PAUSED_ALERT_KEY, claimedAt: now }).catch((releaseErr) =>
      logger.error({ err: releaseErr }, "Failed to release the unrecognised Stripe payments paused-alert claim"),
    );
    throw err;
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

/** What was bought, as the club entered it in Stripe: the Checkout line items, else the intent's description. */
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
    stripeApplicationId: idOf(paymentIntent.application),
    amountCents: paymentIntent.amount_received || paymentIntent.amount,
    currency: paymentIntent.currency,
    // When it succeeded: Stripe stamps the succeeded event as it happens; the
    // intent's own `created` is when checkout began, which may be days earlier.
    stripeSucceededAt: new Date(event.created * 1000),
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

function alertFields(
  row: UnrecognisedStripePayment,
  mode: StripeDashboardMode,
  format: ClubFormat,
): UnrecognisedStripePaymentAlertFields {
  return {
    amount: unrecognisedPaymentAmountLabel(row.amountCents, row.currency, format),
    paidAt: emailClubDateTime(row.stripeSucceededAt),
    description: row.description ?? NONE,
    paymentIntentId: row.stripePaymentIntentId,
    chargeId: row.stripeChargeId ?? NONE,
    checkoutSessionId: row.stripeCheckoutSessionId ?? NONE,
    paymentLinkId: row.stripePaymentLinkId ?? NONE,
    applicationNote: unrecognisedPaymentApplicationNote(row.stripeApplicationId),
    stripeDashboardUrl: stripeDashboardPaymentUrl(row.stripePaymentIntentId, mode),
  };
}
