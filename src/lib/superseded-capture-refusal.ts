/**
 * #4300 (`INV-PAY-138`): after the settle REFUSED a capture the superseded
 * machinery owns (`markBookingPaymentSucceeded`'s `superseded_capture`), make
 * sure the machinery has it and tell the admins.
 *
 * Post-commit and best-effort; never throws, so the settle's answer always
 * reaches its door. The hand-off is the doors' own check
 * (`queueSupersededPaymentIntentRefundRecovery`): a live cancel row is handed to
 * its refund now rather than at the cancel worker's next run. The alert is its
 * own unmuteable, delivery-locked template (`admin-superseded-capture-refused`),
 * worded by the booking's status, once a day per (booking, capture) while
 * repeats arrive (`claimAlertCooldownFailOpen`); the claim is given back if the
 * send throws, so the next repeat tries again (as the kept-capture alert does).
 * A refusal here means a door's own check was overtaken (an edit inside its
 * unlocked window), a saved-card door met a superseded capture, or the capture
 * is partly owed back: each is worth a person looking.
 */
import { SETTLEMENT_MONEY_ALERT_REPEAT_MS, claimAlertCooldownFailOpen } from "@/lib/alert-cooldown-fail-open";
import { releaseAlertCooldown } from "@/lib/alert-cooldown";
import type { ClubFormat } from "@/lib/club-format";
import { sendAdminSupersededCaptureRefusedAlert } from "@/lib/email";
import logger from "@/lib/logger";
import { queueSupersededPaymentIntentRefundRecovery } from "@/lib/payment-recovery";

export async function reportSupersededCaptureRefused({
  booking,
  memberName,
  paymentIntentId,
  amountCents,
  paymentMethodId,
  format,
}: {
  booking: { id: string; checkIn: Date; checkOut: Date; status: string };
  memberName: string;
  paymentIntentId: string;
  amountCents: number;
  paymentMethodId: string | null;
  format: ClubFormat;
}): Promise<void> {
  const context = { bookingId: booking.id, paymentIntentId, amountCents };
  logger.error(context, "A capture the superseded-intent machinery owns reached the settle; the booking was NOT settled with it (#4300)");
  try {
    await queueSupersededPaymentIntentRefundRecovery({ id: paymentIntentId, amount: amountCents, payment_method: paymentMethodId });
  } catch (err) {
    // Nothing reschedules it from here: a live cancel row's own retry, or the
    // webhook's next delivery, makes the same hand-off; the alert below names
    // the payment either way, so a person can see it through.
    logger.error({ err, ...context }, "Could not hand a refused superseded capture to its refund now; a live cancel row's retry or the next Stripe delivery will, and the admin alert names it (#4300)");
  }
  const key = `superseded-capture-refused:${booking.id}:${paymentIntentId}`;
  const claimedAt = new Date();
  const send = await claimAlertCooldownFailOpen({
    key,
    windowMs: SETTLEMENT_MONEY_ALERT_REPEAT_MS,
    now: claimedAt,
    context,
    logMessage: "Could not claim the refused-superseded-capture alert's cooldown; alerting anyway (#4300)",
  });
  if (!send) return;
  try {
    await sendAdminSupersededCaptureRefusedAlert({
      memberName,
      checkIn: booking.checkIn,
      checkOut: booking.checkOut,
      bookingId: booking.id,
      bookingCancelled: booking.status === "CANCELLED",
      amountCents,
      paymentIntentId,
    }, format);
  } catch (err) {
    logger.error({ err, ...context }, "Failed to alert admins about a refused superseded capture; giving the claim back so a repeat tries again (#4300)");
    await releaseAlertCooldown({ key, claimedAt }).catch((releaseErr) =>
      logger.error({ err: releaseErr, ...context }, "Failed to give back the refused-superseded-capture alert's claim (#4300)"),
    );
  }
}
