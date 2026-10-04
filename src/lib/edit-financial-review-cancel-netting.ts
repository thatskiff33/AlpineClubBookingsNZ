import "server-only";

import {
  BookingEventType,
  CreditType,
  ManualRefundTaskDirection,
  ManualRefundTaskKind,
  ManualRefundTaskStatus,
  type Prisma,
} from "@prisma/client";

import { daysUntilDate, loadCancellationPolicy, type CancellationRule } from "@/lib/cancellation";
import { parseEditFinancialReviewContext } from "@/lib/edit-financial-review-context";
import { deriveBookingAppliedCreditCents } from "@/lib/member-credit";
import { bookingReducedThroughCreditGiveBack } from "@/lib/booking-credit-give-back-marker";
import { paidCancellationMoney } from "@/lib/paid-cancellation-money";
import { CLAIMABLE_PAYMENT_RECOVERY_STATUSES, NON_TERMINAL_PAYMENT_RECOVERY_STATUSES } from "@/lib/payment-recovery";
import { MAX_PAYMENT_RECOVERY_ATTEMPTS } from "@/lib/payment-recovery-constants";
import { clubCalendarDateOf, type ClubTimeZone } from "@/lib/club-time";
import {
  REVIEW_CANCELLATION_ORGANISER_PAID_MESSAGE,
  REVIEW_CANCELLATION_REFUND_UNREPRODUCIBLE_MESSAGE,
  reviewRefundOverPromisedMessage,
} from "@/lib/edit-financial-review-refund-refusals";
import { paidByOrganiserCard } from "@/lib/group-organiser-paid";
import type { ClubFormat } from "@/lib/club-format";
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
 * difference, floored at zero, is owed now. `returnOf` is the cancellation's
 * own tier (`cancellationReturnOf`).
 *
 * THE CREDIT-ONLY ROUTE'S FORM (#3791), where nothing was captured and the
 * pools are fixed. A captured payment's routes re-run the cancellation on the
 * review-first payment instead (`capturedShareOwedAfterCancellation`): there
 * #3809's money-first cap gives credit more headroom as the card is refunded,
 * which no fixed pool can show (`INV-PAY-115`).
 */
export function shareOwedAfterCancellationCents({
  sharesCents,
  untieredCaptureCents = 0,
  cardBaseCents,
  untieredCreditCents = 0,
  appliedCents,
  returnedByCancellationCents,
  returnedSinceCents,
  returnOf,
}: {
  sharesCents: number;
  /** Capture the cancellation left untiered, above the price it tiered (#3835). */
  untieredCaptureCents?: number;
  cardBaseCents: number;
  /** Applied credit the cancellation left untiered, above #3809's cap (`INV-PAY-115`). */
  untieredCreditCents?: number;
  /** The applied credit the cancellation tiered. */
  appliedCents: number;
  returnedByCancellationCents: number;
  returnedSinceCents: number;
  returnOf: (cardBaseCents: number, appliedCents: number) => number;
}): number {
  const slices = shareSlices({ sharesCents, untieredCaptureCents, cardBaseCents, untieredCreditCents, appliedCents });
  const owedCents =
    sharesCents +
    returnOf(cardBaseCents - slices.baseCents, appliedCents - slices.creditCents) -
    returnedByCancellationCents -
    returnedSinceCents;
  return Math.max(0, owedCents);
}

/**
 * Where the shares come from, had they come back first, for
 * `shareOwedAfterCancellationCents`: each pool in turn. On the credit-only
 * route (no capture, no card base) the applied credit above #3809's cap goes
 * before the credit the cap tiered, since with nothing captured nothing moves
 * that cap (`INV-PAY-115`); with no cap it is #3791's slicing.
 */
export function shareSlices({
  sharesCents,
  untieredCaptureCents,
  cardBaseCents,
  untieredCreditCents = 0,
  appliedCents,
}: {
  sharesCents: number;
  untieredCaptureCents: number;
  cardBaseCents: number;
  untieredCreditCents?: number;
  appliedCents: number;
}): { untieredCents: number; baseCents: number; untieredCreditCents: number; creditCents: number } {
  let left = Math.max(0, sharesCents);
  const take = (poolCents: number) => {
    const cents = Math.max(0, Math.min(left, poolCents));
    left -= cents;
    return cents;
  };
  const untieredCents = take(untieredCaptureCents);
  const baseCents = take(cardBaseCents);
  const untieredCredit = take(untieredCreditCents);
  return { untieredCents, baseCents, untieredCreditCents: untieredCredit, creditCents: take(appliedCents) };
}

/**
 * What a paid cancellation returns of a capture base and an applied-credit
 * base, by `paidCancellationMoney` itself - the cancel path's one call - on a
 * payment of exactly those bases: the refund (`card`) and the restore
 * (`credit`), the fee once and card-first. The credit-only route (#3791) is the
 * case with no capture base.
 *
 * #3809's cap (`capAppliedCredit`, `bookingReducedThroughCreditGiveBack`) is
 * passed as the cancel passed it. The bases it is handed are the ones that
 * cancel froze, already capped, so the booking is priced at exactly their sum
 * and the cap, applied again, leaves them as they are (`INV-PAY-115`).
 */
export function cancellationTierOf(
  days: number,
  policy: CancellationRule[],
  refundMethod: "card" | "credit",
  capAppliedCredit: boolean,
): (baseCents: number, appliedCents: number) => { captureCents: number; creditCents: number } {
  return (baseCents, appliedCents) => {
    const money = paidCancellationMoney({
      payment: { amountCents: baseCents, refundedAmountCents: 0, changeFeeCents: 0, creditAppliedCents: appliedCents },
      // The bases are the cancel's frozen ones, already net of any open hand-back
      // (#3827, `INV-PAY-117`), so none is subtracted a second time here.
      openNonCancellationHandBackCents: 0,
      finalPriceCents: baseCents + appliedCents,
      capAppliedCredit,
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
  capAppliedCredit: boolean,
): (cardBaseCents: number, appliedCents: number) => number {
  const tierOf = cancellationTierOf(days, policy, refundMethod, capAppliedCredit);
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
 * The applied credit a cancellation TIERED: #3809's `ledger.appliedCreditBaseCents`
 * (capped at the price, applied only where its give-back ran) where the
 * CANCELLED event carries it, else the ledger's applied credit as frozen.
 */
export function frozenAppliedCreditBaseCents(snapshot: Record<string, unknown> | null): number | null {
  const ledger = jsonRecord(snapshot?.ledger);
  return frozenCents(ledger, "appliedCreditBaseCents") ?? frozenCents(ledger, "appliedCreditCents");
}

/**
 * #3809's cap for a re-tier: whether the cancel capped the credit it tiered
 * (`bookingReducedThroughCreditGiveBack`), passed on as the cancel passed it.
 * A capped booking whose CANCELLED event froze no capped base (a cancel older
 * than the cap) cannot be reproduced, so it is refused with the task OPEN.
 */
export async function capAppliedCreditForReTier(
  { bookingId, snapshot, refusal }: { bookingId: string; snapshot: Record<string, unknown> | null; refusal: () => Error },
  store: Prisma.TransactionClient,
): Promise<boolean> {
  const capped = await bookingReducedThroughCreditGiveBack(bookingId, store);
  if (capped && frozenCents(jsonRecord(snapshot?.ledger), "appliedCreditBaseCents") === null) throw refusal();
  return capped;
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
 * REVIEW FIRST, RE-RUN. Had the shares come back first, they would have come
 * off the capture first (a review refunds the card, or hands back by bank
 * transfer) and then the applied credit, and the cancellation would then have
 * run `paidCancellationMoney` on that smaller payment - with #3809's
 * money-first cap, so card refunded first moves credit headroom under the cap
 * (`INV-PAY-115`). So that is what is re-run, through `cancellationTierOf`:
 * the payment less the capture's slice, the credit less the credit's slice, at
 * the price the frozen bases give (`frozenWorthCents`). Still owed is that
 * review-first total less what the cancellation and earlier reviews returned,
 * floored at nothing and never more than the share typed.
 *
 * IT GOES BACK THE WAY IT CAME IN. The capture part is what review-first would
 * have returned to the capture less what the capture has had back (the
 * cancellation's refund, earlier reviews' refunds, hand-backs and minted
 * credit), held to the total; the rest is applied credit given back. The
 * capture is never asked for the credit's part.
 *
 * Every figure is the cancellation's own, frozen on its CANCELLED event
 * (`writePaidCancellationEvent`): the paid money and change fee, the refund
 * and its method, the refundable base, the applied credit and the base #3809's
 * cap tiered of it, the restore, and the reviews already settled when it ran.
 * Events older than #3835 fall back to the paid money less the change fee and
 * the branch's method. The tier must reproduce the cancellation's refund and
 * restore before it is trusted; where it does not, or nothing was frozen, the
 * completion is refused with the task OPEN. A cancellation that returned
 * nothing re-runs at no tier, one that returned everything at a full one,
 * neither needing the policy in force.
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
  // #3653 (`INV-PAY-114`): a joiner's booking the group organiser paid by card
  // was refunded to the ORGANISER, out of the combined payment, clamped to the
  // group's debt - not a tier this can re-run. Refused, task OPEN - even after
  // a 0% cancel: a settled refund of nothing there can also mean the group's
  // own cancellation carried the child's refund, which the event does not say.
  const owner = await store.booking.findUniqueOrThrow({
    where: { id: bookingId },
    select: { organiserSettled: true, parentBookingId: true, payment: { select: { source: true } } },
  });
  if (paidByOrganiserCard(owner)) throw new ManualBookingPaymentError(REVIEW_CANCELLATION_ORGANISER_PAID_MESSAGE, 409);
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
  const appliedBaseCents = frozenAppliedCreditBaseCents(snapshot);
  const restoredCents = frozenCents(ledger, "creditRestoredCents");
  if (
    !cancelled || paidCents === null || changeFeeCents === null || refundedCents === null ||
    appliedRowsCents === null || appliedBaseCents === null || restoredCents === null
  ) {
    throw refuse();
  }
  const baseCents = frozenCents(snapshot, "refundableBaseCents") ?? Math.max(0, paidCents - changeFeeCents);
  const refundMethod = (snapshot?.tierRefundMethod ?? snapshot?.refundMethod) === "credit" ? "credit" : "card";
  const returnedByCancellationCents = refundedCents + restoredCents;

  // No tier where nothing came back, a full one where everything tiered did;
  // otherwise the policy in force, which must reproduce the cancellation.
  let policy: CancellationRule[] = [];
  let days = 0;
  let capAppliedCredit = false;
  if (returnedByCancellationCents >= baseCents + appliedBaseCents) {
    policy = [{ daysBeforeStay: 0, refundPercentage: 100, fixedFeeCents: 0, creditRefundPercentage: 100, creditFixedFeeCents: 0 }];
  } else if (returnedByCancellationCents > 0) {
    days = daysUntilDate(booking.checkIn, clubCalendarDateOf(cancelled.occurredAt, clubZone));
    policy = await loadCancellationPolicy(booking.checkIn, booking.lodgeId, store);
    capAppliedCredit = await capAppliedCreditForReTier({ bookingId, snapshot, refusal: refuse }, store);
  }
  const worthCents = frozenWorthCents({ baseCents, appliedBaseCents, capAppliedCredit });
  const cancelOf = (captureSliceCents: number, creditSliceCents: number) =>
    paidCancellationMoney({
      payment: { amountCents: paidCents - captureSliceCents, refundedAmountCents: 0, changeFeeCents, creditAppliedCents: appliedRowsCents - creditSliceCents },
      // The CANCELLED event froze `paidAmountCents` already net of the open
      // hand-backs it read (#3827, `INV-PAY-117`), so the reproduction subtracts none.
      openNonCancellationHandBackCents: 0,
      finalPriceCents: worthCents,
      appliedCreditCents: appliedRowsCents - creditSliceCents,
      restoresToMemberLedger: true,
      days,
      policy,
      refundMethod,
      capAppliedCredit,
    });
  if (returnedByCancellationCents > 0 && returnedByCancellationCents < baseCents + appliedBaseCents) {
    const reproduced = cancelOf(0, 0);
    if (reproduced.refundAmountCents !== refundedCents || reproduced.creditRestoredCents !== restoredCents) throw refuse();
  }

  const since = await settledSinceCancellation({ bookingId, taskId, snapshot, since: cancelled.occurredAt, store });
  // The restore leaves the applied rows alone, so what reviews have given back
  // since is exactly how far the rows have fallen from the frozen figure.
  const creditBackSinceCents = Math.max(0, appliedRowsCents - (await deriveBookingAppliedCreditCents(bookingId, store)));
  const sharesCents = since.sharesCents + shareCents;
  const captureSliceCents = Math.max(0, Math.min(sharesCents, paidCents - changeFeeCents));
  const creditSliceCents = Math.max(0, Math.min(appliedRowsCents, sharesCents - captureSliceCents));
  const reviewFirst = cancelOf(captureSliceCents, creditSliceCents);
  const reviewFirstCents = captureSliceCents + creditSliceCents + reviewFirst.refundAmountCents + reviewFirst.creditRestoredCents;
  const totalCents = Math.max(
    0,
    Math.min(shareCents, reviewFirstCents - returnedByCancellationCents - since.captureReturnedCents - creditBackSinceCents),
  );
  const captureOwedCents = captureSliceCents + reviewFirst.refundAmountCents - refundedCents - since.captureReturnedCents;
  const captureCents = Math.max(0, Math.min(totalCents, captureOwedCents));
  return { captureCents, creditCents: totalCents - captureCents };
}

/**
 * The booking's price as the cancellation saw it, from the
 * bases it froze. Where #3809's money-first cap ran, the worth is exactly the
 * capture base and the credit base it left (the cap fills the worth, money
 * first); where it did not, the price only ever held the capture down, and the
 * capture base is a price that holds it to the same base.
 */
export function frozenWorthCents({
  baseCents,
  appliedBaseCents,
  capAppliedCredit,
}: {
  baseCents: number;
  appliedBaseCents: number;
  capAppliedCredit: boolean;
}): number {
  return baseCents + (capAppliedCredit ? appliedBaseCents : 0);
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
  const siblings = await store.manualRefundTask.findMany({
    where: reviewsSettledAfterCancelWhere({ bookingId, taskId, snapshot, since }),
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
 * THE ONE RULE for which other reviews of a booking were settled to the member
 * AFTER its cancellation (#3835), on every route: not among the ids its
 * CANCELLED event froze as already settled; an event without them (older than
 * #3835) falls back to completion time, `since` being when the cancel ran.
 */
export function reviewsSettledAfterCancelWhere({
  bookingId,
  taskId,
  snapshot,
  since,
}: {
  bookingId: string;
  taskId: string;
  snapshot: Record<string, unknown> | null;
  since: Date;
}): Prisma.ManualRefundTaskWhereInput {
  const frozenIds = snapshot?.completedReviewTaskIds;
  const priorIds = Array.isArray(frozenIds) ? frozenIds.filter((id): id is string => typeof id === "string") : null;
  return {
    bookingId,
    id: { notIn: [taskId, ...(priorIds ?? [])] },
    kind: ManualRefundTaskKind.EDIT_FINANCIAL_REVIEW,
    status: ManualRefundTaskStatus.COMPLETED,
    settlementDirection: ManualRefundTaskDirection.REFUND_TO_MEMBER,
    ...(priorIds === null ? { completedAt: { gte: since } } : {}),
  };
}

/**
 * #3835: card refunds already promised out of this payment and not yet made -
 * the cancellation's and earlier reviews' frozen Stripe debts that have not
 * SUCCEEDED and are still being retried. A debt that is dead (no next retry, or
 * its attempts spent - the recovery module's rule) is a person's to settle, and once they refund by hand the payment's
 * refunded total already says so, so it is not counted twice. A debt partly
 * made counts whole: the cap errs towards refusing, with the task OPEN.
 */
async function unfinishedCardRefundDebts(
  { paymentId, bookingId }: { paymentId: string; bookingId: string },
  store: Prisma.TransactionClient,
): Promise<number> {
  const debts = await store.paymentRecoveryOperation.aggregate({
    where: {
      paymentId,
      status: { in: [...NON_TERMINAL_PAYMENT_RECOVERY_STATUSES] },
      // Not dead: the recovery module's own rule (`isEditFinancialReviewChargeRecoveryDead`).
      NOT: {
        status: { in: [...CLAIMABLE_PAYMENT_RECOVERY_STATUSES] },
        OR: [{ nextRetryAt: null }, { attempts: { gte: MAX_PAYMENT_RECOVERY_ATTEMPTS } }],
      },
      OR: [
        { idempotencyKey: buildBookingCancellationRefundIdempotencyKey(bookingId) },
        { idempotencyKey: { startsWith: buildEditFinancialReviewRefundRecoveryIdempotencyKey("") } },
      ],
    },
    _sum: { amountCents: true },
  });
  return debts._sum.amountCents ?? 0;
}

/**
 * The card route's second cap (#3835): the capture's refundable total less the
 * card refunds already promised and not yet made, so no mix of pending refunds
 * can promise more than was captured. Refused, task OPEN, with a sentence that
 * names those refunds - the payment history alone would show the headroom.
 */
export async function assertCardRefundNotOverPromised({
  paymentId,
  bookingId,
  refundCents,
  totalRefundableCents,
  format,
  store,
}: {
  paymentId: string;
  bookingId: string;
  refundCents: number;
  totalRefundableCents: number;
  format: ClubFormat;
  store: Prisma.TransactionClient;
}): Promise<void> {
  const promisedCents = await unfinishedCardRefundDebts({ paymentId, bookingId }, store);
  if (refundCents > totalRefundableCents - promisedCents) {
    throw new ManualBookingPaymentError(
      reviewRefundOverPromisedMessage({ refundCents, promisedCents, availableCents: Math.max(0, totalRefundableCents - promisedCents), format }),
      409,
    );
  }
}
