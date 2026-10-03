import "server-only";

import {
  BookingEventType,
  CreditType,
  ManualRefundTaskDirection,
  ManualRefundTaskKind,
  ManualRefundTaskStatus,
  type Prisma,
} from "@prisma/client";

import {
  calculateAppliedCreditRestore,
  calculateRefundAmount,
  daysUntilDate,
  loadCancellationPolicy,
  type CancellationRule,
} from "@/lib/cancellation";
import { clubCalendarDateOf, type ClubTimeZone } from "@/lib/club-time";
import { REVIEW_CANCELLATION_REFUND_UNREPRODUCIBLE_MESSAGE } from "@/lib/edit-financial-review-refund-refusals";
import { ManualBookingPaymentError } from "@/lib/payment-reconciliation";
import { buildEditFinancialReviewRefundRecoveryIdempotencyKey } from "@/lib/payment-recovery-keys";

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
 * What a paid cancellation returns of a card base and an applied-credit slice:
 * `calculateRefundAmount` on the base and `calculateAppliedCreditRestore` on
 * the credit, the fee once and card-first - the two figures
 * `paidCancellationMoney` computes on the cancel path.
 */
export function cancellationReturnOf(
  days: number,
  policy: CancellationRule[],
  refundMethod: "card" | "credit",
): (cardBaseCents: number, appliedCents: number) => number {
  return (cardBaseCents, appliedCents) =>
    calculateRefundAmount(cardBaseCents, days, policy, refundMethod).refundAmountCents +
    calculateAppliedCreditRestore(appliedCents, cardBaseCents, days, policy).creditRestoredCents;
}

export function jsonRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** An integer figure in a frozen snapshot, or null where it is missing. */
function frozenCents(record: Record<string, unknown> | null, key: string): number | null {
  const value = record?.[key];
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

/**
 * #3835: owner decision 2 on a CAPTURED payment's share - the Stripe refund
 * route, the hand-back route (internet banking, whose cancellation returned
 * account credit) and the account-credit route that mints against the
 * payment. The cancellation refunded by tier on the full price; the share is netted against
 * that refund and the credit it restored, cumulatively across sibling reviews,
 * by `shareOwedAfterCancellationCents`. Never more than the share typed.
 *
 * Every figure is the cancellation's own, frozen on its CANCELLED event
 * (`writePaidCancellationEvent`, #3611): the paid money, its change fee, the
 * refund, the refund method, the applied credit and the restore. The card base
 * is the paid money less the change fee (`cancelRefundableBaseCents` below the
 * price cap). The tier is re-run on the cancellation's day and must reproduce
 * the refund and the restore before it is trusted with the share; where it
 * does not, or nothing was frozen, the completion is refused with the task
 * OPEN. A cancellation that returned nothing is not re-tiered: the share is
 * owed whole; one that returned everything owed nothing.
 *
 * Reads under the completion's `lock(1)`, which the cancel and every sibling
 * review hold too.
 */
export async function capturedShareOwedAfterCancellationCents({
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
}): Promise<number> {
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
  const appliedCents = frozenCents(ledger, "appliedCreditCents");
  const restoredCents = frozenCents(ledger, "creditRestoredCents");
  if (!cancelled || paidCents === null || changeFeeCents === null || refundedCents === null || appliedCents === null || restoredCents === null) {
    throw refuse();
  }

  const since = await settledSinceCancellation({ bookingId, taskId, since: cancelled.occurredAt, store });
  const returnedByCancellationCents = refundedCents + restoredCents;
  const cardBaseCents = Math.max(0, paidCents - changeFeeCents);
  if (returnedByCancellationCents <= 0) return Math.max(0, Math.min(shareCents, shareCents + since.sharesCents - since.returnedCents));
  if (returnedByCancellationCents >= cardBaseCents + appliedCents) return 0;

  const days = daysUntilDate(booking.checkIn, clubCalendarDateOf(cancelled.occurredAt, clubZone));
  const policy = await loadCancellationPolicy(booking.checkIn, booking.lodgeId, store);
  const refundMethod = snapshot?.refundMethod === "credit" ? "credit" : "card";
  const reproducedRefundCents = calculateRefundAmount(cardBaseCents, days, policy, refundMethod).refundAmountCents;
  const reproducedRestoreCents = calculateAppliedCreditRestore(appliedCents, cardBaseCents, days, policy).creditRestoredCents;
  if (reproducedRefundCents !== refundedCents || Math.min(reproducedRestoreCents, appliedCents) !== restoredCents) {
    throw refuse();
  }
  const owedCents = shareOwedAfterCancellationCents({
    sharesCents: since.sharesCents + shareCents,
    cardBaseCents,
    appliedCents,
    returnedByCancellationCents,
    returnedSinceCents: since.returnedCents,
    returnOf: cancellationReturnOf(days, policy, refundMethod),
  });
  return Math.min(shareCents, owedCents);
}

/**
 * The other reviews of this booking settled to the member since the
 * cancellation: the shares they were typed at, and what they actually
 * returned - a card refund's frozen debt (its recovery operation), a hand-back's
 * `BANK_REFUND` line, or the credit minted against the payment. Edits are
 * refused on a cancelled booking, so a modification credit on it since then is
 * a review's.
 */
async function settledSinceCancellation({
  bookingId,
  taskId,
  since,
  store,
}: {
  bookingId: string;
  taskId: string;
  since: Date;
  store: Prisma.TransactionClient;
}): Promise<{ sharesCents: number; returnedCents: number }> {
  const siblings = await store.manualRefundTask.findMany({
    where: {
      bookingId,
      id: { not: taskId },
      kind: ManualRefundTaskKind.EDIT_FINANCIAL_REVIEW,
      status: ManualRefundTaskStatus.COMPLETED,
      settlementDirection: ManualRefundTaskDirection.REFUND_TO_MEMBER,
      completedAt: { gte: since },
    },
    select: { id: true, amountCents: true },
  });
  if (siblings.length === 0) return { sharesCents: 0, returnedCents: 0 };
  const refunded = await store.paymentRecoveryOperation.aggregate({
    where: { idempotencyKey: { in: siblings.map((task) => buildEditFinancialReviewRefundRecoveryIdempotencyKey(task.id)) } },
    _sum: { amountCents: true },
  });
  const handedBack = await store.bookingLedgerLine.aggregate({
    where: { bookingId, kind: "BANK_REFUND", anchorKind: "REVIEW_TASK", anchorId: { in: siblings.map((task) => task.id) }, reversesLineId: null },
    _sum: { unitCents: true },
  });
  const minted = await store.memberCredit.aggregate({
    where: { sourceBookingId: bookingId, type: CreditType.BOOKING_MODIFICATION_REFUND, createdAt: { gte: since } },
    _sum: { amountCents: true },
  });
  return {
    sharesCents: siblings.reduce((sum, task) => sum + (task.amountCents ?? 0), 0),
    returnedCents: (refunded._sum.amountCents ?? 0) + (handedBack._sum.unitCents ?? 0) + (minted._sum.amountCents ?? 0),
  };
}
