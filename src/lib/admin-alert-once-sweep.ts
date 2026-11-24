import type { Prisma } from "@prisma/client";

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

/** Owed rows read per page, and the most a run acts on (sends, settles, drops or fails on). */
const OWED_PAGE_SIZE = 50;
/** The most owed rows one run reads, skipped ones included, so a run stays bounded. */
const OWED_SCAN_LIMIT = 1000;

type OwedRow = { key: string; lastAlertedAt: Date; replayAlert: Prisma.JsonValue };

/**
 * Oldest first, paging past rows it skips (a claim in flight, deferred for
 * the day, or a row that threw), so skipped rows never hold newer ones back:
 * only rows it acts on count against the per-run budget. Pages by `(lastAlertedAt, key)` rather
 * than a cursor row, because a settled row is deleted mid-run.
 */
async function drainOwedAlerts(now: Date, result: OnceEverAlertSweepResult): Promise<void> {
  let after: OwedRow | null = null;
  let acted = 0;
  let scanned = 0;
  while (acted < OWED_PAGE_SIZE && scanned < OWED_SCAN_LIMIT) {
    let page: OwedRow[];
    try {
      page = await prisma.alertCooldown.findMany({
        where: {
          key: exactPrefix(ONCE_EVER_OWED_PREFIX),
          ...(after
            ? {
                OR: [
                  { lastAlertedAt: { gt: after.lastAlertedAt } },
                  { lastAlertedAt: after.lastAlertedAt, key: { gt: after.key } },
                ],
              }
            : {}),
        },
        select: { key: true, lastAlertedAt: true, replayAlert: true },
        orderBy: [{ lastAlertedAt: "asc" }, { key: "asc" }],
        take: OWED_PAGE_SIZE,
      });
    } catch (err) {
      result.failed += 1;
      logger.error({ err }, "Failed to list owed once-ever alerts");
      return;
    }
    for (const row of page) {
      after = row;
      scanned += 1;
      if ((await sweepOwedRow(row, now, result)) === "acted") acted += 1;
      if (acted >= OWED_PAGE_SIZE || scanned >= OWED_SCAN_LIMIT) break;
    }
    if (page.length < OWED_PAGE_SIZE) return;
  }
  if (scanned >= OWED_SCAN_LIMIT) {
    logger.warn({ scanned }, "The once-ever alert sweep reached its scan limit; the rest wait for the next run");
  }
}

async function sweepOwedRow(row: OwedRow, now: Date, result: OnceEverAlertSweepResult): Promise<"acted" | "skipped"> {
  const key = row.key.slice(ONCE_EVER_OWED_PREFIX.length);
  const context = { key, owedSince: row.lastAlertedAt };
  try {
    const state = await readOnceEverClaimState(key, now);
    if (state === "kept") {
      await settleOwedAlert({ key: row.key });
      result.settled += 1;
      return "acted";
    }
    const stored = parseStoredReplayableAlert(row.replayAlert);
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
      return "acted";
    }
    if (state !== "none") return "skipped";
    const send = await replayableAlertSend(stored.alert);
    if (await sendStoredAlertOnceEver({ key, context, label: stored.label, send })) result.resent += 1;
    return "acted";
  } catch (err) {
    result.failed += 1;
    logger.error({ ...context, err }, "Failed to sweep an owed once-ever admin alert");
    // Skipped, not acted: rows that keep throwing must not hold newer ones back.
    return "skipped";
  }
}
