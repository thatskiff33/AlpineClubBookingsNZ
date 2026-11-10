import "server-only";

import {
  BookingEventType,
  ManualRefundTaskKind,
  PaymentRecoveryOperationStatus,
  PaymentStatus,
  type PaymentSource,
  type Prisma,
} from "@prisma/client";
import type Stripe from "stripe";

import { createAuditLog } from "@/lib/audit";
import { recordBookingEvent } from "@/lib/booking-events";
import { bookingOwner } from "@/lib/booking-owner";
import { formatBookingReference } from "@/lib/booking-reference";
import {
  GROUP_CARD_REFUND_LEGACY_OTHER_LIVE,
  GROUP_CARD_REFUND_STRIPE_UNREADABLE,
  GROUP_CARD_REFUND_UNKEYED_SAME_AMOUNT,
} from "@/lib/card-refund-group-copy";
import {
  classifyLegacyGroupIntentRefunds,
  classifyOrganiserChildIntentRefunds,
} from "@/lib/card-refund-group-intent";
import { DeadCardRefundActionError } from "@/lib/card-refund-dead-row";
import { deadRowClaimWhere, lockDeadCardRefundRow, type DeadCardRefundRowRefusals } from "@/lib/card-refund-dead-row-lock";
import { PAID_ANOTHER_WAY_MARKER, postPaidAnotherWayLine } from "@/lib/card-refund-paid-another-way";
import type { PaidBackChoice } from "@/lib/card-refund-paid-back";
import { getClubFormat } from "@/lib/club-format-settings";
import type { ClubFormat } from "@/lib/club-format";
import {
  applyLegacyGroupChildRefundMirror,
  recordLegacyGroupChildRefundRecovered,
} from "@/lib/group-cancel";
import { groupCancelInProgress } from "@/lib/group-cancel-in-progress";
import {
  alertGroupMirrorRefundXeroByHand,
  applyGroupSettlementMirrorRefund,
  GROUP_CANCEL_IN_PROGRESS_MESSAGE,
} from "@/lib/group-settlement-mirror-hand-back";
import { deserializeRefundPlan, legacyGroupSettlementRefundUnsentCents } from "@/lib/group-settlement-refund-plan";
import logger from "@/lib/logger";
import { cardRefundPaidAnotherWayOccurrenceKey } from "@/lib/manual-refund-task-settlement-rules";
import { MANUAL_REFUND_TASK_REASON_MAX, normaliseManualPaymentNote } from "@/lib/manual-subscription-payment";
import { isRefusedRefundStatus } from "@/lib/payment-transaction-status";
import { findCombinedCardSettlementForChild } from "@/lib/organiser-child-refund";
import {
  finishRecordedOrganiserChildRefund,
  recordOrganiserChildRefundInTransaction,
} from "@/lib/organiser-child-refund-executor";
import { ManualBookingPaymentError } from "@/lib/payment-reconciliation";
import {
  groupSettlementIdForRefundRecoveryKey,
  isGroupSettlementRefundRecoveryKey,
  isOrganiserChildAppealRefundKey,
  isOrganiserChildRefundKey,
} from "@/lib/payment-recovery-keys";
import { prisma } from "@/lib/prisma";
import { listRefundsForPaymentIntent } from "@/lib/stripe";
import { formatCents } from "@/lib/utils";

/**
 * #4851 (owner decision, 10 Nov 2026): PAID ANOTHER WAY FOR A DEAD REFUND OUT OF
 * THE GROUP ORGANISER'S CARD. Two rows the charge-backed close still refuses,
 * because that close would book the organiser's money on the wrong booking.
 *
 * - A per-joiner refund (`isOrganiserChildRefundKey`): one refund of the row's
 *   amount from the organiser's combined PaymentIntent. The child's payment
 *   has no card charge.
 * - A pre-#3653 whole-group refund (`isGroupSettlementRefundRecoveryKey`): one
 *   combined refund of a `{childId: cents}` plan. The row's payment is only
 *   the organiser payment, as a foreign key.
 *
 * Stripe is read before the transaction (`listRefundsForPaymentIntent`). If
 * that read fails, nothing is written. Under the lock, a moved intent id or
 * settlement status writes nothing. No `processRefund`, no
 * `applyLocalRefundAllocation`, and no new `PaymentRefund` on the bank path.
 * The same lock and claim as the charge-backed close (`lockDeadCardRefundRow`,
 * `accept: "either-group"`, `deadRowClaimWhere`).
 *
 * STATED LIMIT: a refund Stripe creates after this read can still sit beside
 * the bank payment. These rows are not on the paid-back-twice list.
 */

const REFUSALS: DeadCardRefundRowRefusals = {
  notOwedKind: "This is not a group organiser's card refund that can be closed here.",
  organiserChild: "This is not a group organiser's card refund that can be closed here.",
  closed: "This card refund has already been closed.",
  notGivenUp: "This card refund is still being retried, so it cannot be closed yet.",
  otherBooking: "This card refund's payment belongs to another booking, so it cannot be closed here. Ask a developer to reconcile it.",
};

const CHANGED =
  "This card refund changed while you were settling it. The list has been refreshed: check it and try again.";

const NOT_THIS_INTENT =
  "This refund does not match the group organiser's card payment, so it cannot be settled here. Ask a developer to reconcile it.";

export interface GroupCardRefundPaidAnotherWayInput {
  operationId: string;
  amountCents: number;
  paidBack: PaidBackChoice;
  expectedOwedCents: number;
  note: string | null | undefined;
  actingMemberId: string;
}

export interface GroupCardRefundPaidAnotherWayResult {
  operationId: string;
  bookingId: string;
  paymentId: string;
  amountCents: number;
  /** What the close did, so the dialog can say it. */
  outcome: "recorded-stripe" | "bank" | "mirrors" | "closed";
}

interface SettlementSnap {
  id: string;
  status: string;
  amountCents: number;
  source: PaymentSource;
  stripePaymentIntentId: string | null;
  refundPlan: Prisma.JsonValue;
}

interface Snap {
  paymentIntentId: string;
  settlement: SettlementSnap | null;
  refunds: Stripe.Refund[];
}

async function readRefunds(paymentIntentId: string): Promise<Stripe.Refund[]> {
  try {
    return await listRefundsForPaymentIntent(paymentIntentId);
  } catch (error) {
    logger.warn({ err: error, paymentIntentId }, "Group card refund close refused: Stripe's refunds could not be read (#4851)");
    throw new DeadCardRefundActionError(GROUP_CARD_REFUND_STRIPE_UNREADABLE, 409);
  }
}

function planTotal(settlement: SettlementSnap | null): number {
  if (!settlement) return 0;
  let total = 0;
  for (const cents of deserializeRefundPlan(settlement.refundPlan).values()) total += cents;
  return total;
}

function sameSettlement(current: SettlementSnap | null, read: SettlementSnap | null): boolean {
  if (current === null || read === null) return current === read;
  return current.id === read.id && current.status === read.status && current.stripePaymentIntentId === read.stripePaymentIntentId;
}

async function claimSucceeded(
  tx: Prisma.TransactionClient,
  operation: { id: string; allocationPlan: Prisma.JsonValue },
  lastError: string | null,
): Promise<void> {
  const claimed = await tx.paymentRecoveryOperation.updateMany({
    where: deadRowClaimWhere(operation),
    data: {
      status: PaymentRecoveryOperationStatus.SUCCEEDED,
      succeededAt: new Date(),
      nextRetryAt: null,
      processingStartedAt: null,
      lastError,
    },
  });
  if (claimed.count === 0) throw new DeadCardRefundActionError(CHANGED, 409);
}

/** Close one dead group card refund as paid another way. See the module comment. */
export async function closeGroupCardRefundPaidAnotherWay(
  input: GroupCardRefundPaidAnotherWayInput,
): Promise<GroupCardRefundPaidAnotherWayResult> {
  const note = normaliseManualPaymentNote(input.note);
  if (!note) throw new DeadCardRefundActionError("Say how the organiser was paid back - a note is required.", 400);
  if (!Number.isSafeInteger(input.amountCents) || input.amountCents < 0) {
    throw new DeadCardRefundActionError("The amount paid back must be whole cents.", 400);
  }
  if (input.paidBack !== "full") {
    throw new DeadCardRefundActionError("This refund is the organiser's and closes for the whole amount.", 400);
  }
  if (!Number.isSafeInteger(input.expectedOwedCents) || input.expectedOwedCents < 0) {
    throw new DeadCardRefundActionError("Say what you saw still owed, in whole cents.", 400);
  }
  if (input.amountCents !== input.expectedOwedCents) {
    throw new DeadCardRefundActionError("This refund is the organiser's and closes for the whole amount.", 400);
  }

  const preview = await prisma.paymentRecoveryOperation.findUnique({
    where: { id: input.operationId },
    select: { id: true, idempotencyKey: true, paymentIntentId: true, paymentId: true, bookingId: true, amountCents: true },
  });
  if (!preview) throw new DeadCardRefundActionError("Card refund not found.", 404);
  const childKey = isOrganiserChildRefundKey(preview.idempotencyKey);
  const legacyKey = isGroupSettlementRefundRecoveryKey(preview.idempotencyKey);
  if (!childKey && !legacyKey) {
    throw new DeadCardRefundActionError(REFUSALS.notOwedKind, 409);
  }
  if (!preview.paymentIntentId) throw new DeadCardRefundActionError(GROUP_CARD_REFUND_STRIPE_UNREADABLE, 409);

  const settlement = childKey
    ? await perJoinerSettlement(preview.paymentId, preview.bookingId)
    : await prisma.groupBookingSettlement.findUnique({
        where: { id: groupSettlementIdForRefundRecoveryKey(preview.idempotencyKey) },
        select: { id: true, status: true, amountCents: true, source: true, stripePaymentIntentId: true, refundPlan: true },
      });
  const refunds = await readRefunds(preview.paymentIntentId);
  const snap: Snap = { paymentIntentId: preview.paymentIntentId, settlement, refunds };
  const format = await getClubFormat();

  const result = await prisma.$transaction(async (tx) => {
    const locked = await lockDeadCardRefundRow(tx, input.operationId, REFUSALS, "either-group");
    if (locked.operation.paymentIntentId !== snap.paymentIntentId) throw new DeadCardRefundActionError(CHANGED, 409);
    return childKey
      ? closePerJoiner(tx, locked, snap, input, note, format)
      : closeLegacy(tx, locked, snap, input, format);
  });

  if (result.finish) {
    await finishRecordedOrganiserChildRefund(result.finish);
  }
  for (const follow of result.legacyFollowUps) {
    await recordLegacyGroupChildRefundRecovered(follow);
  }
  for (const alert of result.alerts) {
    await alertGroupMirrorRefundXeroByHand({ ...alert, format });
  }
  return {
    operationId: result.operationId,
    bookingId: result.bookingId,
    paymentId: result.paymentId,
    amountCents: result.amountCents,
    outcome: result.outcome,
  };
}

async function perJoinerSettlement(paymentId: string, bookingId: string): Promise<SettlementSnap | null> {
  const payment = await prisma.payment.findUnique({
    where: { id: paymentId },
    select: { booking: { select: { id: true, organiserSettled: true, parentBookingId: true } } },
  });
  if (!payment || payment.booking.id !== bookingId) return null;
  const found = await findCombinedCardSettlementForChild(prisma, payment.booking);
  if (!found) return null;
  return prisma.groupBookingSettlement.findUnique({
    where: { id: found.id },
    select: { id: true, status: true, amountCents: true, source: true, stripePaymentIntentId: true, refundPlan: true },
  });
}

type Locked = Awaited<ReturnType<typeof lockDeadCardRefundRow>>;

interface CloseBody {
  operationId: string;
  bookingId: string;
  paymentId: string;
  amountCents: number;
  outcome: GroupCardRefundPaidAnotherWayResult["outcome"];
  finish: Parameters<typeof finishRecordedOrganiserChildRefund>[0] | null;
  legacyFollowUps: Parameters<typeof recordLegacyGroupChildRefundRecovered>[0][];
  alerts: { bookingId: string; taskId: string; refundCents: number }[];
}

async function closePerJoiner(
  tx: Prisma.TransactionClient,
  locked: Locked,
  snap: Snap,
  input: GroupCardRefundPaidAnotherWayInput,
  note: string,
  format: ClubFormat,
): Promise<CloseBody> {
  const { operation, payment, booking } = locked;
  if (operation.amountCents !== input.expectedOwedCents) throw new DeadCardRefundActionError(CHANGED, 409);
  const child = await tx.booking.findUnique({
    where: { id: booking.id },
    select: { id: true, status: true, organiserSettled: true, parentBookingId: true, memberId: true, lodgeId: true },
  });
  if (!child?.organiserSettled) throw new DeadCardRefundActionError(NOT_THIS_INTENT, 409);
  const settlement = await findCombinedCardSettlementForChild(tx, child);
  const read = snap.settlement;
  if (
    !settlement ||
    !read ||
    settlement.stripePaymentIntentId !== operation.paymentIntentId ||
    settlement.id !== read.id ||
    settlement.status !== read.status
  ) {
    throw new DeadCardRefundActionError(CHANGED, 409);
  }

  const kind = classifyOrganiserChildIntentRefunds(snap.refunds, operation.idempotencyKey, operation.amountCents);
  if (kind === "unkeyed-same-amount") throw new DeadCardRefundActionError(GROUP_CARD_REFUND_UNKEYED_SAME_AMOUNT, 409);
  if (kind === "keyed") {
    const refund = snap.refunds.find(
      (row) => row.metadata?.organiserChildRefundKey === operation.idempotencyKey && !isRefusedRefundStatus(row.status),
    );
    if (!refund) throw new DeadCardRefundActionError(CHANGED, 409);
    const recorded = await recordOrganiserChildRefundInTransaction(tx, {
      operation,
      paymentId: payment.id,
      settlement,
      refund,
      claimWhere: deadRowClaimWhere(operation),
    });
    if (recorded.claimed === 0) throw new DeadCardRefundActionError(CHANGED, 409);
    return {
      operationId: operation.id,
      bookingId: operation.bookingId,
      paymentId: payment.id,
      amountCents: refund.amount,
      outcome: "recorded-stripe",
      finish: {
        operation,
        payment: { id: payment.id, booking: { memberId: child.memberId } },
        settlementId: settlement.id,
        refund,
        recorded,
        format,
      },
      legacyFollowUps: [],
      alerts: [],
    };
  }

  if (await groupCancelInProgress(tx, child)) {
    throw new DeadCardRefundActionError(GROUP_CANCEL_IN_PROGRESS_MESSAGE, 409);
  }
  if (input.amountCents <= 0) {
    throw new DeadCardRefundActionError("This refund is for nothing, so it cannot be recorded as a bank payment.", 409);
  }
  await claimSucceeded(tx, operation, PAID_ANOTHER_WAY_MARKER);
  try {
    await applyGroupSettlementMirrorRefund({
      route: {
        kind: "group-settlement-mirror",
        paymentId: payment.id,
        bookingModificationId: null,
        refundCents: input.amountCents,
        creditBackCents: 0,
      },
      store: tx,
    });
  } catch (error) {
    if (error instanceof ManualBookingPaymentError) throw new DeadCardRefundActionError(error.message, 409);
    throw error;
  }
  const record = await tx.manualRefundTask.create({
    data: {
      bookingId: booking.id,
      paymentId: payment.id,
      kind: ManualRefundTaskKind.CANCELLED_BOOKING_HAND_BACK,
      occurrenceKey: cardRefundPaidAnotherWayOccurrenceKey(operation.id, { xeroRefundNote: "none" }),
      amountCents: input.amountCents,
      raisedAmountCents: input.amountCents,
      status: "COMPLETED",
      completedAt: new Date(),
      completedByMemberId: input.actingMemberId,
      note,
      reason: `A refund to the group organiser on booking ${formatBookingReference(booking.id)} that Stripe gave up on was paid back by bank transfer (#4851).`.slice(
        0,
        MANUAL_REFUND_TASK_REASON_MAX,
      ),
    },
    select: { id: true },
  });
  await postPaidAnotherWayLine(tx, {
    bookingId: booking.id,
    lodgeId: child.lodgeId,
    taskId: record.id,
    amountCents: input.amountCents,
    officerMemberId: input.actingMemberId,
  });
  if (!isOrganiserChildAppealRefundKey(operation.idempotencyKey)) {
    await recordBookingEvent(
      {
        bookingId: operation.bookingId,
        type: BookingEventType.REFUNDED,
        actorMemberId: null,
        amountCents: input.amountCents,
        reason: `${formatCents(input.amountCents, format)} was paid back to the group organiser by bank transfer, who paid for this booking.`,
      },
      tx,
    );
  }
  await createAuditLog(
    {
      action: "booking-payment.card-refund.paid-another-way",
      memberId: input.actingMemberId,
      actorMemberId: input.actingMemberId,
      subjectMemberId: bookingOwner(child).memberId,
      targetId: operation.bookingId,
      entityType: "PaymentRecoveryOperation",
      entityId: operation.id,
      category: "payment",
      severity: "important",
      outcome: "success",
      summary: "Group organiser's card refund Stripe gave up on closed as paid by bank transfer. Officers credit the group's invoice in Xero by hand.",
      details: note,
      metadata: {
        operationId: operation.id,
        bookingId: operation.bookingId,
        paymentId: payment.id,
        settleKind: "organiser-child",
        amountCents: input.amountCents,
        manualRefundTaskId: record.id,
        organiserCard: true,
      },
    },
    tx,
  );
  return {
    operationId: operation.id,
    bookingId: operation.bookingId,
    paymentId: payment.id,
    amountCents: input.amountCents,
    outcome: "bank",
    finish: null,
    legacyFollowUps: [],
    alerts: [{ bookingId: operation.bookingId, taskId: record.id, refundCents: input.amountCents }],
  };
}

async function closeLegacy(
  tx: Prisma.TransactionClient,
  locked: Locked,
  snap: Snap,
  input: GroupCardRefundPaidAnotherWayInput,
  format: ClubFormat,
): Promise<CloseBody> {
  const { operation, booking } = locked;
  const current = await tx.groupBookingSettlement.findUnique({
    where: { id: snap.settlement?.id ?? groupSettlementIdForRefundRecoveryKey(operation.idempotencyKey) },
    select: { id: true, status: true, amountCents: true, source: true, stripePaymentIntentId: true, refundPlan: true, groupBookingId: true },
  });
  const comparable = current
    ? { id: current.id, status: current.status, amountCents: current.amountCents, source: current.source, stripePaymentIntentId: current.stripePaymentIntentId, refundPlan: current.refundPlan }
    : null;
  if (!sameSettlement(comparable, snap.settlement)) throw new DeadCardRefundActionError(CHANGED, 409);
  const owed = current ? legacyGroupSettlementRefundUnsentCents(current) : 0;
  if (owed !== input.expectedOwedCents) throw new DeadCardRefundActionError(CHANGED, 409);

  const total = planTotal(comparable);
  const live = classifyLegacyGroupIntentRefunds(snap.refunds, total);
  if (live === "other") throw new DeadCardRefundActionError(GROUP_CARD_REFUND_LEGACY_OTHER_LIVE, 409);

  const base = {
    operationId: operation.id,
    bookingId: operation.bookingId,
    paymentId: locked.payment.id,
    finish: null,
    alerts: [] as CloseBody["alerts"],
  };

  if (!current || total <= 0) {
    await claimSucceeded(tx, operation, null);
    return { ...base, amountCents: 0, outcome: "closed", legacyFollowUps: [] };
  }

  const already = current.status === PaymentStatus.REFUNDED || current.status === PaymentStatus.PARTIALLY_REFUNDED;
  if (live === "match" || already) {
    if (live === "match" && current.status === PaymentStatus.SUCCEEDED) await flipSettlement(tx, current, total);
    const raised = await mirrorChildren(tx, current, true);
    await claimSucceeded(tx, operation, null);
    return {
      ...base,
      amountCents: total,
      outcome: live === "match" ? "recorded-stripe" : raised.length > 0 ? "mirrors" : "closed",
      legacyFollowUps: raised.map((row) => ({
        child: row.child,
        settlementId: current.id,
        groupBookingId: current.groupBookingId,
        paymentId: row.paymentId,
        refundedCents: row.refundedCents,
        queuedOperationId: row.queuedOperationId,
        format,
        outcome: already && live !== "match" ? "already_refunded" : "refunded",
      })),
    };
  }

  if (current.status === PaymentStatus.SUCCEEDED) {
    await flipSettlement(tx, current, total);
    const raised = await mirrorChildren(tx, current, false);
    await claimSucceeded(tx, operation, PAID_ANOTHER_WAY_MARKER);
    await createAuditLog(
      {
        action: "booking-payment.card-refund.paid-another-way",
        memberId: input.actingMemberId,
        actorMemberId: input.actingMemberId,
        subjectMemberId: bookingOwner(booking).memberId,
        targetId: operation.bookingId,
        entityType: "PaymentRecoveryOperation",
        entityId: operation.id,
        category: "payment",
        severity: "important",
        outcome: "success",
        summary: "Old whole-group card refund Stripe gave up on closed as paid by bank transfer. Officers credit the group's invoice in Xero by hand.",
        details: normaliseManualPaymentNote(input.note),
        metadata: { operationId: operation.id, settleKind: "legacy-group", amountCents: total, organiserCard: true, raised: raised.map((row) => row.child.id) },
      },
      tx,
    );
    return {
      ...base,
      amountCents: total,
      outcome: "bank",
      legacyFollowUps: [],
      alerts: raised.map((row) => ({ bookingId: row.child.id, taskId: operation.id, refundCents: row.refundedCents })),
    };
  }

  await claimSucceeded(tx, operation, null);
  return { ...base, amountCents: 0, outcome: "closed", legacyFollowUps: [] };
}

async function flipSettlement(
  tx: Prisma.TransactionClient,
  settlement: { id: string; status: string; amountCents: number },
  total: number,
): Promise<void> {
  const flipped = await tx.groupBookingSettlement.updateMany({
    where: { id: settlement.id, status: settlement.status as PaymentStatus },
    data: { status: total >= settlement.amountCents ? PaymentStatus.REFUNDED : PaymentStatus.PARTIALLY_REFUNDED },
  });
  if (flipped.count !== 1) throw new DeadCardRefundActionError(CHANGED, 409);
}

async function mirrorChildren(
  tx: Prisma.TransactionClient,
  settlement: { id: string; source: PaymentSource; refundPlan: Prisma.JsonValue },
  enqueueCreditNote: boolean,
): Promise<{ child: { id: string; memberId: string | null }; paymentId: string; refundedCents: number; queuedOperationId: string | null }[]> {
  const raised = [];
  for (const [childId, refundForChild] of deserializeRefundPlan(settlement.refundPlan)) {
    if (refundForChild <= 0) continue;
    const child = await tx.booking.findUnique({
      where: { id: childId },
      select: { id: true, status: true, memberId: true, lodgeId: true, payment: { select: { id: true } } },
    });
    if (!child || child.status !== "CANCELLED" || !child.payment) continue;
    const mirror = await applyLegacyGroupChildRefundMirror(tx, {
      bookingId: child.id,
      paymentId: child.payment.id,
      lodgeId: child.lodgeId,
      refundForChild,
      settlement,
      enqueueCreditNote,
    });
    if (!mirror.raised) continue;
    raised.push({
      child: { id: child.id, memberId: child.memberId },
      paymentId: child.payment.id,
      refundedCents: mirror.refundedCents,
      queuedOperationId: mirror.queuedOperationId,
    });
  }
  return raised;
}
