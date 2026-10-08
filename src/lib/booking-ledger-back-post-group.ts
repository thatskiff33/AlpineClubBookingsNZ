import "server-only";

/**
 * THE BACK-POST'S GROUP-SETTLED CHILDREN (#3854 scope 3, on #3583 PR 2's
 * back-post; design `docs/design/booking-ledger.md` §5.2, §6; owner decision
 * 2A on #3583).
 *
 * A child its organiser settled before #3854 holds no `GROUP_SETTLEMENT` line:
 * no share, and, if the organiser cancelled, no plan refund and no kept figure.
 * The back-post (`booking-ledger-back-post.ts`) posts them here, in the
 * booking's own transaction, under its locks, beside the confirmation and
 * cancellation lines it posts for every booking. What it posts is planned by
 * `booking-ledger-group-child-plan.ts` — the SAME planner the census uses to
 * decide whether a child with no lines is `GROUP_SETTLEMENT_OFF_LEDGER` (#3854
 * F1) — through the live posters' planners and keys, so a later live event on
 * the child (the plan's recovery replay, a #3653 refund, a re-driven cancel)
 * finds its key posted and posts nothing twice. This module only reads what
 * the planner needs, through the booking's transaction.
 *
 * A #3653 refund posts from its own `PaymentRefund` row through the settlement
 * sync the back-post already runs. The census then judges the child; one it
 * still cannot explain is rolled back and listed `CANNOT POST`, and the census
 * holds the gate on it.
 */
import type { Prisma } from "@prisma/client";

import {
  groupChildHandBacksFromRows,
  needsPerChildCommittedRefund,
  planGroupChildLines,
  type GroupChildPlan,
} from "@/lib/booking-ledger-group-child-plan";
import type { BookingLedgerCensusRow } from "@/lib/booking-ledger-projection-census-row";
import { organiserChildCommittedRefundCents } from "@/lib/organiser-child-refund";

/**
 * The group lines history owes one child, or null where the child is not one a
 * group settlement paid (the back-post then treats it as any other booking).
 */
export async function planGroupChildBackPost(
  tx: Prisma.TransactionClient,
  args: { census: BookingLedgerCensusRow; lodgeId: string; cancelledWithoutSnapshot: boolean },
): Promise<GroupChildPlan | null> {
  const { booking, payment, groupSettlement } = args.census;
  if (!booking.organiserSettled || !groupSettlement || !payment) return null;
  const settlement = await tx.groupBookingSettlement.findUniqueOrThrow({
    where: { id: groupSettlement.id },
    select: { id: true, source: true, amountCents: true, stripePaymentIntentId: true, refundPlan: true, groupBooking: { select: { organiserBookingId: true } } },
  });
  // Every child this settlement could have paid, as the settle flipped them:
  // the organiser's settled children (the planner keeps those whose payment it captured).
  const siblings = await tx.booking.findMany({
    where: { parentBookingId: settlement.groupBooking.organiserBookingId, organiserSettled: true },
    orderBy: { id: "asc" },
    select: { id: true, lodgeId: true, payment: { select: { amountCents: true, status: true, source: true } } },
  });
  const child = { id: booking.id, lodgeId: args.lodgeId, status: booking.status, cancelledWithoutSnapshot: args.cancelledWithoutSnapshot };
  return planGroupChildLines({
    child,
    payment,
    settlement,
    siblings,
    perChildCommittedRefundCents:
      needsPerChildCommittedRefund(child, settlement) && settlement.stripePaymentIntentId
        ? await organiserChildCommittedRefundCents(tx, payment, settlement.stripePaymentIntentId)
        : null,
    handBacks: groupChildHandBacksFromRows(payment.id, args.census.tasks),
  });
}
