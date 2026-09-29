/**
 * WHEN STRIPE TOOK THE MONEY (#3635 round-3 R2, `INV-PAY-110`).
 *
 * A kept late capture is recorded as a card receipt, dated the club day Stripe
 * took the money, so it lands in the period the Stripe payout does. That day
 * is the capture's CHARGE (`latest_charge.created`, what the balance
 * transaction and the payout carry), not the day an approval task was raised:
 * a task can be raised later - by the payment-recovery cron's superseded-intent
 * hand-off, on a redelivered webhook, or on an existing question - and a
 * capture at 23:58 processed after midnight belongs to the day before.
 *
 * Read from Stripe outside any transaction, and never thrown: a caller falls
 * back to its own date, with a warning, only when Stripe cannot answer. Each
 * caller stores the answer on its queued row before the Xero call, so a retry
 * never drifts.
 */
import type Stripe from "stripe";
import logger from "@/lib/logger";
import { getPaymentIntent } from "@/lib/stripe";
import { xeroDocumentDateFromInstant } from "@/lib/xero-provider-dates";
import type { ClubTimeZone } from "@/lib/club-time";

/** A bounded read: a Stripe brown-out must not stall the outbox behind it. */
const STRIPE_CAPTURE_READ_TIMEOUT_MS = 10_000;

/** When Stripe took the money: the latest charge's time, else the intent's. */
export function providerCaptureTime(intent: Stripe.PaymentIntent): Date {
  const charge = intent.latest_charge;
  const seconds =
    charge && typeof charge === "object" ? charge.created : intent.created;
  return new Date(seconds * 1000);
}

/** The club day of the capture, or null when Stripe cannot say. */
export async function readStripeCaptureDocumentDate(
  paymentIntentId: string,
  zone: ClubTimeZone,
): Promise<string | null> {
  try {
    const intent = await getPaymentIntent(paymentIntentId, {
      timeoutMs: STRIPE_CAPTURE_READ_TIMEOUT_MS,
      expand: ["latest_charge"],
    });
    return xeroDocumentDateFromInstant(providerCaptureTime(intent), zone);
  } catch (err) {
    logger.warn(
      { err, paymentIntentId },
      "Could not read a late capture's charge date from Stripe; the Xero receipt falls back to its recorded date",
    );
    return null;
  }
}
