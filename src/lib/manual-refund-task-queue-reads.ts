import "server-only";

import { Prisma } from "@prisma/client";

import logger from "@/lib/logger";
import { REOPENABLE_DISMISSAL_WINDOW_DAYS } from "@/lib/manual-refund-task-reopen";
import type { DismissedManualRefundTaskRow } from "@/lib/manual-refund-task-queue-payload";

/**
 * The finance settlement queue's SECONDARY reads, and the rule that neither of
 * them may take the actionable queue down with it.
 *
 * Split out of `GET /api/admin/payments/manual-refund-tasks` when #3498 pushed
 * that route past its line budget by adding a third list. The seam is a real one
 * rather than a line-count dodge: the route's own job is guard, permissions,
 * respond, and the OPEN queue it is built around propagates its failures like
 * any other query. These two are the reads that must DEGRADE instead — a list of
 * money the club owes members by hand must not disappear because an
 * informational card could not be read — and that rule, and the flag that keeps
 * it honest, belong together.
 */

/**
 * An informational list that degrades to "unavailable" rather than rejecting the
 * batch carrying the actionable queue beside it (#2750 review).
 *
 * Generic over the row so the empty fallback keeps the query's own type — a bare
 * `[]` in a `.catch` widens to `never[]` and makes the result unmappable — and
 * returning the flag beside the rows is what stops the caller forgetting it: an
 * empty list and a failed read look identical on screen, and on a refund notice
 * that difference is the entire point of the card.
 */
export function readOrDegrade<T>(
  query: Promise<T[]>,
  what: string,
): Promise<{ rows: T[]; unavailable: boolean }> {
  return query.then(
    (rows) => ({ rows, unavailable: false }),
    (err: unknown) => {
      logger.error(
        { err },
        `Failed to read the ${what} for the finance queue; the hand-back queue is answered without them`,
      );
      return { rows: [], unavailable: true };
    },
  );
}

/**
 * #3498 (owner decision D2): the recently dismissed money tasks an officer could
 * put back on the queue.
 *
 * TWO BOUNDS, and each is doing a different job.
 *
 * The WINDOW bounds this card, for the reason the automatic-refund card beside
 * it has one: a card exists to be read, and an unbounded list of settled rows is
 * what makes an operator stop reading it. It is emphatically not a rule about
 * when a mistake stops being worth correcting — `reopenManualRefundTask` refuses
 * on status and on who closed the row, never on age.
 *
 * `completedByMemberId: { not: null }` is the SAFETY bound, and it is applied
 * here rather than on the card. A machine-written dismissal is not a decision:
 * `automaticallyRefundedManualRefundTaskFilter` finds rows the Stripe webhook
 * closed BECAUSE IT HAD ALREADY REFUNDED the capture, and offering one a
 * **Put back on the queue** button would invite a second refund of money that
 * has already gone back. The reopen door refuses those too; a list that never
 * offers them is the courtesy, not the control.
 */
export function readDismissedManualRefundTasks(
  store: Pick<Prisma.TransactionClient, "manualRefundTask">,
  now: Date,
): Promise<DismissedManualRefundTaskRow[]> {
  return store.manualRefundTask.findMany({
    where: {
      status: "DISMISSED",
      completedByMemberId: { not: null },
      completedAt: {
        gte: new Date(
          now.getTime() - REOPENABLE_DISMISSAL_WINDOW_DAYS * 24 * 60 * 60 * 1000,
        ),
      },
    },
    orderBy: { completedAt: "desc" },
    take: 100,
    select: {
      id: true,
      bookingId: true,
      amountCents: true,
      kind: true,
      reason: true,
      note: true,
      completedAt: true,
      booking: {
        select: {
          checkIn: true,
          checkOut: true,
          member: { select: { firstName: true, lastName: true } },
          organisation: { select: { name: true, email: true } },
          deletedAt: true,
        },
      },
    },
  });
}
