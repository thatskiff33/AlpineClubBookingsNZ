import "server-only";

import { ManualRefundTaskKind, Prisma } from "@prisma/client";

import logger from "@/lib/logger";
import {
  REOPENABLE_DISMISSAL_LIST_MAX,
  REOPENABLE_DISMISSAL_WINDOW_DAYS,
} from "@/lib/manual-refund-task-reopen-bounds";
import type { DismissedManualRefundTaskRow } from "@/lib/manual-refund-task-queue-payload";
import { readPaymentHandBackTasks, type HandBackDisputeContext } from "@/lib/manual-refund-task-hand-back-journal";
import { readDisputesByBookingId } from "@/lib/stripe-dispute-hold";

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
 * Every money task EXCEPT a retired officer edit review (#4343, #4344).
 *
 * The finance queue lists none of them, open or dismissed: the kind is
 * retired, nothing raises one any more, and the resolve and reopen doors
 * refuse it. Applied in the query, before each list's `take`, so a leftover row
 * can never push work the club still owes past the limit.
 *
 * THE `kind: null` ARM IS LOAD-BEARING. `kind` is nullable - every row written
 * before #3030 added the column has none, and the card reads that as the
 * hand-back it has always been - and a bare `kind: { not: ... }` compiles to
 * `kind <> ...` in SQL, which is never true of a NULL. Without the arm, every
 * legacy hand-back would silently drop off the queue.
 */
export const NOT_RETIRED_REVIEW_WHERE = {
  OR: [
    { kind: null },
    { kind: { not: ManualRefundTaskKind.EDIT_FINANCIAL_REVIEW } },
  ],
} satisfies Prisma.ManualRefundTaskWhereInput;

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
 * #4516 (owner decisions, 15 and 18 Nov 2026): the card disputes on the open tasks'
 * bookings, keyed by booking, through #5061's one read (`readDisputesByBookingId`),
 * with every task on those disputes' payments for the once-only allocation of lost
 * cents (`disputeLossAvailableToTask`), for the dismissal rule the server asks too
 * (`journalHandBackDismissal`). It degrades like the cards beside it, and failing
 * closed: with either read missing, a disputed card payment's hand-back offers no
 * Dismiss or Reduce, and the server, which re-reads both under its locks, decides.
 */
export async function readOpenTaskDisputes(
  db: Parameters<typeof readDisputesByBookingId>[0] & Parameters<typeof readPaymentHandBackTasks>[0],
  tasks: readonly { bookingId: string }[],
): Promise<Map<string, HandBackDisputeContext>> {
  const read = await readOrDegrade(
    readDisputesByBookingId(db, tasks.map((task) => task.bookingId)).then((byBooking) => [...byBooking]),
    "card disputes on the open tasks' bookings",
  );
  const paymentIds = [...new Set(read.rows.flatMap(([, disputes]) => disputes.flatMap((dispute) => dispute.paymentId ?? [])))];
  const paymentTasks = await readOrDegrade(readPaymentHandBackTasks(db, paymentIds), "tasks on the disputed payments");
  if (paymentTasks.unavailable) return new Map();
  return new Map(read.rows.map(([bookingId, disputes]) => {
    const payments = new Set(disputes.flatMap((dispute) => dispute.paymentId ?? []));
    return [bookingId, { disputes, paymentTasks: paymentTasks.rows.filter((task) => task.paymentId !== null && payments.has(task.paymentId)) }];
  }));
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
 *
 * An `EDIT_FINANCIAL_REVIEW` is excluded for a different reason (#4343): that
 * kind is retired, and the queue must not offer to put one back. The reopen
 * door refuses it as well; this query is what keeps the button off the card.
 * {@link NOT_RETIRED_REVIEW_WHERE} says why it is spelled with a `kind: null`
 * arm.
 */
export function readDismissedManualRefundTasks(
  store: Pick<Prisma.TransactionClient, "manualRefundTask">,
  now: Date,
): Promise<DismissedManualRefundTaskRow[]> {
  return store.manualRefundTask.findMany({
    where: {
      status: "DISMISSED",
      ...NOT_RETIRED_REVIEW_WHERE,
      completedByMemberId: { not: null },
      completedAt: {
        gte: new Date(
          now.getTime() - REOPENABLE_DISMISSAL_WINDOW_DAYS * 24 * 60 * 60 * 1000,
        ),
      },
    },
    orderBy: { completedAt: "desc" },
    // The card PUBLISHES this figure, so it is shared rather than a literal
    // here and a sentence there (`INV-SSOT`).
    take: REOPENABLE_DISMISSAL_LIST_MAX,
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
