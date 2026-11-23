/**
 * #5433: THE SWEEP OF OWED NOTICES. Run by the confirm-pending job and by the
 * email retry job (every 30 minutes). For each registered kind and each place
 * its markers can be (`owedNoticeRegistry`), it offers the markers whose
 * stamp is at least the kind's wait old and hands each to `sweepOwedNotice`.
 *
 * A kind with no deliverer here is never read, so its markers stay where they
 * are: a newer release running beside this one during a blue-green switchover
 * may own them, and deleting them would lose its notices. Once per run the
 * sweep counts the markers of such kinds that are older than
 * `UNKNOWN_KIND_REPORT_AFTER_MS` and logs the count as an error, so a kind
 * nobody delivers is seen rather than silently kept.
 *
 * A caller may cap a run (`maxRows`, `budgetMs`): the sweep stops offering
 * markers once either is reached and leaves the rest, still owed, for the next
 * run. Never throws, for one marker or for the read of a list. Two drains at
 * once are safe: each marker is claimed before anything else, and the loser of
 * a claim sends nothing.
 */
import logger from "@/lib/logger";
import { sweepOwedNotice, type OwedNoticeDeliverer, type OwedNoticeSource } from "@/lib/owed-notice/deliver";
import { owedNoticeRegistry } from "@/lib/owed-notice/registry";
import { countStaleUnknownOwedNotices } from "@/lib/owed-notice/store";

/** A marker of a kind this release does not deliver is reported once it is older than this (a week). */
export const UNKNOWN_KIND_REPORT_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

export interface OwedNoticeSweepResult {
  /** Due markers offered to this run. */
  checked: number;
  /** Notices whose send settled, and whose marker was cleared. */
  delivered: number;
  /** Cleared without a send: the subject is gone or has moved on. */
  cleared: number;
  /** Cleared without a send, with an error log: past the maximum age or the cut-off, or unreadable. */
  expired: number;
  /** Present, and true, when the run stopped at its cap and left due markers for the next run. */
  capped?: true;
}

export interface OwedNoticeDrainOptions {
  /** The job running the sweep, for its logs and its sends'. */
  job?: string;
  /** Stop offering markers once this many have been offered. */
  maxRows?: number;
  /** Stop offering markers once this much time has passed since the run began. */
  budgetMs?: number;
  /** Time since the run began; `performance.now()` based unless a test supplies one. */
  elapsedMs?: () => number;
  deliverers?: readonly OwedNoticeDeliverer[];
  sources?: readonly OwedNoticeSource[];
}

function startClock(): () => number {
  const started = performance.now();
  return () => performance.now() - started;
}

/** Log, once, how many markers of kinds no deliverer here names have waited past the report age. Never throws. */
async function reportUnknownKinds(deliverers: readonly OwedNoticeDeliverer[], now: Date, job: string): Promise<void> {
  try {
    const count = await countStaleUnknownOwedNotices({
      knownKinds: deliverers.map((deliverer) => deliverer.kind),
      createdBefore: new Date(now.getTime() - UNKNOWN_KIND_REPORT_AFTER_MS),
    });
    if (count > 0) {
      logger.error(
        { count, olderThanMs: UNKNOWN_KIND_REPORT_AFTER_MS, job },
        "Owed notices of a kind this release does not deliver have waited over a week; left in place (a newer release may own them), check the release and its registry",
      );
    }
  } catch (err) {
    logger.error({ err, job }, "Failed to count owed notices of unknown kinds");
  }
}

export async function drainOwedNotices(now: Date = new Date(), options: OwedNoticeDrainOptions = {}): Promise<OwedNoticeSweepResult> {
  const registry = owedNoticeRegistry();
  const {
    job = "owed-notice-sweep",
    maxRows = Number.POSITIVE_INFINITY,
    budgetMs = Number.POSITIVE_INFINITY,
    elapsedMs = startClock(),
    deliverers = registry.deliverers,
    sources = registry.sources,
  } = options;
  const result: OwedNoticeSweepResult = { checked: 0, delivered: 0, cleared: 0, expired: 0 };
  const atCap = () => result.checked >= maxRows || elapsedMs() >= budgetMs;
  let capped = false;
  run: for (const deliverer of deliverers) {
    const dueBefore = new Date(now.getTime() - deliverer.sweepAfterMs);
    for (const source of sources) {
      if (atCap()) {
        capped = true;
        break run;
      }
      let refs;
      try {
        refs = await source.listDue(deliverer, { dueBefore, now });
      } catch (err) {
        logger.error({ err, kind: deliverer.kind, source: source.name, job }, "Failed to read the owed notices");
        continue;
      }
      for (const ref of refs) {
        if (atCap()) {
          capped = true;
          break run;
        }
        result.checked += 1;
        try {
          const outcome = await sweepOwedNotice(deliverer, ref, dueBefore, now, job);
          if (outcome === "delivered" || outcome === "cleared" || outcome === "expired") result[outcome] += 1;
        } catch (err) {
          logger.error({ err, key: ref.key, job }, "Failed to deliver an owed notice; it stays owed");
        }
      }
    }
  }
  if (capped) {
    result.capped = true;
    logger.info({ ...result, maxRows, budgetMs, job }, "The owed-notice sweep reached its cap; the rest stay owed for the next run");
  }
  await reportUnknownKinds(deliverers, now, job);
  return result;
}
