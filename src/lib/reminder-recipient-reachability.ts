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
 * The rule itself is `emailReachability` (#5433 round 3); an empty address
 * passes here, as it always has (see below).
 */
export async function canReceiveChaseEmail(
  email: string,
  bookingId: string,
): Promise<boolean> {
  const log = { bookingId, job: "additionalPaymentReminders" };
  // One line with the error and the booking, as before #5433 (round 5, F6).
  const reach = await emailReachability(email, (err) =>
    logger.error({ err, ...log }, "Could not check the member's email suppression state; skipping the additional-payment reminder"),
  );
  switch (reach) {
    case "reachable":
      return true;
    case "no-address":
      // Not a reason to stop here (#5433 round 4, item 3): the chase's own
      // preparation still runs for a booking with no address (an organisation
      // with none, say), so a credit-release request the Xero gate holds back
      // still reaches the officers' note; only then does the mailer skip the
      // send. As before #5433.
      return true;
    case "placeholder":
      logger.info(log, "Skipped an additional-payment reminder to a walk-in placeholder address");
      return false;
    case "suppressed":
      logger.warn(log, "Skipped an additional-payment reminder to a suppressed address");
      return false;
    case "unknown":
      return false;
  }
}
