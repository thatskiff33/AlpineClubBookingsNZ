/**
 * #5433: THE SWEEP OF OWED NOTICES. Run by the confirm-pending job and by the
 * email retry job (every 30 minutes). For each registered kind and each place
 * its markers can be (`OWED_NOTICE_SOURCES`), it offers the markers whose
 * stamp is at least the kind's wait old and hands each to `sweepOwedNotice`.
 *
 * A kind with no deliverer here is never read, so its markers stay where they
 * are: a newer release running beside this one during a blue-green switchover
 * may own them, and deleting them would lose its notices.
 *
 * Never throws, for one marker or for the read of a list. Two drains at once
 * are safe: each marker is claimed before anything else, and the loser of a
 * claim sends nothing.
 */
import logger from "@/lib/logger";
import { sweepOwedNotice, type OwedNoticeDeliverer, type OwedNoticeSource } from "@/lib/owed-notice/deliver";
import { OWED_NOTICE_DELIVERERS, OWED_NOTICE_SOURCES } from "@/lib/owed-notice/registry";

export interface OwedNoticeSweepResult {
  /** Due markers offered to this run. */
  checked: number;
  /** Notices whose send settled, and whose marker was cleared. */
  delivered: number;
  /** Cleared without a send: the subject is gone or has moved on. */
  cleared: number;
  /** Cleared without a send, with an error log: past the maximum age or the cut-off, or unreadable. */
  expired: number;
}

export async function drainOwedNotices(
  now: Date = new Date(),
  {
    deliverers = OWED_NOTICE_DELIVERERS,
    sources = OWED_NOTICE_SOURCES,
  }: { deliverers?: readonly OwedNoticeDeliverer[]; sources?: readonly OwedNoticeSource[] } = {},
): Promise<OwedNoticeSweepResult> {
  const result: OwedNoticeSweepResult = { checked: 0, delivered: 0, cleared: 0, expired: 0 };
  for (const deliverer of deliverers) {
    const dueBefore = new Date(now.getTime() - deliverer.sweepAfterMs);
    for (const source of sources) {
      let refs;
      try {
        refs = await source.listDue(deliverer, { dueBefore, now });
      } catch (err) {
        logger.error({ err, kind: deliverer.kind, source: source.name, job: deliverer.job }, "Failed to read the owed notices");
        continue;
      }
      for (const ref of refs) {
        result.checked += 1;
        try {
          const outcome = await sweepOwedNotice(deliverer, ref, dueBefore, now);
          if (outcome === "delivered" || outcome === "cleared" || outcome === "expired") result[outcome] += 1;
        } catch (err) {
          logger.error({ err, key: ref.key, job: deliverer.job }, "Failed to deliver an owed notice; it stays owed");
        }
      }
    }
  }
  return result;
}
