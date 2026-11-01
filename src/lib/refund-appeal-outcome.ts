/**
 * #4117 (`INV-PAY-128`): WHAT AN APPROVED REFUND APPEAL HAS STILL TO GIVE BACK,
 * for the refund-requests screen, so its "Refunded" figure is what went back
 * rather than what was approved.
 *
 * - By card, through the request's recovery row: its unmade part, read as
 *   "Refunds owed" reads it (`openCardRefundOwedByOperation`). The row is
 *   retrying while the runner will still make it
 *   (`isPaymentRecoveryOperationInFlight`), and dead after that, owed until the
 *   treasurer closes it as paid another way.
 * - By card, with no row: when none could be written after Stripe was asked,
 *   the approval's audit row records the plan and when it was attempted
 *   (`RefundRequestCardRefundAnswer.cardRefundUnqueued`). It is read as one
 *   more card refund operation, so a refund recorded later on its slices - a
 *   webhook recording what Stripe made, a dashboard refund - clears it as it
 *   would a row. A refund made another way (a bank transfer) is not recorded on
 *   the payment, so it cannot clear it: the screen says to check and record it.
 * - Capped per payment, as "Refunds owed" is (`openCardRefundOwedCents`), and
 *   the cap is SHARED by the payment's appeals: together they never read more
 *   than the payment can still give back.
 * - By the group organiser's card (#3956, `INV-PAY-123`): the appeal's
 *   `organiser_card_appeal_refund_` debt, which hangs on the joiner's own
 *   payment, read exactly as the request's own row is (#4120).
 * - By bank transfer: this request's own hand-back task
 *   (`refundRequestHandBackOccurrenceKey`, `INV-PAY-118`) while OPEN, and once
 *   DISMISSED - the club kept that money, so it never went back.
 * - Closed as paid another way (`card-refund-paid-another-way.ts`): the row is
 *   SUCCEEDED, so it owes nothing, but a part close's unpaid rest never went
 *   back - read from the close's task, as a dismissed hand-back is (#4120),
 *   less any card refund Stripe made for it that was recorded after the close
 *   (`cardRefundSentAfterPaidAnotherWay`, the paid-twice reading).
 *
 * Read-only, three queries for a page of requests, and a fourth, for any
 * paid-another-way close, when one of the appeals' card refunds has SUCCEEDED.
 */
import { PaymentRecoveryOperationStatus, type PrismaClient } from "@prisma/client";

import { netCollectedCardRefundSelect } from "@/lib/additional-ledger-gap";
import {
  cardRefundPaidAnotherWayClosesWhere,
  closeKeysOf,
  paidAnotherWayUnpaidCents,
  refundRequestHandBackOccurrenceKey,
} from "@/lib/manual-refund-task-settlement-rules";
import {
  cardRefundSentAfterPaidAnotherWay,
  cardRefundSlicesByOperation,
  openCardRefundOwedCents,
  parseRefundAllocationPlan,
  unsentSliceCents,
  type CardRefundOperationRow,
} from "@/lib/open-card-refund-owed";
import { isPaymentRecoveryOperationInFlight } from "@/lib/payment-recovery-constants";
import { buildOrganiserChildAppealRefundKey, buildRefundRequestRefundRecoveryIdempotencyKey } from "@/lib/payment-recovery-keys";
import type { ApprovedAppealOutcome } from "@/lib/refund-request-card-refund-copy";

const NOTHING_OWED: ApprovedAppealOutcome = {
  cardRefundState: "made",
  cardRefundOwedCents: 0,
  cardRefundRefusedCents: 0,
  cardRefundUnansweredCents: 0,
  handBackOwedCents: 0,
  handBackDismissedCents: 0,
  cardRefundClosedUnpaidCents: 0,
};

/** The approve route's audit of a card refund no retry was queued for, as an operation the owed figure can read, or null. */
function unqueuedOperation(requestId: string, metadata: unknown): CardRefundOperationRow | null {
  if (!metadata || typeof metadata !== "object") return null;
  const record = metadata as Record<string, unknown>;
  if (record.cardRefundQueued !== false) return null;
  const unqueued = record.cardRefundUnqueued as { plan?: unknown; attemptedAt?: unknown } | undefined;
  const plan = parseRefundAllocationPlan(unqueued?.plan);
  const attemptedAt = typeof unqueued?.attemptedAt === "string" ? new Date(unqueued.attemptedAt) : null;
  if (!plan || !attemptedAt || Number.isNaN(attemptedAt.getTime())) return null;
  return {
    id: `unqueued:${requestId}`,
    type: "REFUND_BOOKING_MODIFICATION",
    status: "FAILED",
    idempotencyKey: `unqueued:${requestId}`,
    amountCents: plan.reduce((sum, slice) => sum + slice.amountCents, 0),
    allocationPlan: plan,
    paymentTransactionId: null,
    createdAt: attemptedAt,
    succeededAt: null,
  };
}

/**
 * An appeal's card refund row: the request's own, or (#3956) its debt to the group organiser's card.
 * The exact keys decide; they are the two families `isAppealRefundRecoveryKey` names for the census.
 */
function isAppealRefundRow(operation: { idempotencyKey: string }, requestId: string): boolean {
  const key = operation.idempotencyKey;
  return key === buildRefundRequestRefundRecoveryIdempotencyKey(requestId) || key === buildOrganiserChildAppealRefundKey(requestId);
}

type OutcomeStore = Pick<PrismaClient, "payment" | "auditLog" | "manualRefundTask">;

export async function readApprovedAppealOutcomes(
  db: OutcomeStore,
  requests: ReadonlyArray<{ id: string; status: string; booking: { payment: { id: string } | null } }>,
): Promise<Map<string, ApprovedAppealOutcome>> {
  const approved = requests.filter((request) => request.status === "APPROVED");
  const outcomes = new Map<string, ApprovedAppealOutcome>();
  if (approved.length === 0) return outcomes;
  const paymentIds = [...new Set(approved.flatMap((request) => (request.booking.payment ? [request.booking.payment.id] : [])))];
  const [payments, audits, handBacks] = await Promise.all([
    paymentIds.length
      ? db.payment.findMany({
          where: { id: { in: paymentIds } },
          select: {
            id: true,
            status: true,
            amountCents: true,
            refundedAmountCents: true,
            refunds: netCollectedCardRefundSelect.refunds,
            recoveryOperations: {
              where: netCollectedCardRefundSelect.recoveryOperations.where,
              select: { ...netCollectedCardRefundSelect.recoveryOperations.select, attempts: true, nextRetryAt: true },
            },
          },
        })
      : [],
    db.auditLog.findMany({
      where: { action: "refund-request.approve", entityType: "RefundRequest", entityId: { in: approved.map((request) => request.id) } },
      select: { entityId: true, metadata: true },
    }),
    db.manualRefundTask.findMany({
      where: {
        occurrenceKey: { in: approved.map((request) => refundRequestHandBackOccurrenceKey(request.id)) },
        status: { in: ["OPEN", "DISMISSED"] },
      },
      select: { occurrenceKey: true, status: true, amountCents: true },
    }),
  ]);

  // #4120: an appeal's card refund closed as paid another way is SUCCEEDED; its close's task says how much.
  const closedRows = new Map<string, { requestId: string; cardAfterCloseCents: number }>();
  for (const payment of payments) {
    const appeals = approved.filter((request) => request.booking.payment?.id === payment.id);
    // Each appeal's card refund: its recovery row, or the operation its audit records.
    const unqueued = new Map<string, CardRefundOperationRow>();
    for (const request of appeals) {
      const hasRow = payment.recoveryOperations.some((each) => isAppealRefundRow(each, request.id));
      const operation = hasRow ? null : unqueuedOperation(request.id, audits.find((audit) => audit.entityId === request.id)?.metadata);
      if (operation) unqueued.set(request.id, operation);
    }
    const owing = { ...payment, recoveryOperations: [...payment.recoveryOperations, ...unqueued.values()] };
    const slicesById = new Map(cardRefundSlicesByOperation(owing).map(({ operation, slices }) => [operation.id, slices]));
    const succeeded = new Map<string, string>();
    for (const request of appeals) {
      const row = payment.recoveryOperations.find((each) => isAppealRefundRow(each, request.id));
      if (row?.status === PaymentRecoveryOperationStatus.SUCCEEDED) succeeded.set(row.id, request.id);
    }
    // A refund Stripe made before a close and recorded after it went back by card too (paid twice).
    const cardAfterClose = succeeded.size ? cardRefundSentAfterPaidAnotherWay(owing, new Set(succeeded.keys())) : new Map<string, number>();
    for (const [rowId, requestId] of succeeded) closedRows.set(rowId, { requestId, cardAfterCloseCents: cardAfterClose.get(rowId) ?? 0 });
    // The per-payment cap, shared by the payment's appeals in list order.
    let capLeftCents = openCardRefundOwedCents(owing);
    for (const request of appeals) {
      const row = payment.recoveryOperations.find((each) => isAppealRefundRow(each, request.id));
      const operation = row ?? unqueued.get(request.id);
      if (!operation || (row && row.status === PaymentRecoveryOperationStatus.SUCCEEDED)) continue;
      const slices = slicesById.get(operation.id) ?? [];
      const owedCents = Math.min(capLeftCents, slices.reduce((sum, slice) => sum + unsentSliceCents(slice), 0));
      capLeftCents -= owedCents;
      if (owedCents <= 0) continue;
      const refusedCents = Math.min(
        owedCents,
        slices.filter((slice) => slice.stripeKeySuffix).reduce((sum, slice) => sum + unsentSliceCents(slice), 0),
      );
      outcomes.set(request.id, {
        ...NOTHING_OWED,
        cardRefundState: !row ? "not_queued" : isPaymentRecoveryOperationInFlight(row) ? "retrying" : "dead",
        cardRefundOwedCents: owedCents,
        ...(row ? {} : { cardRefundRefusedCents: refusedCents, cardRefundUnansweredCents: owedCents - refusedCents }),
      });
    }
  }

  // #4120: a part close is final - what it did not pay back went nowhere, as a dismissed hand-back.
  const closes = closedRows.size
    ? await db.manualRefundTask.findMany({
        where: cardRefundPaidAnotherWayClosesWhere(closedRows.keys()),
        select: { occurrenceKey: true, amountCents: true, raisedAmountCents: true },
      })
    : [];
  for (const [rowId, { requestId, cardAfterCloseCents }] of closedRows) {
    const keys = closeKeysOf(rowId);
    const closedUnpaidCents = closes
      .filter((close) => close.occurrenceKey !== null && keys.includes(close.occurrenceKey))
      .reduce((sum, close) => sum + paidAnotherWayUnpaidCents(close), 0);
    const unpaidCents = Math.max(0, closedUnpaidCents - cardAfterCloseCents);
    if (unpaidCents > 0) outcomes.set(requestId, { ...(outcomes.get(requestId) ?? NOTHING_OWED), cardRefundClosedUnpaidCents: unpaidCents });
  }

  for (const request of approved) {
    const key = refundRequestHandBackOccurrenceKey(request.id);
    const tasks = handBacks.filter((task) => task.occurrenceKey === key);
    const cents = (status: string) => tasks.filter((task) => task.status === status).reduce((sum, task) => sum + (task.amountCents ?? 0), 0);
    outcomes.set(request.id, { ...(outcomes.get(request.id) ?? NOTHING_OWED), handBackOwedCents: cents("OPEN"), handBackDismissedCents: cents("DISMISSED") });
  }
  return outcomes;
}
