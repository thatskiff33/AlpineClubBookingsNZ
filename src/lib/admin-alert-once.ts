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
import { prisma } from "@/lib/prisma";

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
export async function sendAdminAlertOnceEver(args: OnceEverAlertArgs): Promise<boolean> {
  return (await sendAdminAlertOnceEverClaim(args)).kept;
}

type OnceEverAlertArgs = {
  key: string;
  label: string;
  context: Record<string, unknown>;
  send: () => Promise<AdminAlertSendResult>;
};

/**
 * What one `sendAdminAlertOnceEver` call did with the claim (#4670): `kept`
 * as that function returns it, and `claimedAt`, the exact stamp this call
 * wrote when it took the claim, or null when another holder had it. Not kept
 * with a stamp means this call's send failed: a claim still held under that
 * exact stamp is its own, left by a release that failed, never a sibling's,
 * and `releaseAlertCooldown` with it gives back that claim and no other.
 */
export type OnceEverAlertClaim = { kept: boolean; claimedAt: Date | null };

/** `sendAdminAlertOnceEver`, reporting the claim's stamp as well (#4670). Same rule; never throws. */
export async function sendAdminAlertOnceEverClaim({
  key,
  label,
  context,
  send,
}: OnceEverAlertArgs): Promise<OnceEverAlertClaim> {
  const claimedAt = new Date();
  let claimed = false;
  try {
    claimed = await claimAlertCooldown({
      key,
      windowMs: ALERT_ONCE_EVER_WINDOW_MS,
      now: claimedAt,
    });
    if (!claimed) return { kept: false, claimedAt: null };
    const result = await send();
    if (adminAlertIsDeliveredOrQueued(result)) return { kept: true, claimedAt };
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
    return { kept: false, claimedAt };
  } catch (err) {
    logger.error({ ...context, err }, `Failed to send the ${label}; it will be retried`);
  }
  if (claimed) {
    await releaseAlertCooldown({ key, claimedAt }).catch((err) =>
      logger.error({ ...context, err }, `Failed to release the ${label} claim`)
    );
  }
  return { kept: false, claimedAt: claimed ? claimedAt : null };
}

/**
 * #4149: which of these once-ever keys are held now - claimed and kept, or
 * deferred for a day because nobody could receive the alert - so a sweep can
 * leave a subject whose alert is settled off its list. A key never claimed, or
 * given back after a send that threw, is not held, and the next
 * `sendAdminAlertOnceEver` for it sends. A read, never a claim.
 */
export async function findHeldOnceEverAlertKeys(keys: readonly string[], now: Date): Promise<Set<string>> {
  return new Set((await readHeldOnceEverAlertTimes(keys, now)).keys());
}

/** The same read, with each held key's stamp (its claim's time, or a marker's), for a caller that compares it. */
export async function readHeldOnceEverAlertTimes(keys: readonly string[], now: Date): Promise<Map<string, Date>> {
  if (keys.length === 0) return new Map();
  const rows = await prisma.alertCooldown.findMany({
    where: { key: { in: [...keys] }, lastAlertedAt: { gte: new Date(now.getTime() - ALERT_ONCE_EVER_WINDOW_MS) } },
    select: { key: true, lastAlertedAt: true },
  });
  return new Map(rows.map((row) => [row.key, row.lastAlertedAt]));
}
