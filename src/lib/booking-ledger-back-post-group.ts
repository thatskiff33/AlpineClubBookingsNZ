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
 * cancellation lines it posts for every booking — through the SAME planners
 * and keys the live posters use (`booking-ledger-group-settlement-posting.ts`,
 * `groupSettlementShareKey` / `groupSettlementRefundKey`), so a later live event
 * on the child (the plan's recovery replay, a #3653 refund, a re-driven cancel)
 * finds its key posted and posts nothing twice:
 *
 *   share   `planGroupSettlementShareLines` over every child the settlement paid
 *           (its captured payment, of the settlement's source), each at its
 *           payment's `amountCents` — the figure the census checks the share by.
 *           Sum or nothing, as live: payments that do not add up to what the
 *           settlement collected post nothing, and the child is refused
 *           (`GROUP_SHARES_DO_NOT_RECONCILE`), never guessed.
 *   refund  `planGroupSettlementRefundLine` for a mirror plan's frozen share, only
 *           once the mirror is written (`refundedAmountCents > 0`, the replay's
 *           own test), as live posts it beside the mirror; an unmirrored plan
 *           is the replay's to post, under the same key.
 *   kept    an organiser cancel froze no CANCELLED snapshot, so the kept figure
 *           is `groupSettledChildKeptCents`, the live cancel's own, with the
 *           payment as it stood at the cancel: a written mirror came from zero
 *           (only the plan refunds a settled child's mirror, the replay's rule).
 *
 * A #3653 refund posts from its own `PaymentRefund` row through the settlement
 * sync the back-post already runs. The census then judges the child; one it
 * still cannot explain is rolled back and stays `GROUP_SETTLEMENT_OFF_LEDGER`.
 */
import type { Prisma } from "@prisma/client";

import type { BackPostRefusal } from "@/lib/booking-ledger-back-post-report";
import { planGroupSettlementRefundLine, planGroupSettlementShareLines } from "@/lib/booking-ledger-group-settlement-posting";
import { groupSettledChildKeptCents } from "@/lib/booking-ledger-group-settlement-sync";
import type { BookingLedgerCensusRow } from "@/lib/booking-ledger-projection-census-row";
import type { BookingLedgerPosting } from "@/lib/booking-ledger-write";
import { isCapturedPaymentStatus } from "@/lib/booking-payment-state";
import { deserializeRefundPlan, isMirrorRefundPlan } from "@/lib/group-settlement-refund-plan";

export type GroupChildBackPost =
  | {
      kind: "plan";
      /** The share and any plan refund, posted after the child's confirmation. */
      postings: BookingLedgerPosting[];
      steps: string[];
      /** The organiser cancel's kept figure; null where the generic CANCELLED-snapshot reading applies. */
      cancellationKeptCents: number | null;
    }
  | { kind: "refuse"; reason: BackPostRefusal; detail: string };

/**
 * The group lines history owes one child, or null where the child is not one a
 * group settlement paid (the back-post then treats it as any other booking).
 * Reads the settlement and its children through the booking's transaction.
 */
export async function planGroupChildBackPost(
  tx: Prisma.TransactionClient,
  args: { census: BookingLedgerCensusRow; lodgeId: string; cancelledWithoutSnapshot: boolean },
): Promise<GroupChildBackPost | null> {
  const { booking, payment, groupSettlement } = args.census;
  if (!booking.organiserSettled || !groupSettlement || !payment) return null;
  if (!isCapturedPaymentStatus(payment.status) || payment.source !== groupSettlement.source) return null;
  const settlement = await tx.groupBookingSettlement.findUniqueOrThrow({
    where: { id: groupSettlement.id },
    select: { id: true, source: true, amountCents: true, stripePaymentIntentId: true, refundPlan: true, groupBooking: { select: { organiserBookingId: true } } },
  });
  // Every child this settlement paid, as the settle flipped them: the
  // organiser's settled children whose payment it captured.
  const children = await tx.booking.findMany({
    where: { parentBookingId: settlement.groupBooking.organiserBookingId, organiserSettled: true },
    orderBy: { id: "asc" },
    select: { id: true, lodgeId: true, payment: { select: { amountCents: true, status: true, source: true } } },
  });
  const paid = children.flatMap((child) =>
    child.payment && isCapturedPaymentStatus(child.payment.status) && child.payment.source === settlement.source
      ? [{ bookingId: child.id, lodgeId: child.lodgeId, shareCents: child.payment.amountCents }]
      : [],
  );
  const shares = planGroupSettlementShareLines({ settlement, children: paid });
  if (!shares.reconciles) {
    return {
      kind: "refuse",
      reason: "GROUP_SHARES_DO_NOT_RECONCILE",
      detail: `settlement ${settlement.id} collected ${settlement.amountCents}; the ${paid.length} child payment(s) it paid come to ${shares.totalShareCents}`,
    };
  }
  const postings = shares.postings.filter((posting) => posting.bookingId === booking.id);
  const steps = postings.map((posting) => `group share (${posting.unitCents})`);

  const mirror = isMirrorRefundPlan(settlement);
  const plannedRefundCents = mirror ? (deserializeRefundPlan(settlement.refundPlan).get(booking.id) ?? 0) : 0;
  const mirrored = payment.refundedAmountCents > 0;
  if (mirror && mirrored) {
    const refund = planGroupSettlementRefundLine({ settlement, bookingId: booking.id, lodgeId: args.lodgeId, refundCents: plannedRefundCents });
    if (refund) {
      postings.push(refund);
      steps.push(`group plan refund (${refund.unitCents})`);
    }
  }

  let cancellationKeptCents: number | null = null;
  if (booking.status === "CANCELLED" && args.cancelledWithoutSnapshot) {
    cancellationKeptCents = await groupSettledChildKeptCents(
      tx,
      // The payment as the organiser cancel saw it: a mirror it (or its replay) wrote started at zero.
      { id: payment.id, amountCents: payment.amountCents, refundedAmountCents: mirror && mirrored ? 0 : payment.refundedAmountCents },
      mirror || !settlement.stripePaymentIntentId
        ? { kind: "mirror", plannedRefundCents }
        : { kind: "per-child", paymentIntentId: settlement.stripePaymentIntentId },
    );
  }
  return { kind: "plan", postings, steps, cancellationKeptCents };
}
