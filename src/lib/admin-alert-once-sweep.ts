import { readOnceEverClaimState } from "@/lib/admin-alert-once";
import {
  ONCE_EVER_OWED_PREFIX,
  parseStoredReplayableAlert,
  replayableAlertSend,
  sendStoredAlertOnceEver,
} from "@/lib/admin-alert-once-replayable";
import { listStaleUnsentAlertCooldowns, releaseUnsentAlertCooldown, settleOwedAlert } from "@/lib/alert-cooldown";
import logger from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import { exactPrefix } from "@/lib/prisma-exact-prefix";

/**
 * #5255 (`INV-INT-042`): THE ONCE-EVER ALERT SWEEP, the first task of the
 * 15-minute payments cron cycle (`once-ever-alert-sweep`).
 *
 * 1. A once-ever claim still marked "no email yet" `ONCE_EVER_UNSENT_GRACE_MS`
 *    after it was taken has nothing sent or queued behind it - its claim
 *    write threw and its give-backs failed, or the write committed after the
 *    give-back ran (#4696). It is given back, so the caller's next run claims
 *    and sends. The give-back deletes only a row still marked under the stamp
 *    read, and an alert's email row clears the mark in the transaction that
 *    writes it, so the row lock decides: an email recorded first keeps the
 *    claim, and one refused after the give-back is never sent. With a run
 *    every 15 minutes, a claim is given back within 30 minutes of its write.
 * 2. A raised-once alert's owed row (`admin-alert-once-replayable.ts`) is
 *    settled once its claim is kept, re-sent through the same claim while no
 *    claim holds it, left while one is in flight or deferred for the day, and
 *    dropped with an error after `ONCE_EVER_OWED_GIVE_UP_MS` unsent.
 *
 * Never throws: each row is isolated, and `failed` counts what could not be
 * read or written, for the run's warning.
 */
export async function sweepOnceEverAlerts(now: Date = new Date()): Promise<OnceEverAlertSweepResult> {
  const result: OnceEverAlertSweepResult = { released: 0, resent: 0, settled: 0, dropped: 0, failed: 0 };
  await releaseStaleUnsentClaims(now, result);
  await drainOwedAlerts(now, result);
  return result;
}

export type OnceEverAlertSweepResult = {
  /** Claims given back because no email was recorded under them. */
  released: number;
  /** Raised-once alerts re-sent and kept. */
  resent: number;
  /** Owed rows whose alert was already sent. */
  settled: number;
  /** Owed rows given up on, each logged as an error. */
  dropped: number;
  /** Reads or writes that failed; retried next run. */
  failed: number;
};

/** How long a claim may stay marked unsent before the sweep gives it back: one cron period. */
export const ONCE_EVER_UNSENT_GRACE_MS = 15 * 60_000;

/** How long the sweep keeps re-sending a raised-once alert nobody received. */
export const ONCE_EVER_OWED_GIVE_UP_MS = 7 * 86_400_000;

async function releaseStaleUnsentClaims(now: Date, result: OnceEverAlertSweepResult): Promise<void> {
  let stale: { key: string; lastAlertedAt: Date }[];
  try {
    stale = await listStaleUnsentAlertCooldowns({ markedBefore: new Date(now.getTime() - ONCE_EVER_UNSENT_GRACE_MS) });
  } catch (err) {
    result.failed += 1;
    logger.error({ err }, "Failed to list once-ever alert claims with no email behind them");
    return;
  }
  for (const claim of stale) {
    try {
      if (await releaseUnsentAlertCooldown({ key: claim.key, claimedAt: claim.lastAlertedAt })) {
        result.released += 1;
        logger.warn(
          { key: claim.key, claimedAt: claim.lastAlertedAt },
          "Gave back a once-ever alert claim with no email behind it; its next run sends the alert (#5255)",
        );
      }
    } catch (err) {
      result.failed += 1;
      logger.error({ err, key: claim.key }, "Failed to give back a once-ever alert claim with no email behind it");
    }
  }
}

async function drainOwedAlerts(now: Date, result: OnceEverAlertSweepResult): Promise<void> {
  let owed: { key: string; lastAlertedAt: Date; replayAlert: unknown }[];
  try {
    owed = await prisma.alertCooldown.findMany({
      where: { key: exactPrefix(ONCE_EVER_OWED_PREFIX) },
      select: { key: true, lastAlertedAt: true, replayAlert: true },
      orderBy: { lastAlertedAt: "asc" },
      take: 50,
    });
  } catch (err) {
    result.failed += 1;
    logger.error({ err }, "Failed to list owed once-ever alerts");
    return;
  }
  for (const row of owed) {
    const key = row.key.slice(ONCE_EVER_OWED_PREFIX.length);
    const context = { key, owedSince: row.lastAlertedAt };
    try {
      const state = await readOnceEverClaimState(key, now);
      if (state === "kept") {
        await settleOwedAlert({ key: row.key });
        result.settled += 1;
        continue;
      }
      const stored = parseStoredReplayableAlert(row.replayAlert as Parameters<typeof parseStoredReplayableAlert>[0]);
      const givenUp = now.getTime() - row.lastAlertedAt.getTime() >= ONCE_EVER_OWED_GIVE_UP_MS;
      if (!stored || givenUp) {
        logger.error(
          { ...context, state, label: stored?.label },
          stored
            ? "Gave up re-sending a once-ever admin alert nobody received in 7 days; the error log is its only record (#5255)"
            : "Dropped an owed once-ever admin alert this release cannot read; the error log is its only record (#5255)",
        );
        await settleOwedAlert({ key: row.key });
        result.dropped += 1;
        continue;
      }
      if (state !== "none") continue;
      const send = await replayableAlertSend(stored.alert);
      if (await sendStoredAlertOnceEver({ key, context, label: stored.label, send })) result.resent += 1;
    } catch (err) {
      result.failed += 1;
      logger.error({ ...context, err }, "Failed to sweep an owed once-ever admin alert");
    }
  }
}
