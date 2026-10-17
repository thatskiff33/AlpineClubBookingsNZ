import "server-only";

import { Prisma } from "@prisma/client";

import { netCollectedPaymentSelect } from "@/lib/additional-ledger-gap";
import { createAuditLog } from "@/lib/audit";
import { bookingOwner } from "@/lib/booking-owner";
import { formatBookingReference } from "@/lib/booking-reference";
import { normaliseManualPaymentNote } from "@/lib/manual-subscription-payment";
import {
  CARD_REFUND_PAID_ANOTHER_WAY_TASK_WHERE,
  closeKeysOf,
  paymentRecoveryOperationIdOfPaidAnotherWay,
} from "@/lib/manual-refund-task-settlement-rules";
import { readPaidTwiceResolution, type PaidTwiceResolution } from "@/lib/card-refund-paid-twice-resolution";
import { cardRefundSentAfterPaidAnotherWay } from "@/lib/open-card-refund-owed";
import { lockPaymentForRefundedTotal } from "@/lib/payment-transactions";
import { prisma } from "@/lib/prisma";

/**
 * #3924 round 5 (concurrency F2) and round 7 (owner, 9 Oct 2026: "Add a
 * 'Resolved' button"; `INV-PAY-122`): CARD REFUNDS PAID BACK TWICE.
 *
 * A card refund the treasurer closed as paid another way that Stripe ALSO
 * refunded - a refund Stripe made before the close (its answer lost to a
 * timeout) that reached the app after it. The member has that money twice; the
 * stuck-states page lists each so the treasurer can sort it out with them.
 *
 * RESOLVED. Once they have, the treasurer marks the row Resolved with a note
 * saying how it was settled. The note is audited (`payment`) and the row
 * leaves the list. It moves no money and touches no Xero: whatever was agreed
 * with the member is recorded in Xero by the treasurer, as the list says.
 *
 * WHERE IT IS KEPT, without a schema change: on the close's own record (the
 * COMPLETED `ManualRefundTask` the close wrote), in its `reviewContext` - a
 * column only an edit's financial review fills, and every reader of which asks
 * for that kind first (#4104: the close itself may keep its card-note cover
 * there, which the resolution keeps beside it). The audit log is not the
 * store: its rows leave the main database for the archive after a year, and
 * the row would come back. The
 * resolution names how much Stripe had refunded when it was resolved, so a
 * further card refund for the same close brings the row back.
 *
 * ONE WRITE, STATUS-GUARDED: an `updateMany` on the record as it was read - the
 * close's own shape, and the resolution it carried then (none, or an earlier
 * one) - so a second click, or a second treasurer, writes nothing and is told.
 * #4210 round 3 (concurrency 3): read, checked and written in one transaction
 * under the Payment row (`lockPaymentForRefundedTotal`), which the failed-later
 * writer holds as it reads this record: a card refund failing later as this
 * commits is weighed after it or before it, never against a figure this read
 * and that one moved.
 *
 * STRIPE MAY STILL FAIL IT (#4210, `INV-PAY-136`). A card refund listed here
 * may be one Stripe accepted as pending; if Stripe fails it, it no longer counts,
 * so the row leaves this list on its own. The failed-later writer then decides
 * it as settled by the close (`findPaidAnotherWayCloseThatSettled`): nothing
 * after a full close, a dead row to check after a part close, or the whole
 * refund dead when this row was marked Resolved - the member may have returned
 * the extra.
 *
 * WHAT THE TREASURER SAW (#3924 round 8): the request carries the card figure
 * the dialog showed. A Stripe refund recorded since - one they never saw - makes
 * the figure differ, and the Resolved is refused with a 409. The resolution
 * then records exactly the figure they saw.
 */

const PAYMENT_SELECT = {
  id: true,
  ...netCollectedPaymentSelect,
} as const satisfies Prisma.PaymentSelect;

const RECORD_SELECT = {
  id: true,
  kind: true,
  occurrenceKey: true,
  bookingId: true,
  amountCents: true,
  completedAt: true,
  reviewContext: true,
  payment: { select: PAYMENT_SELECT },
} as const satisfies Prisma.ManualRefundTaskSelect;

type CloseRecord = Prisma.ManualRefundTaskGetPayload<{ select: typeof RECORD_SELECT }>;

/** The record's `reviewContext` as an object to add to, or an empty one. */
function reviewContextObject(reviewContext: Prisma.JsonValue): Prisma.InputJsonObject {
  return reviewContext !== null && typeof reviewContext === "object" && !Array.isArray(reviewContext)
    ? (reviewContext as Prisma.InputJsonObject)
    : {};
}

/** A card refund closed as paid another way that Stripe then paid as well. */
export interface CardRefundPaidTwiceRow {
  operationId: string;
  bookingId: string;
  bookingReference: string;
  /** When the treasurer closed it (ISO instant). */
  closedAt: string;
  /** What the close recorded as paid back another way. */
  paidAnotherWayCents: number;
  /** What Stripe refunded to the card for it after the close. */
  refundedByCardCents: number;
}

/** What Stripe refunded to the card for this close after it, or 0. */
function refundedByCardAfterClose(record: CloseRecord, operationId: string): number {
  if (record.payment === null) return 0;
  return cardRefundSentAfterPaidAnotherWay(record.payment, new Set([operationId])).get(operationId) ?? 0;
}

/** Whether the close is on the list: Stripe paid it too, by more than any resolution already covered. */
function stillPaidTwice(record: CloseRecord, refundedByCardCents: number): boolean {
  if (refundedByCardCents <= 0) return false;
  const resolution = readPaidTwiceResolution(record.reviewContext);
  return resolution === null || refundedByCardCents > resolution.refundedByCardCents;
}

/**
 * The card refunds closed as paid another way that Stripe ALSO refunded and
 * nobody has resolved, oldest close first. Read from the close's record and the
 * payment's own refund rows (`cardRefundSentAfterPaidAnotherWay`).
 *
 * STATED LIMIT: it reads every close ever made, which stays small - a close is
 * the treasurer's hand on a refund Stripe gave up on.
 */
export async function listCardRefundsPaidTwice(): Promise<CardRefundPaidTwiceRow[]> {
  const records = await prisma.manualRefundTask.findMany({
    where: CARD_REFUND_PAID_ANOTHER_WAY_TASK_WHERE,
    orderBy: { completedAt: "asc" },
    select: RECORD_SELECT,
  });
  const rows: CardRefundPaidTwiceRow[] = [];
  for (const record of records) {
    const operationId = paymentRecoveryOperationIdOfPaidAnotherWay(record);
    if (operationId === null) continue;
    const refundedByCardCents = refundedByCardAfterClose(record, operationId);
    if (!stillPaidTwice(record, refundedByCardCents)) continue;
    rows.push({
      operationId,
      bookingId: record.bookingId,
      bookingReference: formatBookingReference(record.bookingId),
      closedAt: (record.completedAt ?? new Date(0)).toISOString(),
      paidAnotherWayCents: record.amountCents ?? 0,
      refundedByCardCents,
    });
  }
  return rows;
}

/** A refusal with the status the route answers. Nothing is written. */
export class CardRefundPaidTwiceError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409,
  ) {
    super(message);
    this.name = "CardRefundPaidTwiceError";
  }
}

export interface ResolveCardRefundPaidTwiceInput {
  /** The card refund operation the close closed - the row's id on the list. */
  operationId: string;
  /** How it was sorted out with the member. Required. */
  note: string | null | undefined;
  /**
   * What the treasurer saw Stripe had refunded to the card when they chose
   * (#3924 round 8, concurrency). A further card refund since then is one they
   * never saw, so a Resolved against the old figure is refused with a 409 and
   * the page refreshes to show the new one.
   */
  expectedRefundedByCardCents: number;
  actingMemberId: string;
}

/** Mark one paid-twice row Resolved. See the module comment. */
export async function resolveCardRefundPaidTwice(
  input: ResolveCardRefundPaidTwiceInput,
): Promise<{ operationId: string; bookingId: string; refundedByCardCents: number }> {
  const note = normaliseManualPaymentNote(input.note);
  if (!note) {
    throw new CardRefundPaidTwiceError("Say how it was sorted out with the member - a note is required.", 400);
  }
  const where = { ...CARD_REFUND_PAID_ANOTHER_WAY_TASK_WHERE, occurrenceKey: { in: closeKeysOf(input.operationId) } };
  // #4210 round 3 (concurrency 3): its payment, immutable, to take that row first.
  const head = await prisma.manualRefundTask.findFirst({ where, select: { paymentId: true } });
  if (!head) throw new CardRefundPaidTwiceError("Card refund not found.", 404);
  return prisma.$transaction(async (tx) => {
    // Under the Payment row the failed-later writer holds: a refund failing
    // later and this Resolved are weighed in one order, each reading the other's write.
    if (head.paymentId) await lockPaymentForRefundedTotal(tx, head.paymentId);
    const record = await tx.manualRefundTask.findFirst({ where, select: { ...RECORD_SELECT, booking: { select: { memberId: true } } } });
    if (!record) throw new CardRefundPaidTwiceError("Card refund not found.", 404);
    const refundedByCardCents = refundedByCardAfterClose(record, input.operationId);
    if (!stillPaidTwice(record, refundedByCardCents)) {
      throw new CardRefundPaidTwiceError(
        "This card refund is no longer on the paid-twice list. The list has been refreshed.",
        409,
      );
    }
    if (refundedByCardCents !== input.expectedRefundedByCardCents) {
      throw new CardRefundPaidTwiceError(
        "Stripe's refund to the card changed since you opened this. The list has been refreshed: check the amount and mark it resolved again.",
        409,
      );
    }

    const resolution: PaidTwiceResolution = {
      resolvedAt: new Date().toISOString(),
      resolvedByMemberId: input.actingMemberId,
      note,
      refundedByCardCents,
    };
    // Guarded on the record as read: a second click finds the resolution it
    // wrote and claims nothing.
    const claimed = await tx.manualRefundTask.updateMany({
      where: {
        id: record.id,
        ...CARD_REFUND_PAID_ANOTHER_WAY_TASK_WHERE,
        reviewContext:
          record.reviewContext === null
            ? { equals: Prisma.DbNull }
            : { equals: record.reviewContext as Prisma.InputJsonValue },
      },
      // #4104 (A-F1): beside whatever else the record keeps - a close's
      // card-note cover, and (#4210) what it counted, stay.
      data: { reviewContext: { ...reviewContextObject(record.reviewContext), paidTwiceResolved: { ...resolution } } },
    });
    if (claimed.count === 0) {
      throw new CardRefundPaidTwiceError(
        "This row changed while you were resolving it. The list has been refreshed.",
        409,
      );
    }
    await createAuditLog(
      {
        action: "booking-payment.card-refund.paid-twice-resolved",
        memberId: input.actingMemberId,
        actorMemberId: input.actingMemberId,
        subjectMemberId: bookingOwner(record.booking).memberId,
        targetId: record.bookingId,
        entityType: "ManualRefundTask",
        entityId: record.id,
        category: "payment",
        severity: "important",
        outcome: "success",
        summary: "Card refund paid back twice marked resolved",
        details: note,
        metadata: {
          operationId: input.operationId,
          bookingId: record.bookingId,
          paymentId: record.payment?.id ?? null,
          manualRefundTaskId: record.id,
          paidAnotherWayCents: record.amountCents,
          refundedByCardCents,
        },
      },
      tx,
    );
    return { operationId: input.operationId, bookingId: record.bookingId, refundedByCardCents };
  });
}
