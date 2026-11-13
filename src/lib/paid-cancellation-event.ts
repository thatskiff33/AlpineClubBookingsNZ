/**
 * The paid-path cancellation's CANCELLED event and the branch it describes
 * (#3639), split out of `booking-cancel.ts` so the claim transaction there calls
 * one writer and the rule stays in one place. Both are read only from that
 * claim; nothing here opens a transaction or talks to a provider.
 */
import {
  BookingEventType,
  ManualRefundTaskDirection,
  ManualRefundTaskKind,
  ManualRefundTaskStatus,
  type Prisma,
} from "@prisma/client";

/**
 * Which paid-path branch a cancellation takes — decided ONCE, inside the claim,
 * and read by the claim's ledger writes, its CANCELLED event and the
 * post-commit branch selection alike (#3639), so the event can never describe
 * a different branch from the one that moved the money.
 */
export type PaidCancellationBranch = "manual" | "credit" | "card" | "none";

export function paidCancellationBranch(params: {
  manualDisposition: boolean;
  refundMethod: "card" | "credit";
  refundAmountCents: number;
}): PaidCancellationBranch {
  if (params.refundAmountCents <= 0) return "none";
  if (params.manualDisposition) return "manual";
  return params.refundMethod === "credit" ? "credit" : "card";
}

/**
 * Write the durable CANCELLED BookingEvent (issue #740) for a PAID-path
 * cancellation. The policy snapshot + settled/retained amounts are frozen here
 * so the narrative can be rebuilt exactly later, even after the AuditLog has
 * been retention-pruned. Pre-payment cancellations carry no snapshot and do not
 * come here.
 *
 * INSIDE THE CLAIM TRANSACTION, since #3639 — not `recordBookingEvent` after
 * commit. The snapshot is the decision record `isCancellationRefundDecisionRecorded`
 * reads (`INV-PAY-106`), and on a 0%-tier cancel it is the ONLY one. Written
 * after commit, a Stripe notice landing in the gap, or arriving after a failed
 * write, found no decision and refunded money the cancel had kept.
 *
 * SO IT THROWS rather than swallowing, unlike `recordBookingEvent`. A failed
 * INSERT aborts the Postgres transaction anyway (the reason `recordBookingEvent`
 * says never to call it inside one), so a swallowed failure could not keep the
 * claim; throwing rolls the cancel back and the member retries, where the old
 * order committed a cancellation with no record of what it decided. The credit
 * branch's CREDITED event also commits with its credit (`INV-PAY-152`). Both
 * are documented exceptions to `recordBookingEvent`'s best-effort rule.
 *
 * The content is exactly what the four post-commit writes produced, one
 * sentence per branch. `occurredAt` defaults to the transaction's start, shared
 * with CREDITED. The narrative finds each by type, never by their relative order.
 */
/** #3611: what the ledger was told the club keeps, frozen with the decision. */
export type CancellationLedgerSnapshot = {
  /** The ledger's kept figure (design §5.1). */
  keptCents: number;
  /** What the policy alone keeps (review D1). */
  policyKeptCents: number;
  /** `keptCents - policyKeptCents`: money kept that no policy tier decided. */
  keptBeyondPolicyCents: number;
  appliedCreditCents: number;
  creditRestoredCents: number;
  /**
   * #3809: the applied credit the tier was applied to, capped at what the
   * booking was worth. A later review's netting (`INV-PAY-113`) re-runs the
   * tier on it. Absent on cancellations before the cap, which tiered it all.
   */
  appliedCreditBaseCents?: number;
};

export async function writePaidCancellationEvent(
  tx: Prisma.TransactionClient,
  params: {
    bookingId: string;
    actorMemberId: string;
    branch: PaidCancellationBranch;
    days: number;
    refundPercentage: number;
    refundAmountCents: number;
    paidAmountCents: number;
    changeFeeCents: number;
    /** From `paidCancellationMoney`, the one home of both kept figures (#3611). */
    retainedAmountCents: number;
    /**
     * What the booking ledger was told the club keeps, and the credit figures
     * it rests on, frozen with the decision so #3583's back-post replays them
     * rather than re-deriving them from a mirror that keeps moving (#3611).
     */
    ledger: CancellationLedgerSnapshot;
    /**
     * #3835: what the tier was actually computed with - the refund method
     * (`forcedCancelRefundMethod` included) and `paidCancellationMoney`'s
     * refundable base - so a financial review completed after this cancel
     * re-tiers exactly what was tiered, rather than guessing from the branch.
     */
    tier: { refundMethod: "card" | "credit"; refundableBaseCents: number };
    /** #4097 (`INV-PAY-129`): the card's part and the two parts its plan could not carry, for the narrative. */
    cardShortfall?: { cardCents: number; bankCents: number; checkCents: number };
  }
): Promise<void> {
  const { days, refundPercentage } = params;
  const terms = {
    manual: {
      policySummary: `Cancelled ${days} day(s) before check-in: ${refundPercentage}% refund under the policy in effect at the time, to be paid back by the club by hand (cash / off-Xero settlement).`,
      refundMethod: "manual",
    },
    credit: {
      policySummary: `Cancelled ${days} day(s) before check-in: ${refundPercentage}% credit refund under the policy in effect at the time.`,
      refundMethod: "credit",
    },
    card: {
      policySummary: `Cancelled ${days} day(s) before check-in: ${refundPercentage}% card refund under the policy in effect at the time.`,
      refundMethod: "card",
    },
    none: {
      policySummary: `Cancelled ${days} day(s) before check-in: no refund was due under the policy in effect at the time.`,
      refundMethod: "card",
    },
  }[params.branch];
  const settledAmountCents =
    params.branch === "none" ? 0 : params.refundAmountCents;
  // #3835: the review shares settled to the member BEFORE this cancel, read
  // under the claim's lock(1) - which every review completion holds too - so a
  // later review nets only against the shares settled after it, by id.
  const completedReviews = await tx.manualRefundTask.findMany({
    where: {
      bookingId: params.bookingId,
      kind: ManualRefundTaskKind.EDIT_FINANCIAL_REVIEW,
      status: ManualRefundTaskStatus.COMPLETED,
      settlementDirection: ManualRefundTaskDirection.REFUND_TO_MEMBER,
    },
    select: { id: true },
  });
  await tx.bookingEvent.create({
    data: {
      bookingId: params.bookingId,
      type: BookingEventType.CANCELLED,
      actorMemberId: params.actorMemberId,
      amountCents: params.paidAmountCents,
      reason: null,
      snapshot: {
        policySummary: terms.policySummary,
        refundMethod: terms.refundMethod,
        refundPercentage,
        paidAmountCents: params.paidAmountCents,
        settledAmountCents,
        retainedAmountCents: params.retainedAmountCents,
        changeFeeCents: params.changeFeeCents,
        ledger: params.ledger,
        tierRefundMethod: params.tier.refundMethod,
        refundableBaseCents: params.tier.refundableBaseCents,
        completedReviewTaskIds: completedReviews.map((task) => task.id),
        ...(params.cardShortfall ? { cardShortfall: params.cardShortfall } : {}),
      },
    },
  });
}
