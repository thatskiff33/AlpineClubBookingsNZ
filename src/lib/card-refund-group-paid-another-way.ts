import "server-only";

import {
  BookingEventType,
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
  groupCardRefundXeroQueued,
  planGroupCardRefundBankClose,
  recordGroupCardRefundBankClose,
  type GroupCardRefundCloseOperation,
  type GroupCardRefundXeroQueued,
} from "@/lib/card-refund-group-paid-another-way-xero";
import {
  GROUP_CARD_REFUND_LEGACY_OTHER_LIVE,
  GROUP_CARD_REFUND_LEGACY_PLAN_MISMATCH,
  GROUP_CARD_REFUND_STRIPE_UNREADABLE,
  GROUP_CARD_REFUND_UNKEYED_SAME_AMOUNT,
} from "@/lib/card-refund-group-copy";
import {
  classifyLegacyGroupIntentRefunds,
  classifyOrganiserChildIntentRefunds,
} from "@/lib/card-refund-group-intent";
import {
  DEAD_CARD_REFUND_CHANGED_WHILE_SETTLING,
  DEAD_CARD_REFUND_CLOSED,
  DeadCardRefundActionError,
} from "@/lib/card-refund-dead-row";
import { deadRowClaimWhere, lockDeadCardRefundRow, type DeadCardRefundRowRefusals } from "@/lib/card-refund-dead-row-lock";
import { PAID_ANOTHER_WAY_MARKER, postPaidAnotherWayLine } from "@/lib/card-refund-paid-another-way";
import { paidAnotherWayXeroAuditFollowUp, paidAnotherWayXeroQueuedARow } from "@/lib/card-refund-paid-another-way-xero";
import type { PaidBackChoice } from "@/lib/card-refund-paid-back";
import { getClubFormat } from "@/lib/club-format-settings";
import type { ClubFormat } from "@/lib/club-format";
import type { ClubTimeZone } from "@/lib/club-time";
import { readClubTimeZoneOutsideRequest } from "@/lib/club-time-zone-runtime";
import {
  applyLegacyGroupChildRefundMirror,
  recordLegacyGroupChildRefundRecovered,
} from "@/lib/group-cancel";
import { groupCancelInProgress } from "@/lib/group-cancel-in-progress";
import { applyGroupSettlementMirrorRefund, GROUP_CANCEL_IN_PROGRESS_MESSAGE } from "@/lib/group-settlement-mirror-hand-back";
import {
  deserializeRefundPlan,
  LEGACY_GROUP_REFUND_PAID_BY_BANK_NOTE,
  legacyGroupSettlementRefundUnsentCents,
} from "@/lib/group-settlement-refund-plan";
import logger from "@/lib/logger";
import { normaliseManualPaymentNote } from "@/lib/manual-subscription-payment";
import { isRefusedRefundStatus } from "@/lib/payment-transaction-status";
import { findCombinedCardSettlementForChild } from "@/lib/organiser-child-refund";
import {
  finishRecordedOrganiserChildRefund,
  recordOrganiserChildRefundInTransaction,
} from "@/lib/organiser-child-refund-executor";
import { LOCK1_HOLDER_TRANSACTION_BUDGET } from "@/lib/db-transaction";
import { ManualBookingPaymentError } from "@/lib/manual-booking-payment-error";
import {
  groupSettlementIdForRefundRecoveryKey,
  isGroupSettlementRefundRecoveryKey,
  isOrganiserChildAppealRefundKey,
  isOrganiserChildRefundKey,
} from "@/lib/payment-recovery-keys";
import { prisma } from "@/lib/prisma";
import { listRefundsForPaymentIntent } from "@/lib/stripe";
import { formatCents } from "@/lib/utils";
import { kickQueuedXeroOutboxOperationsIfConnected } from "@/lib/xero-operation-outbox";

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
 * #5267 (owner decision, 20 Nov 2026): a bank close credits Xero itself. Each
 * joiner's invoice gets the bank-transfer refund note an ordinary close raises,
 * queued in this transaction and keyed on the joiner's record
 * (`card-refund-group-paid-another-way-xero.ts`); officers are no longer
 * emailed to credit the group's invoice by hand.
 *
 * STATED LIMIT: a refund Stripe creates after this read can still sit beside
 * the bank payment. These rows are not on the paid-back-twice list.
 */

const REFUSALS: DeadCardRefundRowRefusals = {
  notOwedKind: "This is not a group organiser's card refund that can be closed here.",
  organiserChild: "This is not a group organiser's card refund that can be closed here.",
  closed: DEAD_CARD_REFUND_CLOSED,
  notGivenUp: "This card refund is still being retried, so it cannot be closed yet.",
  otherBooking: "This card refund's payment belongs to another booking, so it cannot be closed here. Ask a developer to reconcile it.",
};

const CHANGED = DEAD_CARD_REFUND_CHANGED_WHILE_SETTLING;

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
  /** #5267: what a bank close queued in Xero; `nothing` for every other outcome. */
  xeroQueued: GroupCardRefundXeroQueued;
}

/** The settlement fields the close pre-reads and re-reads under the lock: one select, so the two cannot drift. */
const SETTLEMENT_SNAP_SELECT = {
  id: true,
  status: true,
  amountCents: true,
  source: true,
  stripePaymentIntentId: true,
  refundPlan: true,
} as const satisfies Prisma.GroupBookingSettlementSelect;

type SettlementSnap = Prisma.GroupBookingSettlementGetPayload<{ select: typeof SETTLEMENT_SNAP_SELECT }>;

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
        select: SETTLEMENT_SNAP_SELECT,
      });
  const refunds = await readRefunds(preview.paymentIntentId);
  const snap: Snap = { paymentIntentId: preview.paymentIntentId, settlement, refunds };
  const format = await getClubFormat();
  // `INV-LOCK-004`: the club's zone, for the Xero notes' date, is read before the transaction.
  const clubZone = await readClubTimeZoneOutsideRequest();

  const result = await prisma.$transaction(async (tx) => {
    const locked = await lockDeadCardRefundRow(tx, input.operationId, REFUSALS, "either-group");
    if (locked.operation.paymentIntentId !== snap.paymentIntentId) throw new DeadCardRefundActionError(CHANGED, 409);
    const close: CloseContext = { snap, input, note, format, clubZone, closedAt: new Date() };
    const body = childKey ? await closePerJoiner(tx, locked, close) : await closeLegacy(tx, locked, close);
    // Every outcome is the officer's close of the row, so every one is audited under `payment` with its note.
    await createAuditLog(
      {
        action: "booking-payment.card-refund.paid-another-way",
        memberId: input.actingMemberId,
        actorMemberId: input.actingMemberId,
        subjectMemberId: bookingOwner(locked.booking).memberId,
        targetId: locked.operation.bookingId,
        entityType: "PaymentRecoveryOperation",
        entityId: locked.operation.id,
        category: "payment",
        severity: "important",
        outcome: "success",
        summary: closeSummary(childKey ? "organiser-child" : "legacy-group", body),
        details: note,
        metadata: {
          operationId: locked.operation.id,
          bookingId: locked.operation.bookingId,
          paymentId: locked.payment.id,
          settleKind: childKey ? "organiser-child" : "legacy-group",
          outcome: body.outcome,
          amountCents: body.amountCents,
          organiserCard: true,
          xeroQueued: body.xeroQueued,
          ...body.auditMetadata,
        },
      },
      tx,
    );
    return body;
  }, LOCK1_HOLDER_TRANSACTION_BUDGET);

  if (result.finish) {
    await finishRecordedOrganiserChildRefund(result.finish);
  }
  for (const follow of result.legacyFollowUps) {
    await recordLegacyGroupChildRefundRecovered(follow);
  }
  if (result.xeroRowsQueued > 0) {
    // The notes' rows committed with the close: only the kick is left.
    await kickQueuedXeroOutboxOperationsIfConnected({ limit: result.xeroRowsQueued }).catch((error: unknown) =>
      logger.error({ err: error, operationId: result.operationId }, "Failed to kick the Xero outbox after a group card refund's paid-another-way close"),
    );
  }
  return {
    operationId: result.operationId,
    bookingId: result.bookingId,
    paymentId: result.paymentId,
    amountCents: result.amountCents,
    outcome: result.outcome,
    xeroQueued: result.xeroQueued,
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
    select: SETTLEMENT_SNAP_SELECT,
  });
}

type Locked = Awaited<ReturnType<typeof lockDeadCardRefundRow>>;

/**
 * #5267: what a bank close's audit summary says it queued in Xero. A joiner
 * with no note may have no invoice, or its note may have been refused at the
 * queue, so the summary says no note was queued, never why.
 */
function bankCloseXeroSentence(kind: "organiser-child" | "legacy-group", queued: GroupCardRefundXeroQueued): string {
  const whose = kind === "organiser-child" ? "the joiner's invoice" : "each joiner's invoice";
  if (queued === "refund-note") return `A Xero refund credit note worded as a bank transfer is queued on ${whose}.`;
  if (queued === "some-refund-notes") {
    return "A Xero refund credit note worded as a bank transfer is queued on some joiners' invoices; none was queued for the others, so check their refunds are recorded in Xero.";
  }
  return "No Xero refund credit note was queued: check the refund is recorded in Xero.";
}

/** The audit row's summary for each outcome of the close. */
function closeSummary(kind: "organiser-child" | "legacy-group", body: Pick<CloseBody, "outcome" | "xeroQueued">): string {
  const what = kind === "organiser-child"
    ? "Group organiser's card refund Stripe gave up on"
    : "Old whole-group card refund Stripe gave up on";
  switch (body.outcome) {
    case "recorded-stripe":
      return `${what} closed: Stripe already had the refund, so it was recorded and nobody was paid again.`;
    case "bank":
      // A reversal's words are the ordinary close's own (`INV-PAY-151`).
      return body.xeroQueued === "stripe-reversal-and-bank-note"
        ? `${what} closed as paid by bank transfer${paidAnotherWayXeroAuditFollowUp(body.xeroQueued)}`
        : `${what} closed as paid by bank transfer. ${bankCloseXeroSentence(kind, body.xeroQueued)}`;
    case "mirrors":
      return `${what} closed: the group's payment was already refunded, so only the joiners' refund records were finished.`;
    case "closed":
      return `${what} closed with nothing left to send or record.`;
  }
}

interface CloseBody {
  operationId: string;
  bookingId: string;
  paymentId: string;
  amountCents: number;
  outcome: GroupCardRefundPaidAnotherWayResult["outcome"];
  finish: Parameters<typeof finishRecordedOrganiserChildRefund>[0] | null;
  legacyFollowUps: Parameters<typeof recordLegacyGroupChildRefundRecovered>[0][];
  /** #5267: what the bank close queued in Xero, and how many outbox rows it can run now. */
  xeroQueued: GroupCardRefundXeroQueued;
  xeroRowsQueued: number;
  /** Extra fields for the close's one audit row. */
  auditMetadata: Record<string, unknown>;
}

/** Everything a close reads outside its transaction, and the instant it closes at. */
interface CloseContext {
  snap: Snap;
  input: GroupCardRefundPaidAnotherWayInput;
  note: string;
  format: ClubFormat;
  clubZone: ClubTimeZone;
  closedAt: Date;
}

const NOTHING_QUEUED = { xeroQueued: "nothing", xeroRowsQueued: 0 } as const;

/** The row as the Xero plan reads it, on the organiser's intent the close checked. */
function closeOperation(locked: Locked, snap: Snap): GroupCardRefundCloseOperation {
  const { id, idempotencyKey, amountCents, allocationPlan } = locked.operation;
  return { id, idempotencyKey, amountCents, allocationPlan, paymentIntentId: snap.paymentIntentId };
}

async function closePerJoiner(tx: Prisma.TransactionClient, locked: Locked, close: CloseContext): Promise<CloseBody> {
  const { snap, input, note, format } = close;
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
        payment: { id: payment.id, booking: { memberId: bookingOwner(child).memberId } },
        settlementId: settlement.id,
        refund,
        recorded,
        format,
      },
      legacyFollowUps: [],
      ...NOTHING_QUEUED,
      auditMetadata: { stripeRefundId: refund.id },
    };
  }

  if (await groupCancelInProgress(tx, child)) {
    throw new DeadCardRefundActionError(GROUP_CANCEL_IN_PROGRESS_MESSAGE, 409);
  }
  if (input.amountCents <= 0) {
    throw new DeadCardRefundActionError("This refund is for nothing, so it cannot be recorded as a bank payment.", 409);
  }
  // #5267: planned before the claim and the money, as the ordinary close plans.
  const xeroPlan = await planGroupCardRefundBankClose(tx, closeOperation(locked, snap), { paymentId: payment.id, amountCents: input.amountCents });
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
  // #5267: the record, keyed as its plan says, and the joiner's note on it.
  const record = await recordGroupCardRefundBankClose(tx, xeroPlan, {
    bookingId: booking.id,
    keyedBy: "row",
    note,
    reason: `A refund to the group organiser on booking ${formatBookingReference(booking.id)} that Stripe gave up on was paid back by bank transfer (#4851).`,
    actingMemberId: input.actingMemberId,
    clubZone: close.clubZone,
    closedAt: close.closedAt,
  });
  await postPaidAnotherWayLine(tx, {
    bookingId: booking.id,
    lodgeId: child.lodgeId,
    taskId: record.recordId,
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
  return {
    operationId: operation.id,
    bookingId: operation.bookingId,
    paymentId: payment.id,
    amountCents: input.amountCents,
    outcome: "bank",
    finish: null,
    legacyFollowUps: [],
    xeroQueued: record.xeroQueued,
    xeroRowsQueued: paidAnotherWayXeroQueuedARow(record.xeroQueued) ? 1 : 0,
    auditMetadata: { manualRefundTaskId: record.recordId },
  };
}

async function closeLegacy(tx: Prisma.TransactionClient, locked: Locked, close: CloseContext): Promise<CloseBody> {
  const { snap, input, note, format } = close;
  const { operation } = locked;
  const current = await tx.groupBookingSettlement.findUnique({
    where: { id: snap.settlement?.id ?? groupSettlementIdForRefundRecoveryKey(operation.idempotencyKey) },
    select: { ...SETTLEMENT_SNAP_SELECT, groupBookingId: true },
  });
  if (!sameSettlement(current, snap.settlement)) throw new DeadCardRefundActionError(CHANGED, 409);
  const owed = current ? legacyGroupSettlementRefundUnsentCents(current) : 0;
  if (owed !== input.expectedOwedCents) throw new DeadCardRefundActionError(CHANGED, 409);

  const total = planTotal(current);
  const live = classifyLegacyGroupIntentRefunds(snap.refunds, total);
  if (live === "other") throw new DeadCardRefundActionError(GROUP_CARD_REFUND_LEGACY_OTHER_LIVE, 409);

  const base = {
    operationId: operation.id,
    bookingId: operation.bookingId,
    paymentId: locked.payment.id,
    finish: null,
    ...NOTHING_QUEUED,
    auditMetadata: {},
  };

  if (!current || total <= 0) {
    await claimSucceeded(tx, operation, null);
    return { ...base, amountCents: 0, outcome: "closed", legacyFollowUps: [] };
  }

  const already = current.status === PaymentStatus.REFUNDED || current.status === PaymentStatus.PARTIALLY_REFUNDED;
  if (live === "match" || already) {
    if (live === "match" && current.status === PaymentStatus.SUCCEEDED) await flipSettlement(tx, current, total);
    const raised = await mirrorChildren(tx, current, "card");
    await claimSucceeded(tx, operation, null);
    return {
      ...base,
      amountCents: total,
      outcome: live === "match" ? "recorded-stripe" : raised.length > 0 ? "mirrors" : "closed",
      auditMetadata: { raised: raised.map((row) => row.child.id) },
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
    const raised = await mirrorChildren(tx, current, "bank");
    // #4851 review, #5267: the bank paid the whole plan, and the Xero notes are
    // one per raised mirror. If a plan child was skipped or capped, the notes
    // would credit less than the bank paid, so roll it all back.
    if (raised.reduce((sum, row) => sum + row.refundedCents, 0) !== total) {
      throw new DeadCardRefundActionError(GROUP_CARD_REFUND_LEGACY_PLAN_MISMATCH, 409);
    }
    // The note is the plan's record that its refund lines are bank refunds (`legacyGroupRefundPaidByBank`).
    await claimSucceeded(tx, operation, LEGACY_GROUP_REFUND_PAID_BY_BANK_NOTE);
    // #5267: each joiner's record and note, for its share. The plan's refund
    // line above is the joiner's bank refund, so the record posts none.
    const records = [];
    for (const row of raised) {
      const joiner = { paymentId: row.paymentId, amountCents: row.refundedCents };
      const record = await recordGroupCardRefundBankClose(tx, await planGroupCardRefundBankClose(tx, closeOperation(locked, snap), joiner), {
        bookingId: row.child.id,
        keyedBy: "joiner",
        note,
        reason: `A group organiser's old whole-group card refund that Stripe gave up on was paid back by bank transfer; this is booking ${formatBookingReference(row.child.id)}'s share (#4851).`,
        actingMemberId: input.actingMemberId,
        clubZone: close.clubZone,
        closedAt: close.closedAt,
      });
      records.push({ bookingId: row.child.id, manualRefundTaskId: record.recordId, amountCents: row.refundedCents, xeroQueued: record.xeroQueued });
    }
    return {
      ...base,
      amountCents: total,
      outcome: "bank",
      xeroQueued: groupCardRefundXeroQueued(records.map((record) => record.xeroQueued)),
      xeroRowsQueued: records.filter((record) => paidAnotherWayXeroQueuedARow(record.xeroQueued)).length,
      auditMetadata: { raised: raised.map((row) => row.child.id), records },
      legacyFollowUps: [],
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
  paidBackBy: "card" | "bank",
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
      paidBackBy,
    });
    if (!mirror.raised) continue;
    raised.push({
      child: { id: child.id, memberId: bookingOwner(child).memberId },
      paymentId: child.payment.id,
      refundedCents: mirror.refundedCents,
      queuedOperationId: mirror.queuedOperationId,
    });
  }
  return raised;
}
