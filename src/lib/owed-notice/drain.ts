/**
 * #5433: THE SWEEP OF OWED NOTICES. Run by the confirm-pending job and by the
 * email retry job (every 30 minutes). It reads the due markers of every
 * registered kind from every place they can be (`owedNoticeRegistry`), one
 * list per kind and place, then takes them in turn, one from each list round
 * the lists, and hands each to `sweepOwedNotice`. Taking them in turn is what
 * keeps a capped run fair: a backlog in one kind cannot use up the whole
 * allowance however many kinds there are.
 *
 * A kind with no deliverer here is never read, so its markers stay where they
 * are: a newer release running beside this one during a blue-green switchover
 * may own them, and deleting them would lose its notices. The sweep reports
 * markers of such kinds that are older than `UNKNOWN_KIND_REPORT_AFTER_MS`, at
 * most once a day across the club's app instances (the `AlertCooldown` claim
 * the repeat operational alerts use), so a kind nobody delivers is seen
 * without flooding the log. `docs/UPGRADING.md` says what an operator does.
 *
 * A caller may cap a run (`maxRows`, `budgetMs`): the sweep stops once that
 * many markers have been CLAIMED (a marker another run holds costs nothing),
 * or the time is spent, and leaves the rest, still owed, for the next run.
 * Never throws, for one marker or for the read of a list. Two drains at once
 * are safe: each marker is claimed before anything else, and the loser of a
 * claim sends nothing.
 */
import { claimAlertCooldown } from "@/lib/alert-cooldown";
import logger from "@/lib/logger";
import { sweepOwedNotice, type OwedNoticeDeliverer, type OwedNoticeRef, type OwedNoticeSource } from "@/lib/owed-notice/deliver";
import { owedNoticeRegistry } from "@/lib/owed-notice/registry";
import { findStaleUnknownOwedNotices, UNKNOWN_KIND_REPORT_LIMIT } from "@/lib/owed-notice/store";

/** A marker of a kind this release does not deliver is reported once it is older than this (a week). */
export const UNKNOWN_KIND_REPORT_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

/** The unknown-kind report is logged at most once per this, across instances (a day). */
export const UNKNOWN_KIND_REPORT_EVERY_MS = 24 * 60 * 60 * 1000;
const UNKNOWN_KIND_REPORT_KEY = "owed-notice-unknown-kinds";

/**
 * The two jobs that sweep, and each one's cap per run. The email retry job runs
 * every 30 minutes with nothing else to do first, so it is the main sweeper:
 * 100 markers or two minutes. The confirm-pending job runs every three hours
 * and sweeps BEFORE its pending-booking pass, inside a 30-minute runtime
 * limit, so it takes less: 25 markers or 30 seconds. Whatever it leaves, the
 * email retry job takes within half an hour.
 */
export const EMAIL_RETRY_OWED_NOTICE_CAP = { maxRows: 100, budgetMs: 2 * 60 * 1000 } as const;
export const CONFIRM_PENDING_OWED_NOTICE_CAP = { maxRows: 25, budgetMs: 30 * 1000 } as const;

export interface OwedNoticeSweepResult {
  /** Due markers offered to this run (a marker another run held counts here too). */
  checked: number;
  /** Notices whose send settled, and whose marker was cleared. */
  delivered: number;
  /** Cleared without a send: the subject is gone or has moved on. */
  cleared: number;
  /** Cleared without a send, with an error log: past the maximum age or the cut-off, or unreadable. */
  expired: number;
  /** Present, and true, when the run stopped at its cap with due markers it had read still left. */
  capped?: true;
}

export interface OwedNoticeDrainOptions {
  /** The job running the sweep, for its logs and its sends'. */
  job?: string;
  /** Stop once this many markers have been claimed. */
  maxRows?: number;
  /** Stop once this much time has passed since the run began. */
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

/** Report markers of kinds no deliverer here names that have waited past the report age, at most once a day. Never throws. */
async function reportUnknownKinds(deliverers: readonly OwedNoticeDeliverer[], now: Date, job: string): Promise<void> {
  try {
    const { count, kinds } = await findStaleUnknownOwedNotices({
      knownKinds: deliverers.map((deliverer) => deliverer.kind),
      createdBefore: new Date(now.getTime() - UNKNOWN_KIND_REPORT_AFTER_MS),
    });
    if (count === 0) return;
    // Fails open: a claim that cannot be read still logs.
    const due = await claimAlertCooldown({ key: UNKNOWN_KIND_REPORT_KEY, windowMs: UNKNOWN_KIND_REPORT_EVERY_MS, now }).catch(() => true);
    if (!due) return;
    logger.error(
      { count, atLeast: count >= UNKNOWN_KIND_REPORT_LIMIT, kinds, olderThanMs: UNKNOWN_KIND_REPORT_AFTER_MS, job },
      "Owed notices of a kind this release does not deliver have waited over a week; left in place (a newer release may own them). See docs/UPGRADING.md, owed notices of an unknown kind",
    );
  } catch (err) {
    logger.error({ err, job }, "Failed to read owed notices of unknown kinds");
  }
}

/** One list of due markers: a kind's, from one place. */
type Queue = { deliverer: OwedNoticeDeliverer; dueBefore: Date; refs: OwedNoticeRef[]; next: number };

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

  // Read every list first, so the turn-taking below sees them all.
  const queues: Queue[] = [];
  for (const deliverer of deliverers) {
    const dueBefore = new Date(now.getTime() - deliverer.sweepAfterMs);
    for (const source of sources) {
      try {
        queues.push({ deliverer, dueBefore, refs: await source.listDue(deliverer, { dueBefore, now }), next: 0 });
      } catch (err) {
        logger.error({ err, kind: deliverer.kind, source: source.name, job }, "Failed to read the owed notices");
      }
    }
  }

  let claimed = 0;
  const left = () => queues.some((queue) => queue.next < queue.refs.length);
  while (left()) {
    for (const queue of queues) {
      if (queue.next >= queue.refs.length) continue;
      if (claimed >= maxRows || elapsedMs() >= budgetMs) {
        result.capped = true;
        logger.info({ ...result, maxRows, budgetMs, job }, "The owed-notice sweep reached its cap; the rest stay owed for the next run");
        await reportUnknownKinds(deliverers, now, job);
        return result;
      }
      const ref = queue.refs[queue.next++]!;
      result.checked += 1;
      try {
        const outcome = await sweepOwedNotice(queue.deliverer, ref, queue.dueBefore, now, job);
        if (outcome !== "claim-lost") claimed += 1;
        if (outcome === "delivered" || outcome === "cleared" || outcome === "expired") result[outcome] += 1;
      } catch (err) {
        // The claim may or may not have been taken; count it, so a run whose
        // reads keep failing still stops at its cap.
        claimed += 1;
        logger.error({ err, key: ref.key, job }, "Failed to deliver an owed notice; it stays owed");
      }
    }
  }
  await reportUnknownKinds(deliverers, now, job);
  return result;
}
