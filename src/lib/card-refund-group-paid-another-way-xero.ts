import "server-only";

import { ManualRefundTaskKind, type Prisma } from "@prisma/client";

import {
  paidAnotherWayXeroPlan,
  paidAnotherWayXeroPromise,
  queuePaidAnotherWayXero,
  type PaidAnotherWayXeroPromise,
  type PaidAnotherWayXeroQueued,
} from "@/lib/card-refund-paid-another-way-xero";
import type { ClubTimeZone } from "@/lib/club-time";
import { deserializeRefundPlan } from "@/lib/group-settlement-refund-plan";
import { cardRefundPaidAnotherWayOccurrenceKey } from "@/lib/manual-refund-task-settlement-rules";
import { MANUAL_REFUND_TASK_REASON_MAX } from "@/lib/manual-subscription-payment";

/**
 * #5267 (owner decision, 20 Nov 2026; `INV-PAY-153`): THE XERO STEP OF A
 * "PAID ANOTHER WAY" CLOSE OF A DEAD REFUND OUT OF THE GROUP ORGANISER'S CARD.
 *
 * A group the organiser paid for by card has one Xero invoice per joiner
 * (`settleConfirmedChildrenAndNotify` queues each child's), so the bank money is credited
 * there, with the note an ordinary close already raises (`INV-PAY-122`): a
 * bank-transfer refund note for exactly the joiner's money, planned before
 * the record (`paidAnotherWayXeroPlan`), whose key carries the answer, and
 * queued on the close's transaction keyed on the record
 * (`queuePaidAnotherWayXero`). No by-hand email, and no second mechanism.
 *
 * - A per-joiner refund: one record, keyed on the row as any close is.
 * - A pre-#3653 whole-group refund: one record per joiner the plan raised,
 *   keyed on the row and the joiner (`childBookingId`),
 *   for that joiner's share - so the notes add up to the bank refund. The
 *   plan's refund line on the joiner is already its `BANK_REFUND`
 *   (`legacyGroupRefundPaidByBank`): the record posts no line of its own.
 *
 * A joiner with no invoice in Xero gets the `none` key and no note, as an
 * ordinary close does. Every write is an outbox row inside the caller's
 * `lock(1)` transaction; no provider call runs here.
 */

/** The row being closed, as the Xero plan reads it. */
export type GroupCardRefundCloseOperation = {
  id: string;
  idempotencyKey: string;
  paymentIntentId: string;
  amountCents: number;
  allocationPlan: Prisma.JsonValue;
};

export interface GroupCardRefundBankRecordInput {
  operation: GroupCardRefundCloseOperation;
  /** The joiner's booking and payment the bank money went back for. */
  bookingId: string;
  paymentId: string;
  /** `row`: a per-joiner refund's one record. `joiner`: one of an old whole-group refund's, one per joiner. */
  keyedBy: "row" | "joiner";
  amountCents: number;
  note: string;
  reason: string;
  actingMemberId: string;
  clubZone: ClubTimeZone;
  closedAt: Date;
}

/**
 * Write one joiner's COMPLETED close record and queue its Xero note, on the
 * close's transaction. The plan is read for this joiner's payment and this
 * joiner's money: a per-joiner row is its own amount, a whole-group joiner its
 * share of the plan.
 */
export async function recordGroupCardRefundBankClose(
  tx: Prisma.TransactionClient,
  input: GroupCardRefundBankRecordInput,
): Promise<{ recordId: string; xeroQueued: PaidAnotherWayXeroQueued }> {
  const payment = await tx.payment.findUnique({ where: { id: input.paymentId }, select: { id: true, xeroInvoiceId: true } });
  if (!payment) throw new Error(`Group card refund close ${input.operation.id}: the joiner's payment ${input.paymentId} is gone`);
  const plan = await paidAnotherWayXeroPlan(tx, { ...input.operation, amountCents: input.amountCents }, payment, { lockApprovalTask: true });
  const record = await tx.manualRefundTask.create({
    data: {
      bookingId: input.bookingId,
      paymentId: payment.id,
      kind: ManualRefundTaskKind.CANCELLED_BOOKING_HAND_BACK,
      occurrenceKey: cardRefundPaidAnotherWayOccurrenceKey(input.operation.id, {
        xeroRefundNote: plan.xeroRefundNote,
        ...(input.keyedBy === "joiner" ? { childBookingId: input.bookingId } : {}),
      }),
      amountCents: input.amountCents,
      raisedAmountCents: input.amountCents,
      status: "COMPLETED",
      completedAt: input.closedAt,
      completedByMemberId: input.actingMemberId,
      note: input.note,
      reason: input.reason.slice(0, MANUAL_REFUND_TASK_REASON_MAX),
    },
    select: { id: true },
  });
  const xeroQueued = await queuePaidAnotherWayXero(tx, plan, {
    operationId: input.operation.id,
    bookingId: input.bookingId,
    paymentId: payment.id,
    recordId: record.id,
    amountCents: input.amountCents,
    actingMemberId: input.actingMemberId,
    clubZone: input.clubZone,
    closedAt: input.closedAt,
  });
  return { recordId: record.id, xeroQueued };
}

/**
 * What a group close queued in Xero: one joiner's answer, or (a whole-group
 * close) every joiner's - the one answer when they all agree, otherwise
 * `some-refund-notes`: notes for the joiners with an invoice, none for the rest.
 */
export type GroupCardRefundXeroQueued = PaidAnotherWayXeroQueued | "some-refund-notes";

export function groupCardRefundXeroQueued(answers: readonly PaidAnotherWayXeroQueued[]): GroupCardRefundXeroQueued {
  if (answers.length === 0) return "nothing";
  return answers.every((answer) => answer === answers[0]) ? answers[0]! : "some-refund-notes";
}

/**
 * What the Stuck States dialog promises for a group row before its close, from
 * the same plan the close reads. A per-joiner row: its joiner's plan. An old
 * whole-group row: `now` when every joiner its plan refunds has an invoice to
 * credit, else `none`.
 *
 * STATED LIMIT: a whole-group row with some joiners invoiced and some not
 * reads `none` here; its close still notes the invoiced ones, and says so.
 */
export async function groupCardRefundXeroPromise(
  db: Prisma.TransactionClient,
  row:
    | { kind: "organiser-child"; operation: GroupCardRefundCloseOperation; payment: { id: string; xeroInvoiceId: string | null } }
    | { kind: "legacy-group"; operation: GroupCardRefundCloseOperation; refundPlan: Prisma.JsonValue | null },
): Promise<{ xeroRefundNote: PaidAnotherWayXeroPromise; cardNoteCoversCents: number }> {
  if (row.kind === "organiser-child") {
    const plan = await paidAnotherWayXeroPlan(db, row.operation, row.payment, { lockApprovalTask: false });
    return {
      xeroRefundNote: paidAnotherWayXeroPromise(plan),
      cardNoteCoversCents: plan.xeroRefundNote === "now" ? (plan.cardNoteCoversCents ?? 0) : 0,
    };
  }
  const shares = [...deserializeRefundPlan(row.refundPlan)].filter(([, cents]) => cents > 0);
  if (shares.length === 0) return { xeroRefundNote: "none", cardNoteCoversCents: 0 };
  const joiners = await db.booking.findMany({
    where: { id: { in: shares.map(([bookingId]) => bookingId) } },
    select: { id: true, payment: { select: { id: true, xeroInvoiceId: true } } },
  });
  for (const [bookingId, cents] of shares) {
    const payment = joiners.find((joiner) => joiner.id === bookingId)?.payment;
    const plan = payment ? await paidAnotherWayXeroPlan(db, { ...row.operation, amountCents: cents }, payment, { lockApprovalTask: false }) : null;
    if (plan?.xeroRefundNote !== "now") return { xeroRefundNote: "none", cardNoteCoversCents: 0 };
  }
  return { xeroRefundNote: "now", cardNoteCoversCents: 0 };
}
