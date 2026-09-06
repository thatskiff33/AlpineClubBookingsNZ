import type { Prisma } from "@prisma/client";

import {
  bookingsWithTheirOwnStoryPending,
  type HostingCoverageReevaluationItem,
} from "@/lib/adult-member-hosting-coverage-queue";
import { loadHostingCoverageSplitSiblingIds } from "@/lib/adult-member-hosting-review";

/**
 * WHICH BOOKINGS A RE-EVALUATION ROW SPEAKS FOR (#3241, `INV-HOST-053`).
 *
 * One row reaches every same-owner booking on its nights, because §14 asks "is
 * this booking covered NOW" rather than "did this change uncover it". Only some
 * of those bookings are the row's to explain, and that distinction is what keeps
 * an officer's private reason — or "your owner was asked about this" — off a
 * booking nobody named. Split out of the drain, which was at its size budget and
 * had grown a second job.
 */

/**
 * The given bookings plus their #738 split halves, de-duplicated.
 *
 * One place rather than two arms of a conditional, so the two cannot disagree about
 * whether the half carrying the non-member guests is reconciled (`INV-SSOT-001`). A
 * split child has neither canonical group relation, so a Group Trip fan-out names its
 * PARENT and only its parent, leaving the half that carries the non-member guests as
 * the one half nobody re-evaluated; the unconditional `SAME_BOOKING` borrow relation
 * is how the child is reached. `loadHostingCoverageSplitSiblingIds` already excludes
 * ids in its input and caps itself, so this is a concatenation and never a widening,
 * and every id it adds costs one idempotent existential re-read.
 */
export async function expandWithSplitHalves(
  bookingIds: readonly string[],
  db: Prisma.TransactionClient,
): Promise<string[]> {
  if (bookingIds.length === 0) return [];
  return [
    ...bookingIds,
    ...(await loadHostingCoverageSplitSiblingIds(bookingIds, db)),
  ];
}

/**
 * The remit of one claimed row: the bookings it may explain, and the bookings it
 * must not open an incident for at all.
 *
 * `rowIsAbout` is the row's own booking, plus — FOR AN OFFICER OVERRIDE ONLY —
 * that booking's #738 split half, because a pair is one booking and §7's reason
 * lives nowhere but the incident. Never for a decline, whose acknowledged set is
 * exact and already holds a row each.
 *
 * `yieldTo` is the bookings that already have an unprocessed row of their own
 * carrying a story. A sweep that opened their incident first would force the row
 * that HAS the story to promote rather than open, moving an officer's mandatory
 * reason off the opening event — and both rows are written in one transaction,
 * so ordering cannot separate them.
 */
export async function resolveRowRemit(
  item: Pick<
    HostingCoverageReevaluationItem,
    "sourceBookingId" | "cause" | "reason"
  >,
  dependentIds: readonly string[],
  db: Prisma.TransactionClient,
): Promise<{ rowIsAbout: Set<string | null>; yieldTo: Set<string> }> {
  const officer = item.cause === "OFFICER_OVERRIDE";
  const rowIsAbout = new Set<string | null>(
    item.sourceBookingId && officer
      ? await expandWithSplitHalves([item.sourceBookingId], db)
      : [item.sourceBookingId],
  );
  const tellsAStory = item.cause !== "SYSTEM_CHANGE" || Boolean(item.reason);
  const yieldTo = tellsAStory
    ? await bookingsWithTheirOwnStoryPending(
        dependentIds.filter((id) => !rowIsAbout.has(id)),
        db,
      )
    : new Set<string>();
  return { rowIsAbout, yieldTo };
}
