import {
  ALERT_NOBODY_ELIGIBLE_RETRY_MS,
  ALERT_ONCE_EVER_WINDOW_MS,
  claimAlertCooldown,
  deferAlertCooldown,
  releaseAlertCooldown,
} from "@/lib/alert-cooldown";
import {
  adminAlertIsDeliveredOrQueued,
  type AdminAlertSendResult,
} from "@/lib/email/admin-alert-send-result";
import logger from "@/lib/logger";

/**
 * Send an admin alert at most once ever for `key` (#3672, #3663): the one rule
 * for what a once-only alert's claim does after the send. Claim first, send
 * after, outside any transaction; `send` builds and sends the alert, returning
 * `sendToAdmins`' result.
 * - an admin was sent it, or has a FAILED copy the email retry cron will
 *   re-send: the claim is kept for good, so an outage never multiplies it;
 * - nobody could receive it (the template switched off, nobody opted in,
 *   every recipient suppressed): the claim is held for a day, then the next
 *   run tries again;
 * - the send threw before reaching anyone: the claim is given back, so the
 *   next run retries.
 * Never throws; returns whether the claim was kept. `context` is logged with
 * every failure, `label` names the alert in those lines.
 */
export async function sendAdminAlertOnceEver({
  key,
  label,
  context,
  send,
}: {
  key: string;
  label: string;
  context: Record<string, unknown>;
  send: () => Promise<AdminAlertSendResult>;
}): Promise<boolean> {
  const claimedAt = new Date();
  let claimed = false;
  try {
    claimed = await claimAlertCooldown({
      key,
      windowMs: ALERT_ONCE_EVER_WINDOW_MS,
      now: claimedAt,
    });
    if (!claimed) return false;
    const result = await send();
    if (adminAlertIsDeliveredOrQueued(result)) return true;
    logger.error(
      { ...context, result },
      `No admin can receive the ${label}; it will be retried in a day`
    );
    await deferAlertCooldown({
      key,
      claimedAt,
      windowMs: ALERT_ONCE_EVER_WINDOW_MS,
      retryAfterMs: ALERT_NOBODY_ELIGIBLE_RETRY_MS,
    }).catch((err) =>
      logger.error({ ...context, err }, `Failed to defer the ${label} claim`)
    );
    return false;
  } catch (err) {
    logger.error({ ...context, err }, `Failed to send the ${label}; it will be retried`);
  }
  if (claimed) {
    await releaseAlertCooldown({ key, claimedAt }).catch((err) =>
      logger.error({ ...context, err }, `Failed to release the ${label} claim`)
    );
  }
  return false;
}
