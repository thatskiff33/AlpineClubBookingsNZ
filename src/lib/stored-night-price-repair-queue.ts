import "server-only";

import type { ManualRefundTaskKind, Prisma } from "@prisma/client";

import logger from "@/lib/logger";
import {
  GUEST_SELECT,
  reviewTaskGuestId,
  unpricedNightsSummaryForGuest,
} from "@/lib/stored-night-price-repair-store";
import type { UnpricedNightsSummary } from "@/lib/stored-night-price-repair";

/**
 * #3191 (epic #2797): reading the unpriced-night summaries for a WHOLE FINANCE
 * QUEUE PAGE, as opposed to for the one strand a settle is about.
 *
 * Split out of `stored-night-price-repair-store.ts` when #3219 pushed that file
 * past its size budget, and along the seam that module's own docblock already
 * draws rather than at an arbitrary line count. The store is the SETTLE PATH:
 * what one officer may write to one strand and to the booking behind it, with
 * every refusal and every fence that decision needs. These two functions render
 * a LIST - they write nothing, they refuse nothing, they take no claim, and the
 * second of them deliberately degrades rather than failing. Different job,
 * different reason to change.
 *
 * They still read through the store's own `GUEST_SELECT` and
 * `unpricedNightsSummaryForGuest`, so there is exactly one definition of what a
 * repairable strand looks like (`INV-SSOT-001`); this file holds no rule of its
 * own.
 */

/**
 * The summaries for a whole queue load, keyed by TASK id.
 *
 * Keyed by task rather than by guest so the queue payload never has to hold a
 * guest-strand id in order to look one up - the redaction
 * `toEditFinancialReviewEvidence` performs would be worth nothing if the field
 * came back on a neighbouring map. One query for every strand on the page rather
 * than one per row.
 */
export async function unpricedNightsSummariesByTaskId({
  tasks,
  store,
}: {
  tasks: ReadonlyArray<{
    id: string;
    kind: ManualRefundTaskKind | string | null;
    reviewContext: unknown;
  }>;
  store: Prisma.TransactionClient;
}): Promise<Map<string, UnpricedNightsSummary>> {
  const guestIdByTaskId = new Map<string, string>();
  for (const task of tasks) {
    const guestId = reviewTaskGuestId(task);
    if (guestId !== null) guestIdByTaskId.set(task.id, guestId);
  }
  const summaries = new Map<string, UnpricedNightsSummary>();
  if (guestIdByTaskId.size === 0) return summaries;

  const guests = await store.bookingGuest.findMany({
    where: { id: { in: [...new Set(guestIdByTaskId.values())] } },
    select: GUEST_SELECT,
  });
  const byGuestId = new Map(guests.map((guest) => [guest.id, guest]));
  for (const [taskId, guestId] of guestIdByTaskId) {
    const guest = byGuestId.get(guestId);
    if (!guest) continue;
    const summary = unpricedNightsSummaryForGuest(guest);
    if (summary) summaries.set(taskId, summary);
  }
  return summaries;
}

/**
 * The same summaries for a screen that must render whether or not they can be
 * read.
 *
 * FAIL-CLOSED AND ON ITS OWN. An empty map means no row offers the repair, which
 * is exactly what the finance queue did before #3191 - the money work on that
 * card is unaffected by a repair it cannot offer this minute, and blanking the
 * queue over a secondary read would take a list of money the club owes members
 * off the screen. The strict function above stays available for a caller that
 * must not silently degrade.
 */
export async function unpricedNightsSummariesForQueue(args: {
  tasks: ReadonlyArray<{
    id: string;
    kind: ManualRefundTaskKind | string | null;
    reviewContext: unknown;
  }>;
  store: Prisma.TransactionClient;
}): Promise<Map<string, UnpricedNightsSummary>> {
  try {
    return await unpricedNightsSummariesByTaskId(args);
  } catch (err) {
    logger.error(
      { err },
      "Failed to read unpriced night summaries for the finance queue; its rows are answered without them",
    );
    return new Map<string, UnpricedNightsSummary>();
  }
}
