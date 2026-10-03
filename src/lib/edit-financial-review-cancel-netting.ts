import "server-only";

import {
  BookingEventType,
  CreditType,
  ManualRefundTaskDirection,
  ManualRefundTaskKind,
  ManualRefundTaskStatus,
  PaymentRecoveryOperationStatus,
  type Prisma,
} from "@prisma/client";

import { daysUntilDate, loadCancellationPolicy, type CancellationRule } from "@/lib/cancellation";
import { parseEditFinancialReviewContext } from "@/lib/edit-financial-review-context";
import { deriveBookingAppliedCreditCents } from "@/lib/member-credit";
import { paidCancellationMoney } from "@/lib/paid-cancellation-money";
import { clubCalendarDateOf, type ClubTimeZone } from "@/lib/club-time";
import { REVIEW_CANCELLATION_REFUND_UNREPRODUCIBLE_MESSAGE } from "@/lib/edit-financial-review-refund-refusals";
import { ManualBookingPaymentError } from "@/lib/payment-reconciliation";
import {
  buildBookingCancellationRefundIdempotencyKey,
  buildEditFinancialReviewRefundRecoveryIdempotencyKey,
} from "@/lib/payment-recovery-keys";

/**
 * OWNER DECISION 2 ON #3791, AS ONE FORMULA (#3791, #3835): a review completed
 * after the booking was cancelled gives back only what is still owed.
 *
 * Had every share settled since the cancellation (`sharesCents`, this one
 * included) come back first, the cancellation would have tiered what was left
 * and the member would hold `C + returnOf(base - C)`. They hold what the
 * cancellation returned and what earlier reviews since returned; the
 * difference, floored at zero, is owed now. A share comes off the card base
 * first, as a review completed first would have refunded it, and then off the
 * applied credit. `returnOf` is the cancellation's own tier
 * (`cancellationReturnOf`); the credit-only route (#3791) is the case with no
 * card base.
 */
export function shareOwedAfterCancellationCents({
  sharesCents,
  cardBaseCents,
  appliedCents,
  returnedByCancellationCents,
  returnedSinceCents,
  returnOf,
}: {
  sharesCents: number;
  cardBaseCents: number;
  appliedCents: number;
  returnedByCancellationCents: number;
  returnedSinceCents: number;
  returnOf: (cardBaseCents: number, appliedCents: number) => number;
}): number {
  const cardSliceCents = Math.max(0, Math.min(sharesCents, cardBaseCents));
  const creditSliceCents = Math.max(0, Math.min(appliedCents, sharesCents - cardSliceCents));
  const owedCents =
    sharesCents +
    returnOf(cardBaseCents - cardSliceCents, appliedCents - creditSliceCents) -
    returnedByCancellationCents -
    returnedSinceCents;
  return Math.max(0, owedCents);
}

/**
 * What a paid cancellation returns of a capture base and an applied-credit
 * slice, by `paidCancellationMoney` itself - the cancel path's one call - on a
 * payment of exactly that base: the refund (`card`) and the restore (`credit`),
 * the fee once and card-first. The credit-only route (#3791) is the case with
 * no capture base.
 */
export function cancellationTierOf(
  days: number,
  policy: CancellationRule[],
  refundMethod: "card" | "credit",
): (baseCents: number, appliedCents: number) => { captureCents: number; creditCents: number } {
  return (baseCents, appliedCents) => {
    const money = paidCancellationMoney({
      payment: { amountCents: baseCents, refundedAmountCents: 0, changeFeeCents: 0, creditAppliedCents: appliedCents },
      finalPriceCents: baseCents,
      appliedCreditCents: appliedCents,
      restoresToMemberLedger: true,
      days,
      policy,
      refundMethod,
    });
    return { captureCents: money.refundAmountCents, creditCents: money.creditRestoredCents };
  };
}

/** `cancellationTierOf` as one figure, for `shareOwedAfterCancellationCents`. */
export function cancellationReturnOf(
  days: number,
  policy: CancellationRule[],
  refundMethod: "card" | "credit",
): (cardBaseCents: number, appliedCents: number) => number {
  const tierOf = cancellationTierOf(days, policy, refundMethod);
  return (cardBaseCents, appliedCents) => {
    const tier = tierOf(cardBaseCents, appliedCents);
    return tier.captureCents + tier.creditCents;
  };
}

export function jsonRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** An integer figure in a frozen snapshot, or null where it is missing. */
export function frozenCents(record: Record<string, unknown> | null, key: string): number | null {
  const value = record?.[key];
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

/**
 * The applied credit a cancellation TIERED: #3809's `appliedCreditBaseCents`
 * (capped at the price, applied only where its give-back ran) where the
 * CANCELLED event carries it, else the ledger's applied credit as frozen.
 */
export function frozenAppliedCreditBaseCents(snapshot: Record<string, unknown> | null): number | null {
  return frozenCents(snapshot, "appliedCreditBaseCents") ?? frozenCents(jsonRecord(snapshot?.ledger), "appliedCreditCents");
}

/** What a captured payment's share still owes, and which way each part goes back. */
export type CapturedShareOwed = {
  /** To the capture: the card, or a bank transfer. */
  captureCents: number;
  /** As account credit: the member's applied credit given back. */
  creditCents: number;
};

/**
 * #3835: owner decision 2 on #3791 on a CAPTURED payment's share - the Stripe
 * refund route, the hand-back route (internet banking, whose cancellation
 * returned account credit) and the account-credit route that mints against the
 * payment. The total still owed is `shareOwedAfterCancellationCents`,
 * cumulatively across the reviews settled after the cancel; never more than the
 * share typed.
 *
 * IT GOES BACK THE WAY IT CAME IN. Had the shares come back first they would
 * have come off the capture base first and then the applied credit, and the
 * cancellation would have tiered each remainder. So the capture part is what
 * that would have returned to the capture less what the capture has had back
 * (the cancellation's refund, earlier reviews' refunds, hand-backs and minted
 * credit), held to the total; the rest is applied credit given back. The
 * capture is never asked for the credit's part.
 *
 * Every figure is the cancellation's own, frozen on its CANCELLED event
 * (`writePaidCancellationEvent`): the refund and its method, the refundable
 * base, the applied credit tiered and restored, and the reviews already
 * settled when it ran. Events older than #3835 fall back to the paid money
 * less the change fee and the branch's method. The tier is re-run on the
 * cancellation's day by `cancellationTierOf` and must reproduce the refund and
 * the restore before it is trusted; where it does not, or nothing was frozen,
 * the completion is refused with the task OPEN. A cancellation that returned
 * nothing is not re-tiered; one that returned everything owes nothing.
 *
 * Reads under the completion's `lock(1)`, which the cancel and every sibling
 * review hold too; on a cancelled booking only reviews write applied rows.
 */
export async function capturedShareOwedAfterCancellation({
  bookingId,
  taskId,
  booking,
  shareCents,
  clubZone,
  store,
}: {
  bookingId: string;
  taskId: string;
  booking: { checkIn: Date; lodgeId: string };
  shareCents: number;
  clubZone: ClubTimeZone;
  store: Prisma.TransactionClient;
}): Promise<CapturedShareOwed> {
  const refuse = () => new ManualBookingPaymentError(REVIEW_CANCELLATION_REFUND_UNREPRODUCIBLE_MESSAGE, 409);
  const cancelled = await store.bookingEvent.findFirst({
    where: { bookingId, type: BookingEventType.CANCELLED },
    orderBy: { occurredAt: "desc" },
    select: { snapshot: true, occurredAt: true },
  });
  const snapshot = jsonRecord(cancelled?.snapshot);
  const ledger = jsonRecord(snapshot?.ledger);
  const paidCents = frozenCents(snapshot, "paidAmountCents");
  const changeFeeCents = frozenCents(snapshot, "changeFeeCents");
  const refundedCents = frozenCents(snapshot, "settledAmountCents");
  const appliedRowsCents = frozenCents(ledger, "appliedCreditCents");
  const appliedCents = frozenAppliedCreditBaseCents(snapshot);
  const restoredCents = frozenCents(ledger, "creditRestoredCents");
  if (
    !cancelled || paidCents === null || changeFeeCents === null || refundedCents === null ||
    appliedRowsCents === null || appliedCents === null || restoredCents === null
  ) {
    throw refuse();
  }
  const baseCents = frozenCents(snapshot, "refundableBaseCents") ?? Math.max(0, paidCents - changeFeeCents);
  const refundMethod = (snapshot?.tierRefundMethod ?? snapshot?.refundMethod) === "credit" ? "credit" : "card";

  const since = await settledSinceCancellation({ bookingId, taskId, snapshot, since: cancelled.occurredAt, store });
  // The restore leaves the applied rows alone, so what reviews have given back
  // since is exactly how far the rows have fallen from the frozen figure.
  const creditBackSinceCents = Math.max(0, appliedRowsCents - (await deriveBookingAppliedCreditCents(bookingId, store)));
  const sharesCents = since.sharesCents + shareCents;
  const captureSliceCents = Math.max(0, Math.min(sharesCents, baseCents));
  const creditSliceCents = Math.max(0, Math.min(appliedCents, sharesCents - captureSliceCents));

  // Nothing returned: the tier kept everything, and of less too.
  let tierOf: ReturnType<typeof cancellationTierOf> = () => ({ captureCents: 0, creditCents: 0 });
  let returnOf: ReturnType<typeof cancellationReturnOf> = () => 0;
  if (refundedCents + restoredCents >= baseCents + appliedCents) return { captureCents: 0, creditCents: 0 };
  if (refundedCents + restoredCents > 0) {
    const days = daysUntilDate(booking.checkIn, clubCalendarDateOf(cancelled.occurredAt, clubZone));
    const policy = await loadCancellationPolicy(booking.checkIn, booking.lodgeId, store);
    tierOf = cancellationTierOf(days, policy, refundMethod);
    returnOf = cancellationReturnOf(days, policy, refundMethod);
    const reproduced = tierOf(baseCents, appliedCents);
    if (reproduced.captureCents !== refundedCents || reproduced.creditCents !== restoredCents) throw refuse();
  }
  const totalCents = Math.min(
    shareCents,
    shareOwedAfterCancellationCents({
      sharesCents,
      cardBaseCents: baseCents,
      appliedCents,
      returnedByCancellationCents: refundedCents + restoredCents,
      returnedSinceCents: since.captureReturnedCents + creditBackSinceCents,
      returnOf,
    }),
  );
  const leftTier = tierOf(baseCents - captureSliceCents, appliedCents - creditSliceCents);
  const captureOwedCents = captureSliceCents + leftTier.captureCents - refundedCents - since.captureReturnedCents;
  const captureCents = Math.max(0, Math.min(totalCents, captureOwedCents));
  return { captureCents, creditCents: totalCents - captureCents };
}

/**
 * The other reviews of this booking settled to the member AFTER the
 * cancellation: the shares they were typed at, and what they returned to the
 * capture - a card refund's frozen debt (its recovery operation), a
 * hand-back's `BANK_REFUND` line, or credit minted against the payment on
 * their anchor. Settled after it means not among the ids the CANCELLED event
 * froze (#3835); an older event without them falls back to completion time.
 */
async function settledSinceCancellation({
  bookingId,
  taskId,
  snapshot,
  since,
  store,
}: {
  bookingId: string;
  taskId: string;
  snapshot: Record<string, unknown> | null;
  since: Date;
  store: Prisma.TransactionClient;
}): Promise<{ sharesCents: number; captureReturnedCents: number }> {
  const frozenIds = snapshot?.completedReviewTaskIds;
  const priorIds = Array.isArray(frozenIds) ? frozenIds.filter((id): id is string => typeof id === "string") : null;
  const siblings = await store.manualRefundTask.findMany({
    where: {
      bookingId,
      id: { notIn: [taskId, ...(priorIds ?? [])] },
      kind: ManualRefundTaskKind.EDIT_FINANCIAL_REVIEW,
      status: ManualRefundTaskStatus.COMPLETED,
      settlementDirection: ManualRefundTaskDirection.REFUND_TO_MEMBER,
      ...(priorIds === null ? { completedAt: { gte: since } } : {}),
    },
    select: { id: true, amountCents: true, reviewContext: true },
  });
  if (siblings.length === 0) return { sharesCents: 0, captureReturnedCents: 0 };
  const ids = siblings.map((task) => task.id);
  const refunded = await store.paymentRecoveryOperation.aggregate({
    where: { idempotencyKey: { in: ids.map((id) => buildEditFinancialReviewRefundRecoveryIdempotencyKey(id)) } },
    _sum: { amountCents: true },
  });
  const handedBack = await store.bookingLedgerLine.aggregate({
    where: { bookingId, kind: "BANK_REFUND", anchorKind: "REVIEW_TASK", anchorId: { in: ids }, reversesLineId: null },
    _sum: { unitCents: true },
  });
  const anchors = siblings
    .map((task) => parseEditFinancialReviewContext(task.reviewContext)?.bookingModificationId ?? null)
    .filter((anchor): anchor is string => anchor !== null);
  const minted = anchors.length === 0 ? null : await store.memberCredit.aggregate({
    where: { sourceBookingModificationId: { in: anchors }, type: CreditType.BOOKING_MODIFICATION_REFUND },
    _sum: { amountCents: true },
  });
  return {
    sharesCents: siblings.reduce((sum, task) => sum + (task.amountCents ?? 0), 0),
    captureReturnedCents: (refunded._sum.amountCents ?? 0) + (handedBack._sum.unitCents ?? 0) + (minted?._sum.amountCents ?? 0),
  };
}

/**
 * #3835: card refunds already promised out of this payment and not yet made -
 * the cancellation's and earlier reviews' frozen Stripe debts that have not
 * SUCCEEDED. The card route caps against the capture less these, so no mix of
 * pending refunds can promise more than was captured. A debt partly made
 * counts whole: the cap errs towards refusing, with the task OPEN.
 */
export async function unfinishedCardRefundDebtsCents(
  { paymentId, bookingId }: { paymentId: string; bookingId: string },
  store: Prisma.TransactionClient,
): Promise<number> {
  const debts = await store.paymentRecoveryOperation.aggregate({
    where: {
      paymentId,
      status: { not: PaymentRecoveryOperationStatus.SUCCEEDED },
      OR: [
        { idempotencyKey: buildBookingCancellationRefundIdempotencyKey(bookingId) },
        { idempotencyKey: { startsWith: buildEditFinancialReviewRefundRecoveryIdempotencyKey("") } },
      ],
    },
    _sum: { amountCents: true },
  });
  return debts._sum.amountCents ?? 0;
}
