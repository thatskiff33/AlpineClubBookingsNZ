import { emailReachability } from "@/lib/email-reachability";
import logger from "@/lib/logger";

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
 * cleared. A suppression read that fails is treated as "cannot reach" for this
 * pass, the same fail-closed direction as the cron's "No emails" switch check.
 * The rule itself is `emailReachability` (#5433 round 3): since then an empty
 * address is skipped here too, where it used to be claimed and then withheld.
 */
export async function canReceiveChaseEmail(
  email: string,
  bookingId: string,
): Promise<boolean> {
  const reach = await emailReachability(email);
  const log = { bookingId, job: "additionalPaymentReminders" };
  switch (reach) {
    case "reachable":
      return true;
    case "no-address":
      logger.info(log, "Skipped an additional-payment reminder: the member has no email address");
      return false;
    case "placeholder":
      logger.info(log, "Skipped an additional-payment reminder to a walk-in placeholder address");
      return false;
    case "suppressed":
      logger.warn(log, "Skipped an additional-payment reminder to a suppressed address");
      return false;
    case "unknown":
      logger.error(log, "Could not check the member's email suppression state; skipping the additional-payment reminder");
      return false;
  }
}
