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
 *   more; a later delivery reads the stored row;
 * - the alert by its once-ever `AlertCooldown` key, claimed before the send,
 *   and by `alertedAt` on the row, written only after a recipient was sent.
 *   A send that does not go out throws, the claim is given back, and the
 *   webhook answers 500 so Stripe redelivers; #4670: a delivery whose
 *   give-back failed gives back its own claim again and still fails. A claim
 *   still held with no `alertedAt` is a delivery that died: younger than the
 *   webhook lease less a margin it belongs to a sibling still sending; older,
 *   this delivery releases it and sends (`UNRECOGNISED_ALERT_IN_FLIGHT_MS`),
 *   unless the sent marker, written when a sent alert's `alertedAt` write
 *   failed, says it went out. A Checkout
 *   read that throws is not stored as "no Checkout": nothing is inserted, and
 *   Stripe redelivers.
 *
 * #4624 (`INV-INT-033`): the same record, claim and alert hold a succeeded
 * PaymentIntent the app DID create - it carries the app's `bookingId` - that
 * no PRIMARY payment transaction names, so no path settles it
 * (`recordUnmatchedAppStripePayment`). The row's `reason` says which case it
 * is; an app intent names its booking, skips the Checkout read (the app makes
 * no Checkout) and raises its own alert, `admin-unmatched-app-stripe-payment`,
 * under the same once-ever key: one row and one alert per PaymentIntent,
 * whichever case recorded it first. Nothing about the booking, its payment or
 * its ledger is written.
 *
 * No advisory lock: nothing here touches a booking, settlement money, capacity
 * or credit, and the only race — two deliveries of one payment — is decided by
 * the two unique keys. No transaction: the Checkout read is a provider call and
 * runs before any write (`INV-INT-003`). Nothing is posted to Xero.
 */
import type Stripe from "stripe";
import {
  PaymentTransactionKind,
  UnrecognisedStripePaymentReason,
  type UnrecognisedStripePayment,
} from "@prisma/client";

import { findHeldOnceEverAlertKeys, readHeldOnceEverAlertTimes, sendAdminAlertOnceEverClaim } from "@/lib/admin-alert-once";
import { ALERT_ONCE_EVER_WINDOW_MS, claimAlertCooldown, releaseAlertCooldown } from "@/lib/alert-cooldown";
import { currencyHasTwoDecimalPlaces, canonicalCurrencyCode } from "@/lib/club-currency-minor-unit";
import type { ClubFormat } from "@/lib/club-format";
import { sendAdminUnmatchedAppStripePaymentAlert, sendAdminUnrecognisedStripePaymentAlert } from "@/lib/email";
import { UNMUTEABLE_ALERT_SENT, type AdminAlertSendOutcome } from "@/lib/email/admin-alert-send-result";
import type {
  UnmatchedAppStripePaymentAlertFields,
  UnrecognisedStripePaymentAlertFields,
} from "@/lib/email-templates/admin-unrecognised-stripe-payment";
import { emailClubDateTime } from "@/lib/email-templates-club-time";
import logger from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import { findCheckoutSessionForPaymentIntent } from "@/lib/stripe";
import { STRIPE_WEBHOOK_PROCESSING_LEASE_MINUTES } from "@/lib/stripe-webhook-lease";
import { UNMATCHED_APP_LEDGER_MATCH_LABEL } from "@/lib/unrecognised-stripe-payment-note";
import { formatCents } from "@/lib/utils";

/** The stored description's cap: line items are short; a typed description is not. */
export const UNRECOGNISED_PAYMENT_DESCRIPTION_MAX_LENGTH = 500;

/** What an absent Stripe reference reads as in the alert. */
const NONE = "None";

/** The once-ever claim of one payment's alert. */
export function unrecognisedStripePaymentAlertKey(paymentIntentId: string): string {
  return `unrecognised-stripe-payment:${paymentIntentId}`;
}

/**
 * The most a delivery's alert claim may trail its own webhook lease stamp: the
 * handler's work before the claim - database reads and, for a foreign payment,
 * the Checkout read (two calls of at most 10 seconds each). Real runtime is
 * seconds. Both stamps come from the delivering instance's clock, so a later
 * delivery compares both against one clock and no skew enters.
 */
export const UNRECOGNISED_ALERT_CLAIM_LAG_MARGIN_MS = 5 * 60_000;

/**
 * A claim younger than this, with no `alertedAt`, belongs to a delivery that may
 * still be sending; older, the holder is gone and this delivery sends.
 *
 * #4647: the webhook processing lease LESS {@link UNRECOGNISED_ALERT_CLAIM_LAG_MARGIN_MS},
 * never equal to it. The claim is stamped after the lease starts, so with an
 * equal window a takeover arriving just after the lease expired could find the
 * dead attempt's claim still "fresh", return, and complete the event: the alert
 * would never be sent. A takeover comes more than one lease after the lease
 * stamp, so it finds a claim taken within the margin of that stamp expired.
 */
export const UNRECOGNISED_ALERT_IN_FLIGHT_MS =
  STRIPE_WEBHOOK_PROCESSING_LEASE_MINUTES * 60_000 - UNRECOGNISED_ALERT_CLAIM_LAG_MARGIN_MS;

/** The alert was neither sent nor left claimed, so the webhook must fail and Stripe redeliver. */
export class UnrecognisedStripePaymentAlertNotSentError extends Error {
  constructor(readonly paymentIntentId: string) {
    super(`The alert for Stripe payment ${paymentIntentId}, which no app path settled, was not sent; Stripe will redeliver`);
    this.name = "UnrecognisedStripePaymentAlertNotSentError";
  }
}

/** Why this delivery is recording the payment, and for an app intent, its booking. */
type RecordOrigin =
  | { reason: typeof UnrecognisedStripePaymentReason.NOT_APP_CREATED; bookingId: null }
  | { reason: AppIntentReason; bookingId: string };

/** #4624: the reasons an app intent with a booking id is recorded. */
type AppIntentReason = Exclude<UnrecognisedStripePaymentReason, typeof UnrecognisedStripePaymentReason.NOT_APP_CREATED>;

/**
 * Record a succeeded PaymentIntent the app did not create, and alert about it,
 * once each. The caller has already decided the intent is not the app's.
 */
export async function recordUnrecognisedStripePayment(
  paymentIntent: Stripe.PaymentIntent,
  event: Stripe.Event,
  format: ClubFormat,
): Promise<void> {
  await recordAndAlert(paymentIntent, event, format, {
    reason: UnrecognisedStripePaymentReason.NOT_APP_CREATED,
    bookingId: null,
  });
}

/**
 * #4624: which unmatched case an app intent is - no payment transaction names
 * it (`null`), or one of another kind does. A PRIMARY row is settled by the
 * webhook and never reaches here; passing one is a caller bug and throws.
 */
function unmatchedAppIntentReason(matchedKind: PaymentTransactionKind | null): AppIntentReason {
  if (matchedKind === null) return UnrecognisedStripePaymentReason.APP_INTENT_NO_TRANSACTION;
  if (matchedKind === PaymentTransactionKind.PRIMARY) {
    throw new Error("A PRIMARY payment transaction matches this PaymentIntent; it is settled, not recorded as unmatched");
  }
  return UnrecognisedStripePaymentReason.APP_INTENT_NOT_PRIMARY;
}

/**
 * #4624 (`INV-INT-033`): record a succeeded PaymentIntent the app created for
 * `bookingId` that no PRIMARY payment transaction names, and alert about it,
 * once each. `matchedKind` is the kind of the transaction that does name it,
 * or null when none does. Settles nothing.
 */
export async function recordUnmatchedAppStripePayment(
  paymentIntent: Stripe.PaymentIntent,
  event: Stripe.Event,
  format: ClubFormat,
  match: { bookingId: string; matchedKind: PaymentTransactionKind | null },
): Promise<void> {
  await recordAndAlert(paymentIntent, event, format, {
    reason: unmatchedAppIntentReason(match.matchedKind),
    bookingId: match.bookingId,
  });
}

async function recordAndAlert(
  paymentIntent: Stripe.PaymentIntent,
  event: Stripe.Event,
  format: ClubFormat,
  origin: RecordOrigin,
): Promise<void> {
  const row = await claimRecord(paymentIntent, event, origin);
  logger.warn(
    {
      paymentIntentId: row.stripePaymentIntentId,
      paymentLinkId: row.stripePaymentLinkId,
      amountCents: row.amountCents,
      currency: row.currency,
      reason: row.reason,
      bookingId: row.bookingId,
    },
    row.reason === UnrecognisedStripePaymentReason.NOT_APP_CREATED
      ? "Stripe payment the app did not create: recorded for the treasurer to code in Xero (#4532)"
      : "App booking payment no payment transaction settles: recorded for the treasurer to match by hand (#4624)",
  );

  await ensureAlert(row, event, format);
}

/**
 * #4670: the marker that the alert went out although its `alertedAt` write
 * failed. Without it the kept claim with no `alertedAt` would read, once older
 * than {@link UNRECOGNISED_ALERT_IN_FLIGHT_MS}, as a delivery that died before
 * sending, and a later delivery would take it over and send a second alert.
 */
export function unrecognisedStripePaymentAlertSentKey(paymentIntentId: string): string {
  return `${unrecognisedStripePaymentAlertKey(paymentIntentId)}:sent`;
}

/** Send the one alert, or fail the webhook so Stripe redelivers. */
async function ensureAlert(
  row: UnrecognisedStripePayment,
  event: Stripe.Event,
  format: ClubFormat,
): Promise<void> {
  const key = unrecognisedStripePaymentAlertKey(row.stripePaymentIntentId);
  const mail = alertMail(row, event.livemode, format);
  const context = { paymentIntentId: row.stripePaymentIntentId, reason: row.reason };
  const send = () =>
    sendAdminAlertOnceEverClaim({
      key,
      label: mail.label,
      context,
      send: async () => {
        const outcome = await mail.send();
        if (outcome !== "sent") {
          throw new UnrecognisedStripePaymentAlertNotSentError(row.stripePaymentIntentId);
        }
        await stampAlertSent(row, context);
        return UNMUTEABLE_ALERT_SENT;
      },
    });

  /**
   * #4670: this delivery took the claim and the send failed. The helper gave
   * the claim back, unless that release failed: then the claim held is this
   * delivery's own, not a sibling's in flight, and returning would complete the
   * event with no alert sent. Give it back again - guarded by the exact stamp
   * this call wrote, so a newer claim is never touched - and fail the webhook so
   * Stripe's redelivery claims afresh and sends.
   */
  const giveBackOwnClaimAndFail = async (claimedAt: Date): Promise<never> => {
    await releaseAlertCooldown({ key, claimedAt }).catch((err) =>
      logger.error({ ...context, err }, `Failed again to release the ${mail.label} claim`),
    );
    throw new UnrecognisedStripePaymentAlertNotSentError(row.stripePaymentIntentId);
  };

  const first = await send();
  if (first.kept || (await alertWasSent(row))) return;
  if (first.claimedAt) await giveBackOwnClaimAndFail(first.claimedAt);

  const heldAt = (await readHeldOnceEverAlertTimes([key], new Date())).get(key);
  if (!heldAt) {
    throw new UnrecognisedStripePaymentAlertNotSentError(row.stripePaymentIntentId);
  }
  // A sibling delivery of another event still owns a fresh claim. The same
  // event's redelivery reaches here only once that attempt's lease expired, and
  // then finds a claim taken within the margin of that lease expired (#4647).
  if (Date.now() - heldAt.getTime() < UNRECOGNISED_ALERT_IN_FLIGHT_MS) return;

  await releaseAlertCooldown({ key, claimedAt: heldAt });
  const second = await send();
  if (second.kept || (await alertWasSent(row))) return;
  if (second.claimedAt) await giveBackOwnClaimAndFail(second.claimedAt);
  throw new UnrecognisedStripePaymentAlertNotSentError(row.stripePaymentIntentId);

}

/**
 * Stamp `alertedAt` once the alert went out. #4670: a failed write never fails
 * the send - the mail is out, so the claim must be kept and the event complete,
 * or Stripe's redelivery would send it again. The sent marker stands in for
 * the stamp; if it fails too, both failures are logged for an operator.
 */
async function stampAlertSent(row: UnrecognisedStripePayment, context: Record<string, unknown>): Promise<void> {
  try {
    await prisma.unrecognisedStripePayment.update({
      where: { id: row.id },
      data: { alertedAt: new Date() },
    });
    return;
  } catch (err) {
    logger.error({ ...context, err }, "The Stripe payment alert was sent, but its alertedAt stamp failed; writing the sent marker");
  }
  const sentKey = unrecognisedStripePaymentAlertSentKey(row.stripePaymentIntentId);
  await claimAlertCooldown({ key: sentKey, windowMs: ALERT_ONCE_EVER_WINDOW_MS }).catch((err) =>
    logger.error({ ...context, err }, "The Stripe payment alert was sent, but neither its alertedAt stamp nor its sent marker was written"),
  );
}

/** Sent: the row's `alertedAt`, or (#4670) the marker written when that stamp failed. */
async function alertWasSent(row: UnrecognisedStripePayment): Promise<boolean> {
  const current = await prisma.unrecognisedStripePayment.findUnique({
    where: { id: row.id },
    select: { alertedAt: true },
  });
  if (current?.alertedAt != null) return true;
  const sentKey = unrecognisedStripePaymentAlertSentKey(row.stripePaymentIntentId);
  return (await findHeldOnceEverAlertKeys([sentKey], new Date())).has(sentKey);
}

/** The stored row for this intent: the existing one, or the one this delivery inserts. */
async function claimRecord(
  paymentIntent: Stripe.PaymentIntent,
  event: Stripe.Event,
  origin: RecordOrigin,
): Promise<UnrecognisedStripePayment> {
  const where = { stripePaymentIntentId: paymentIntent.id };
  const existing = await prisma.unrecognisedStripePayment.findUnique({ where });
  if (existing) return existing;

  // The app makes no Checkout session, so an app intent's is not asked for.
  const session =
    origin.reason === UnrecognisedStripePaymentReason.NOT_APP_CREATED
      ? await readCheckoutSession(paymentIntent.id)
      : null;
  await prisma.unrecognisedStripePayment.createMany({
    data: [buildRecord(paymentIntent, event, session, origin)],
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
 * The Checkout Session the payment went through, or `null` when Stripe lists
 * none (a dashboard charge). A failed read throws: storing null would freeze
 * "there was no Checkout" and the one alert would omit the Payment Link.
 */
async function readCheckoutSession(paymentIntentId: string): Promise<Stripe.Checkout.Session | null> {
  return findCheckoutSessionForPaymentIntent(paymentIntentId);
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
  const lineItems = session?.line_items;
  const lines = (lineItems?.data ?? [])
    .map((item) => {
      const text = item.description?.trim();
      if (!text) return null;
      return item.quantity && item.quantity !== 1 ? `${item.quantity} x ${text}` : text;
    })
    .filter((line): line is string => line !== null);
  if (lineItems?.has_more) lines.push("further line items were not listed");
  const text = lines.length > 0 ? lines.join("; ") : paymentIntent.description?.trim() || null;
  return text ? text.slice(0, UNRECOGNISED_PAYMENT_DESCRIPTION_MAX_LENGTH) : null;
}

function buildRecord(
  paymentIntent: Stripe.PaymentIntent,
  event: Stripe.Event,
  session: Stripe.Checkout.Session | null,
  origin: RecordOrigin,
) {
  return {
    stripePaymentIntentId: paymentIntent.id,
    stripeChargeId: idOf(paymentIntent.latest_charge),
    stripeCheckoutSessionId: session?.id ?? null,
    stripePaymentLinkId: idOf(session?.payment_link),
    amountCents: paymentIntent.amount_received || paymentIntent.amount,
    currency: paymentIntent.currency,
    stripeCreatedAt: new Date(event.created * 1000),
    description: describeUnrecognisedPayment(paymentIntent, session),
    stripeEventId: event.id,
    reason: origin.reason,
    bookingId: origin.bookingId,
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

/**
 * The one alert the stored row's reason raises: #4532's for a payment the app
 * did not create, #4624's for the app's own unmatched booking payment. Read off
 * the STORED row, so a later delivery alerts as the first one recorded.
 */
function alertMail(
  row: UnrecognisedStripePayment,
  livemode: boolean,
  format: ClubFormat,
): { label: string; send: () => Promise<AdminAlertSendOutcome> } {
  const reason = row.reason;
  if (reason === UnrecognisedStripePaymentReason.NOT_APP_CREATED) {
    const fields = alertFields(row, livemode, format);
    return { label: "unrecognised Stripe payment alert", send: () => sendAdminUnrecognisedStripePaymentAlert(fields) };
  }
  const fields = unmatchedAppAlertFields(row, reason, livemode, format);
  return { label: "unmatched app Stripe payment alert", send: () => sendAdminUnmatchedAppStripePaymentAlert(fields) };
}

/** #4624: the label map, typed here so a new app-intent reason without a label does not compile. */
const LEDGER_MATCH_LABEL: Record<AppIntentReason, string> = UNMATCHED_APP_LEDGER_MATCH_LABEL;

function unmatchedAppAlertFields(
  row: UnrecognisedStripePayment,
  reason: AppIntentReason,
  livemode: boolean,
  format: ClubFormat,
): UnmatchedAppStripePaymentAlertFields {
  return {
    amount: unrecognisedPaymentAmountLabel(row.amountCents, row.currency, format),
    receivedAt: emailClubDateTime(row.stripeCreatedAt),
    bookingId: row.bookingId ?? NONE,
    ledgerMatch: LEDGER_MATCH_LABEL[reason],
    paymentIntentId: row.stripePaymentIntentId,
    chargeId: row.stripeChargeId ?? NONE,
    stripeDashboardUrl: stripeDashboardPaymentUrl(row.stripePaymentIntentId, livemode),
  };
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
