/**
 * #3653: the read-only audit of organiser-settled children whose refunded
 * mirror is not backed by a refund Stripe made. Run it with
 * `pnpm run payments:audit-organiser-child-refunds`; it repairs nothing.
 */
import { BookingStatus, PaymentSource, type Prisma } from "@prisma/client";

import { deserializeRefundPlan } from "@/lib/organiser-child-refund";
import { EXCLUDED_LEDGER_REFUND_STATUSES } from "@/lib/payment-transaction-status";
import { prisma } from "@/lib/prisma";

type Db = Prisma.TransactionClient;

export type OrganiserChildRefundMirrorFinding = {
  bookingId: string;
  paymentId: string;
  groupBookingId: string;
  bookingStatus: BookingStatus;
  mirrorCents: number;
  providerRefundCents: number;
  legacyCancelPlanCents: number;
  accountCreditCents: number;
  unexplainedCents: number;
  classification: "legacy-group-cancel" | "joiner-account-credit" | "unbacked";
};

/**
 * READ-ONLY: every organiser-settled child whose refunded mirror is not fully
 * backed by refunds Stripe made out of the combined payment (#3653). Three
 * explanations are told apart, because only one is a fault:
 *
 * - `legacy-group-cancel`: a group cancelled before #3653 refunded the whole
 *   group in ONE Stripe refund and wrote each child's share from its frozen
 *   plan. Legitimate; no per-child refund id ever existed and none is invented.
 * - `joiner-account-credit`: an edit before #3653 gave the joiner account credit
 *   for a reduction of a booking the organiser paid for. The value moved, to the
 *   wrong person; an officer decides.
 * - `unbacked`: nothing explains it - a mirror claiming cash went back that no
 *   provider refund shows. Never repaired automatically: only Stripe evidence
 *   may raise or settle a cash mirror.
 */
export async function findUnbackedOrganiserChildRefundMirrors(
  db: Db = prisma,
): Promise<OrganiserChildRefundMirrorFinding[]> {
  const payments = await db.payment.findMany({
    where: { refundedAmountCents: { gt: 0 }, source: PaymentSource.STRIPE, booking: { organiserSettled: true } },
    select: {
      id: true,
      refundedAmountCents: true,
      booking: { select: { id: true, status: true, parentBookingId: true } },
    },
    orderBy: { id: "asc" },
  });
  const findings: OrganiserChildRefundMirrorFinding[] = [];
  for (const payment of payments) {
    const parentBookingId = payment.booking.parentBookingId;
    if (!parentBookingId) continue;
    const group = await db.groupBooking.findUnique({
      where: { organiserBookingId: parentBookingId },
      select: { id: true, settlement: { select: { refundPlan: true, stripePaymentIntentId: true } } },
    });
    if (!group) continue;
    const [refunds, credits] = await Promise.all([
      db.paymentRefund.aggregate({
        where: { paymentId: payment.id, status: { notIn: EXCLUDED_LEDGER_REFUND_STATUSES } },
        _sum: { amountCents: true },
      }),
      db.memberCredit.aggregate({
        where: { sourceBookingId: payment.booking.id, amountCents: { gt: 0 }, restoredFromBookingId: null },
        _sum: { amountCents: true },
      }),
    ]);
    // A #3653 per-child plan reads as an empty legacy plan, by its shape.
    const legacyCents = deserializeRefundPlan(group.settlement?.refundPlan).get(payment.booking.id) ?? 0;
    const providerRefundCents = refunds._sum.amountCents ?? 0;
    const accountCreditCents = Math.max(0, credits._sum.amountCents ?? 0);
    let remaining = payment.refundedAmountCents - providerRefundCents;
    if (remaining <= 0) continue;
    const legacyCancelPlanCents =
      payment.booking.status === BookingStatus.CANCELLED ? Math.min(remaining, legacyCents) : 0;
    remaining -= legacyCancelPlanCents;
    const creditCents = Math.min(remaining, accountCreditCents);
    remaining -= creditCents;
    findings.push({
      bookingId: payment.booking.id,
      paymentId: payment.id,
      groupBookingId: group.id,
      bookingStatus: payment.booking.status,
      mirrorCents: payment.refundedAmountCents,
      providerRefundCents,
      legacyCancelPlanCents,
      accountCreditCents: creditCents,
      unexplainedCents: remaining,
      classification:
        remaining > 0 ? "unbacked" : creditCents > 0 ? "joiner-account-credit" : "legacy-group-cancel",
    });
  }
  return findings;
}
