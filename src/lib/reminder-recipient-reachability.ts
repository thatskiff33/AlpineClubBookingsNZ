import { getActiveEmailSuppression } from "@/lib/email-suppression";
import logger from "@/lib/logger";
import { isPlaceholderContactEmail } from "@/lib/placeholder-contact-email";

/**
 * Can this member actually be reached, before anything is claimed? The additional-payment
 * reminder cron's pre-claim check (`cron-additional-payment-reminders.ts`), in its own module
 * so the cron stays within its size budget.
 *
 * A walk-in placeholder `.invalid` address and an active bounce/complaint
 * suppression both mean the mailer will withhold. Finding that out AFTER the
 * claim would mean handing the stamp back on every pass and manufacturing a
 * bounce row each time; finding it out first costs one indexed read and leaves
 * the reminder cleanly due for whenever the address is fixed or the suppression
 * cleared. A suppression read that fails is treated as "cannot reach", the same
 * fail-closed direction as the cron's "No emails" switch check.
 */
export async function canReceiveChaseEmail(
  email: string,
  bookingId: string,
): Promise<boolean> {
  if (isPlaceholderContactEmail(email)) {
    logger.info(
      { bookingId, job: "additionalPaymentReminders" },
      "Skipped an additional-payment reminder to a walk-in placeholder address",
    );
    return false;
  }

  try {
    const suppression = await getActiveEmailSuppression(email);
    if (suppression) {
      logger.warn(
        { bookingId, job: "additionalPaymentReminders" },
        "Skipped an additional-payment reminder to a suppressed address",
      );
      return false;
    }
    return true;
  } catch (err) {
    logger.error(
      { err, bookingId, job: "additionalPaymentReminders" },
      "Could not check the member's email suppression state; skipping the additional-payment reminder",
    );
    return false;
  }
}
