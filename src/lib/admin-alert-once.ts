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
 *   next run retries;
 * - the claim call threw: nothing is sent, and the stamp it tried to write is
 *   given back, twice if need be (#4696): the write may have committed before
 *   the throw (#4679), and a claim nobody uses would hold the alert for good.
 *   A no-op when nothing landed; the next run claims afresh and sends.
 * Never throws; returns whether the claim was kept. `context` is logged with
 * every failure, `label` names the alert in those lines.
 */
export async function sendAdminAlertOnceEver(args: OnceEverAlertArgs): Promise<boolean> {
  const claim = await sendAdminAlertOnceEverClaim(args);
  if (claim.claimUncertain && claim.claimedAt) {
    await giveBackOwnOnceEverClaim({ ...args, claim: { claimedAt: claim.claimedAt, claimUncertain: true } });
  }
  return claim.kept;
}

/*
 * #4696 CENSUS: every `sendAdminAlertOnceEver` caller, and what its next run
 * does with an uncertain claim given back. The give-back cannot let a sibling
 * send twice, bar one limit: it deletes only a row stamped with this call's own
 * stamp, and the call sent nothing; a sibling that read that row held sent
 * nothing; a sibling's own claim carries its own stamp. The limit: two claims
 * for one key in the same millisecond share a stamp, so at worst a duplicate,
 * never a loss.
 * The claim-reporting callers (`admin-alert-once-takeover.ts`) give back
 * their own.
 *
 * Retried by the next run:
 * - internet-banking-payment-cron.ts (cron): the started-stay hold stays, re-offered each cycle;
 * - xero-waiting-invoice-reaper.ts (cron): a stamped row is offered to the alert every run;
 * - group-settlement-invoice-alerts.ts (group-settlement reaper cron): the started-stay group is kept, re-read each run;
 * - group-late-joiner.ts (settle request or webhook, then cron): `alertStartedStayPayerSwitches` each cycle;
 * - late-capture-refund-hold.ts (webhook, then cron): the payments cron re-announces every OPEN held task;
 * - late-capture-unrecorded-refunds.ts (webhook, then cron): the nightly self-heal raises it again;
 * - cancelled-booking-late-capture.ts (webhook, then cron): the nightly recovery skips only a held key.
 * Retried only by a later event on the same subject, with no schedule of its own:
 * - card-refund-cap-overflow.ts (inline after a refund write): a later refund write on the charge;
 * - superseded-ask-invoice-return.ts (inline at a capture's release): a later release of that capture;
 * - xero-success-after-resolution-alert.ts (inline after an outbox write): another late success on the row.
 * Cannot retry (nothing calls again; the logged error is the trace):
 * - pre-persisted-refund-close.ts (inline, a lost close);
 * - capacity-race-refund-shortfall.ts (webhook, at the capacity-race cancel, which a redelivery does not
 *   repeat; any shortfall task on the payments board stands).
 */

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
 *
 * #4679: `claimUncertain` means the claim call itself threw, so nothing was
 * sent, yet the write may have committed (the connection dropped before the
 * reply). `claimedAt` is then the stamp it tried to write: a claim held under
 * it is this call's own, and giving it back changes nothing when the write
 * never landed. This variant gives nothing back: its caller does
 * (`giveBackOwnOnceEverClaim`), as the boolean wrapper does for its own (#4696).
 */
export type OnceEverAlertClaim = { kept: boolean; claimedAt: Date | null; claimUncertain: boolean };

/** `sendAdminAlertOnceEver`, reporting the claim's stamp as well (#4670). Same rule, but an uncertain claim is the caller's to give back; never throws. */
export async function sendAdminAlertOnceEverClaim({
  key,
  label,
  context,
  send,
}: OnceEverAlertArgs): Promise<OnceEverAlertClaim> {
  const claimedAt = new Date();
  let claimed: boolean;
  try {
    claimed = await claimAlertCooldown({
      key,
      windowMs: ALERT_ONCE_EVER_WINDOW_MS,
      now: claimedAt,
    });
  } catch (err) {
    logger.error({ ...context, err }, `Failed to claim the ${label}; nothing was sent`);
    return { kept: false, claimedAt, claimUncertain: true };
  }
  if (!claimed) return { kept: false, claimedAt: null, claimUncertain: false };
  try {
    const result = await send();
    if (adminAlertIsDeliveredOrQueued(result)) return { kept: true, claimedAt, claimUncertain: false };
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
    return { kept: false, claimedAt, claimUncertain: false };
  } catch (err) {
    logger.error({ ...context, err }, `Failed to send the ${label}; it will be retried`);
  }
  await releaseAlertCooldown({ key, claimedAt }).catch((err) =>
    logger.error({ ...context, err }, `Failed to release the ${label} claim`)
  );
  return { kept: false, claimedAt, claimUncertain: false };
}

/**
 * Give back a once-ever claim this call took and could not use, under the exact
 * stamp it wrote, so a newer claim is never touched (#4670). An uncertain claim
 * (its write threw, #4679) gets two tries; a failed send's one more, after the
 * claim helper's own. Never throws.
 */
export async function giveBackOwnOnceEverClaim({
  key,
  label,
  context,
  claim,
}: {
  key: string;
  label: string;
  context: Record<string, unknown>;
  claim: Pick<OnceEverAlertClaim, "claimUncertain"> & { claimedAt: Date };
}): Promise<void> {
  const failed = claim.claimUncertain ? "Failed to give back the uncertain" : "Failed again to release the";
  for (let attempt = 1; attempt <= (claim.claimUncertain ? 2 : 1); attempt += 1) {
    try {
      await releaseAlertCooldown({ key, claimedAt: claim.claimedAt });
      return;
    } catch (err) {
      logger.error({ ...context, err, attempt }, `${failed} ${label} claim`);
    }
  }
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
