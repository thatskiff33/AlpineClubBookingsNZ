import { getActiveEmailSuppression } from "@/lib/email-suppression";
import logger from "@/lib/logger";
import { canReceiveEmail, isPlaceholderContactEmail } from "@/lib/placeholder-contact-email";

/**
 * Whether an email to this address can go at all, decided before anything is
 * claimed or changed on the strength of it (#5433 round 3, item 4): one rule
 * for the additional-payment chase and the waitlist offer's restart. Present,
 * not a club placeholder, and not on the SES suppression list. A suppression
 * read that fails is `unknown`, which every caller treats as "not now, try
 * again later": never as reachable, and never as a reason to act as if the
 * address were dead. Each caller logs its own outcome, and the failed read
 * itself through `onReadFailure`, so one log line carries both the error and
 * the caller's context (the booking), as the chase's did before. Never throws.
 *
 * Beside `email-suppression.ts`, not in it, so a test that stands in for the
 * suppression read alone still runs this rule unchanged.
 */
export type EmailReachability = "reachable" | "no-address" | "placeholder" | "suppressed" | "unknown";

export async function emailReachability(
  email: string | null | undefined,
  onReadFailure: (err: unknown) => void = (err) => logger.error({ err }, "Could not read the email suppression list"),
): Promise<EmailReachability> {
  if (!email || !canReceiveEmail(email)) return isPlaceholderContactEmail(email) ? "placeholder" : "no-address";
  try {
    return (await getActiveEmailSuppression(email)) ? "suppressed" : "reachable";
  } catch (err) {
    onReadFailure(err);
    return "unknown";
  }
}
