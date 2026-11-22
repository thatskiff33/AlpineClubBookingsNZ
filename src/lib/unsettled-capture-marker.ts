/**
 * #5240 (`INV-PAY-043`): THE "CAPTURED, NOT YET SETTLED" FLAG of a saved-card
 * charge.
 *
 * Every saved-card path writes its attempt row SUCCEEDED (`settleSavedCardChargeAttempt`)
 * before it settles the booking (`markBookingPaymentSucceeded`). If the caller
 * stops or throws between the two, the capture's next arrival - the webhook, a
 * rerun - finds the row already SUCCEEDED and, without a durable record that
 * the settle never ran, reads it as the replay of a capture already known. On a
 * booking since paid another way that is a silent keep of the member's money.
 *
 * So the row write records this flag in the same transaction, and the settle
 * consumes it under lock(1): a consumed flag means "new money", whatever the
 * row's status. The flag is the one source of that answer (`INV-SSOT`). A flag
 * nothing consumes is judged, once an hour old, by the payments cron's drain
 * (`drainOwedNewCaptureAlerts`), and handed over to the error log after
 * `UNSETTLED_CAPTURE_HAND_OVER_MS`.
 *
 * Stored as an `AlertCooldown` row, the `markAlertOwed` family: the key names
 * the intent and `lastAlertedAt` is when the capture was written.
 */
import type { Prisma } from "@prisma/client";
import type { DuplicateCaptureKeptReason } from "@/lib/duplicate-capture-kept-note";

export const UNSETTLED_CAPTURE_PREFIX = "saved-card-capture-unsettled:";

/** How long an unconsumed flag on an unpaid booking waits before it is handed over to the log: past Stripe's webhook retries. */
export const UNSETTLED_CAPTURE_HAND_OVER_MS = 7 * 24 * 60 * 60 * 1000;

type FlagStore = Pick<Prisma.TransactionClient, "alertCooldown">;

function unsettledCaptureKey(paymentIntentId: string): string {
  return `${UNSETTLED_CAPTURE_PREFIX}${paymentIntentId}`;
}

/** Inside the transaction that wrote the capture SUCCEEDED over a row that held none. */
export async function recordCaptureAwaitingSettle(tx: FlagStore, paymentIntentId: string, now: Date = new Date()): Promise<void> {
  const key = unsettledCaptureKey(paymentIntentId);
  await tx.alertCooldown.upsert({ where: { key }, create: { key, lastAlertedAt: now }, update: {} });
}

/**
 * Take the flag, inside the settle's (or the drain's) transaction. True when
 * this caller removed it: the capture was never settled before. The row lock
 * the delete takes makes the settle and the drain's promotion exclusive, so
 * exactly one of them wins it.
 */
export async function consumeCaptureAwaitingSettle(tx: FlagStore, paymentIntentId: string): Promise<boolean> {
  const { count } = await tx.alertCooldown.deleteMany({ where: { key: unsettledCaptureKey(paymentIntentId) } });
  return count > 0;
}

/**
 * #5240 review: the owed kept-capture alert the payments cron records when it
 * promotes a flag for any reason but `new-capture` - the guard's own reason, or
 * `unsettled-saved-card` at the seven-day hand-over - kept in the marker's key
 * so the drain words the alert as the guard judged it, not as `new-capture`.
 * A `new-capture` promotion uses the arrival's own owed marker
 * (`newCaptureAlertOwedKey`). Any delivered alert for the capture clears both.
 */
export const PROMOTED_CAPTURE_ALERT_OWED_PREFIX = "duplicate-capture-promoted-owed:";

export const PROMOTED_KEPT_REASONS = ["not-recorded", "settler-released", "unsettled-saved-card"] as const satisfies readonly DuplicateCaptureKeptReason[];
export type PromotedKeptReason = (typeof PROMOTED_KEPT_REASONS)[number];

export function promotedCaptureAlertOwedKey(reason: PromotedKeptReason, bookingId: string, paymentIntentId: string): string {
  return `${PROMOTED_CAPTURE_ALERT_OWED_PREFIX}${reason}:${bookingId}:${paymentIntentId}`;
}

/** A promoted marker's parts, or null for a key this module never wrote. */
export function parsePromotedCaptureAlertOwedKey(key: string): { reason: PromotedKeptReason; bookingId: string; paymentIntentId: string } | null {
  const [reason, bookingId, paymentIntentId, ...rest] = key.slice(PROMOTED_CAPTURE_ALERT_OWED_PREFIX.length).split(":");
  if (!key.startsWith(PROMOTED_CAPTURE_ALERT_OWED_PREFIX) || rest.length > 0 || !bookingId || !paymentIntentId) return null;
  const known = PROMOTED_KEPT_REASONS.find((candidate) => candidate === reason);
  return known ? { reason: known, bookingId, paymentIntentId } : null;
}
