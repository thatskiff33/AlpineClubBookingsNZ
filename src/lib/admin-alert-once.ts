import {
  ALERT_NOBODY_ELIGIBLE_RETRY_MS,
  ALERT_ONCE_EVER_WINDOW_MS,
  claimAlertCooldown,
  confirmAlertCooldownSend,
  deferAlertCooldown,
  releaseAlertCooldown,
} from "@/lib/alert-cooldown";
import {
  adminAlertIsDeliveredOrQueued,
  type AdminAlertSendResult,
} from "@/lib/email/admin-alert-send-result";
import logger from "@/lib/logger";
import { newOnceEverClaimHandle, runWithOnceEverClaim } from "@/lib/once-ever-claim-context";
import { prisma } from "@/lib/prisma";

/**
 * Send an admin alert at most once ever for `key` (#3672, #3663): the one rule
 * for what a once-only alert's claim does after the send. Claim first, send
 * after, outside any transaction; `send` builds and sends the alert, returning
 * `sendToAdmins`' result.
 * - an admin was sent it, or has a FAILED copy the email retry cron will
 *   re-send: the claim is kept for good, so an outage never multiplies it;
 * - nobody could receive it (the template switched off, nobody opted in,
 *   every recipient suppressed), or every copy failed before its EmailLog row
 *   existed so the retry cron has nothing to replay (#5407): the claim is held
 *   for a day, then the next run tries again;
 * - the send threw before reaching anyone, or wrote no email row under the
 *   claim (#5255): the claim is given back, so the next run retries;
 * - the claim call threw: nothing is sent, and the stamp it tried to write is
 *   given back (#4696) if the database answers one of two immediate tries: the
 *   write may have committed before the throw (#4679).
 *
 * #5255 (`INV-INT-042`): the claim is written marked "no email yet", and the
 * alert's own email rows clear that mark in the transaction that writes them
 * (`once-ever-claim-context.ts`). A claim still marked 15 minutes on - the two
 * cases #4696 could not reach: both give-backs failed on one outage, or the
 * write committed only after the give-back ran - is given back by the payments
 * cron's sweep (`admin-alert-once-sweep.ts`), so the next run sends. An email
 * row that commits first keeps the claim, so the sweep never makes a second
 * send.
 * Never throws; returns whether the claim was kept. `context` is logged with
 * every failure, `label` names the alert in those lines.
 * An alert raised at most once per WINDOW uses `sendAdminAlertOncePerWindow`
 * (`admin-alert-window.ts`) instead: there a raised alert holds its window even
 * when every copy bounced or was withheld, because the next failure inside the
 * window is reported again; here a claim kept is kept for good, so it is kept
 * only once a copy was sent or queued.
 */
export async function sendAdminAlertOnceEver(args: OnceEverAlertArgs): Promise<boolean> {
  const claim = await sendAdminAlertOnceEverClaim(args);
  if (claim.claimUncertain && claim.claimedAt) {
    await giveBackOwnOnceEverClaim({ ...args, claim: { claimedAt: claim.claimedAt, claimUncertain: true } });
  }
  return claim.kept;
}

/*
 * #4696 CENSUS, checked against the real callers by
 * `admin-alert-once-census.test.ts`: every production caller of the once-ever
 * helpers in `src/lib`, grouped by what sends its alert again once the claim
 * is given back (#5255). A caller retried by its next run calls
 * `sendAdminAlertOnceEver`, `sendAdminAlertOnceEverClaim` or the takeover
 * sequence `sendAdminAlertOnceEverWithTakeover` (`admin-alert-once-takeover.ts`);
 * one that raises its alert only once calls `sendReplayableAdminAlertOnceEver`,
 * which stores the alert for the sweep to re-send. Each caller's own docblock
 * says how it runs. A give-back cannot make a sibling send twice: it deletes
 * only a row under this call's own stamp, this call sent nothing, and a
 * sibling that read that row held sent nothing. Limit: two claims for one key
 * in the same millisecond share a stamp (at worst a duplicate). The takeover
 * callers settle only on their own kept claim or their own sent marker
 * (`isSent`), which their send writes once it returns and which is never
 * marked "no email yet": a claim still awaiting its send has no sent marker,
 * so it reads as in flight or is taken over, and a claim the sweep gives back
 * leaves the caller to retry (Stripe's redelivery, the payment recovery cron,
 * the owed-notice sweep).
 *
 * Retried by its next run (cron, or a webhook or request then cron):
 * - owed-notice/past-cutoff-once.ts
 * - stripe-dispute.ts
 * - unrecognised-stripe-payment.ts
 * - superseded-additional-refund.ts
 * - internet-banking-payment-cron.ts
 * - xero-waiting-invoice-reaper.ts
 * - group-settlement-invoice-alerts.ts
 * - group-late-joiner.ts
 * - late-capture-refund-hold.ts
 * - late-capture-unrecorded-refunds.ts
 * - cancelled-booking-late-capture.ts
 * Raised once; the sweep re-sends its stored alert:
 * - capacity-race-refund-shortfall.ts
 * - pre-persisted-refund-close.ts
 * - card-refund-cap-overflow.ts
 * - superseded-ask-invoice-return.ts
 * - xero-success-after-resolution-alert.ts
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
      awaitingSend: true,
    });
  } catch (err) {
    logger.error({ ...context, err }, `Failed to claim the ${label}; nothing was sent`);
    return { kept: false, claimedAt, claimUncertain: true };
  }
  if (!claimed) return { kept: false, claimedAt: null, claimUncertain: false };
  const handle = newOnceEverClaimHandle(key, claimedAt);
  try {
    const result = await runWithOnceEverClaim(handle, send);
    const reported = adminAlertIsDeliveredOrQueued(result);
    if (!handle.rowWritten && (handle.rowWriteFailed || (handle.taken && reported))) {
      // #5255: the alert's emails were refused or never recorded, so nothing
      // went out or waits for the retry cron, whatever the counts say.
      logger.error({ ...context, result }, `The ${label} recorded no email under its claim; it will be retried`);
    } else if (reported) {
      if (!handle.rowWritten) await confirmUntrackedSend(key, claimedAt, label, context);
      return { kept: true, claimedAt, claimUncertain: false };
    } else {
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
    }
  } catch (err) {
    logger.error({ ...context, err }, `Failed to send the ${label}; it will be retried`);
  }
  await releaseAlertCooldown({ key, claimedAt }).catch((err) =>
    logger.error({ ...context, err }, `Failed to release the ${label} claim`)
  );
  return { kept: false, claimedAt, claimUncertain: false };
}

/**
 * #5255: a send reported delivered without passing the claim to an email row
 * (its sender is not one of the admin-alert senders that take it). Clear the
 * claim's unsent mark here instead, twice if the first try fails. Limit: if
 * both fail, the sweep may give the claim back and the alert go out again.
 */
async function confirmUntrackedSend(key: string, claimedAt: Date, label: string, context: Record<string, unknown>) {
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      await confirmAlertCooldownSend({ key, claimedAt });
      return;
    } catch (err) {
      logger.error({ ...context, err, attempt }, `Failed to confirm the sent ${label} claim`);
    }
  }
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

/** How many times a once-ever alert's sent stamp is written before giving up (#5433 round 3, item 6; #5255). */
export const SENT_STAMP_WRITE_ATTEMPTS = 2;

/**
 * Write a once-ever alert's sent stamp, the marker its caller's `isSent` reads,
 * trying twice as `giveBackOwnOnceEverClaim` tries its release: without it a
 * later attempt finds a claim with no stamp and may take it over, sending the
 * alert again. The stated limit: both writes failing is logged, never thrown,
 * since a copy already went out. Never throws.
 */
export async function stampOnceEverAlertSent(sentKey: string, label: string, context: Record<string, unknown>): Promise<void> {
  for (let attempt = 1; attempt <= SENT_STAMP_WRITE_ATTEMPTS; attempt += 1) {
    try {
      await claimAlertCooldown({ key: sentKey, windowMs: ALERT_ONCE_EVER_WINDOW_MS, now: new Date() });
      return;
    } catch (err) {
      const last = attempt === SENT_STAMP_WRITE_ATTEMPTS;
      logger.error({ ...context, err, attempt }, last ? `Failed to stamp the ${label} as sent; a later attempt may send it again` : `Failed to stamp the ${label} as sent; trying once more`);
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

/**
 * #5255: where the once-ever claim for `key` stands at `now`, for the sweep and
 * the replayable alerts. `none`: no claim holds it, so the next send claims and
 * sends; `awaiting-send`: claimed, no email recorded yet; `deferred`: nobody
 * could receive it, held for a day; `kept`: sent or queued, for good. A read,
 * never a claim.
 */
export type OnceEverClaimState = "none" | "awaiting-send" | "deferred" | "kept";

export async function readOnceEverClaimState(key: string, now: Date): Promise<OnceEverClaimState> {
  const row = await prisma.alertCooldown.findUnique({
    where: { key },
    select: { lastAlertedAt: true, awaitingSendSince: true },
  });
  const windowStart = now.getTime() - ALERT_ONCE_EVER_WINDOW_MS;
  if (!row || row.lastAlertedAt.getTime() < windowStart) return "none";
  if (row.awaitingSendSince) return "awaiting-send";
  // A deferral moves the stamp to `ALERT_NOBODY_ELIGIBLE_RETRY_MS` past the window's start.
  return row.lastAlertedAt.getTime() <= windowStart + ALERT_NOBODY_ELIGIBLE_RETRY_MS ? "deferred" : "kept";
}
