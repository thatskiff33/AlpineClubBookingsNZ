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
 * THE ONE SEQUENCE for an admin alert raised at most once per window for its
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
 * - nobody could receive it (`skipped-by-policy`, `no-recipients`), or it
 *   reached nobody and nothing will replay it (`adminAlertNeedsResend`: a copy
 *   failed before its mail log row existed): held for
 *   `ALERT_NOBODY_ELIGIBLE_RETRY_MS` (a day) from the claim, whether the
 *   window is longer or shorter, then the next call tries again: one attempt
 *   a day, not one per call, `raised`;
 * - another holder has the window: nothing sent, `held`;
 * - the send threw: given back, so the next call retries, `send-threw` with
 *   the error for the caller to log;
 * - the claim call threw: its stamp may have landed before the throw, so it is
 *   given back and the error rethrown.
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
  send,
}: {
  key: string;
  windowMs: number;
  now?: Date;
  label: string;
  context: Record<string, unknown>;
  send: () => Promise<AdminAlertRecipientsResult>;
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
    result = await send();
  } catch (error) {
    await releaseAlertCooldown({ key, claimedAt: now }).catch((err) =>
      logger.error({ err, ...context }, `Failed to release the ${label} claim`)
    );
    return { raised: false, reason: "send-threw", error };
  }
  const outcome = adminAlertSendOutcome(result);
  if (outcome === "skipped-by-policy" || outcome === "no-recipients" || adminAlertNeedsResend(result)) {
    await deferAlertCooldown({
      key,
      claimedAt: now,
      windowMs,
      retryAfterMs: ALERT_NOBODY_ELIGIBLE_RETRY_MS,
    }).catch((err) =>
      logger.error({ err, ...context, outcome }, `Failed to defer the ${label} claim`)
    );
  }
  return { raised: true };
}
