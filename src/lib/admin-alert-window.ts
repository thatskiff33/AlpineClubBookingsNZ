import {
  ALERT_NOBODY_ELIGIBLE_RETRY_MS,
  claimAlertCooldown,
  deferAlertCooldown,
  releaseAlertCooldown,
} from "@/lib/alert-cooldown";
import {
  adminAlertNeedsResend,
  adminAlertSendOutcome,
  type AdminAlertRecipientsResult,
} from "@/lib/email/admin-alert-send-result";
import logger from "@/lib/logger";

/** What one `sendAdminAlertOncePerWindow` call did. */
export type WindowedAlertAttempt =
  | { raised: true }
  | { raised: false; reason: "held" }
  | { raised: false; reason: "send-threw"; error: unknown };

/**
 * The one sequence for an admin alert raised at most once per window for its
 * `AlertCooldown` key (#5407 items 29 and 37): the repeated Xero failure alert
 * (one key per correlation key, 24 hours) and the Xero sync error alert (one
 * key for every error type, one hour). Claim first and send after, outside any
 * transaction (`alert-cooldown.ts`), so two instances raise one alert.
 *
 * The claim asks "has this alert already been RAISED", not "did it arrive"
 * (#3035 review). After the send it is settled by the shared reading of the
 * result (`adminAlertSendOutcome`) and the house rule in `alert-cooldown.ts`
 * (#3635 F1):
 * - sent, queued for the retry cron, or undelivered (BOUNCED, or withheld on a
 *   copy as `SKIPPED_NON_PRODUCTION`): kept for the window, `raised`;
 * - nobody could receive it (`skipped-by-policy`, `no-recipients`): held for
 *   `ALERT_NOBODY_ELIGIBLE_RETRY_MS` (a day) from the claim, whether the
 *   window is longer or shorter, then the next call tries again: one attempt
 *   a day, not one per call, `raised`;
 * - it reached nobody and nothing will replay it (`adminAlertNeedsResend`: a
 *   copy failed before its mail log row existed, a transient fault): held for
 *   the shorter of a day and the window, so a one-hour key reopens after an
 *   hour and a 24-hour key after the same day, `raised`;
 * - another holder has the window: nothing sent, `held`;
 * - the send threw: given back, so the next call retries, `send-threw` with
 *   the error for the caller to log;
 * - the claim call threw: its stamp may have landed before the throw, so it is
 *   given back and the error rethrown.
 *
 * Beside `sendAdminAlertOnceEver` (`admin-alert-once.ts`), which is for an
 * alert raised once EVER: that one keeps its claim only when a copy was sent
 * or queued and defers a bounced or withheld copy too, because a once-ever
 * alert must reach someone; here a raised alert holds its window whatever
 * became of each copy, because the next failure inside the window will be
 * reported again anyway.
 *
 * `label` names the alert and `context` is logged in the release and defer
 * failure lines.
 */
export async function sendAdminAlertOncePerWindow({
  key,
  windowMs,
  now = new Date(),
  label,
  context,
  raiseAlert,
}: {
  key: string;
  windowMs: number;
  now?: Date;
  label: string;
  context: Record<string, unknown>;
  // Not named `send`: the advisory-lock isolation census (INV-LOCK-005) joins
  // functions by name, and an unrelated `send` elsewhere reaches a lock helper.
  raiseAlert: () => Promise<AdminAlertRecipientsResult>;
}): Promise<WindowedAlertAttempt> {
  let claimed: boolean;
  try {
    claimed = await claimAlertCooldown({ key, windowMs, now });
  } catch (error) {
    // The write may have committed before the throw: give back this call's
    // own stamp so the next call can alert, then fail as the read did.
    await releaseAlertCooldown({ key, claimedAt: now }).catch(() => undefined);
    throw error;
  }
  if (!claimed) return { raised: false, reason: "held" };

  let result: AdminAlertRecipientsResult;
  try {
    result = await raiseAlert();
  } catch (error) {
    await releaseAlertCooldown({ key, claimedAt: now }).catch((err) =>
      logger.error({ err, ...context }, `Failed to release the ${label} claim`)
    );
    return { raised: false, reason: "send-threw", error };
  }
  const outcome = adminAlertSendOutcome(result);
  const nobodyEligible = outcome === "skipped-by-policy" || outcome === "no-recipients";
  if (nobodyEligible || adminAlertNeedsResend(result)) {
    await deferAlertCooldown({
      key,
      claimedAt: now,
      windowMs,
      // A transient mail fault is not a setting: it is held no longer than the
      // window, so a one-hour key is not shut for a day by one bad send.
      retryAfterMs: nobodyEligible
        ? ALERT_NOBODY_ELIGIBLE_RETRY_MS
        : Math.min(ALERT_NOBODY_ELIGIBLE_RETRY_MS, windowMs),
    }).catch((err) =>
      logger.error({ err, ...context, outcome }, `Failed to defer the ${label} claim`)
    );
  }
  return { raised: true };
}
