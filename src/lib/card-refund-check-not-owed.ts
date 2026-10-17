import "server-only";

import { PaymentRecoveryOperationStatus, type Prisma } from "@prisma/client";

import { createAuditLog } from "@/lib/audit";
import { bookingOwner } from "@/lib/booking-owner";
import { normaliseManualPaymentNote } from "@/lib/manual-subscription-payment";
import { CARD_REFUND_OPERATION_WHERE, paidAnotherWayCheckOf } from "@/lib/open-card-refund-owed";
import { isPaymentRecoveryOperationExhausted, PAYMENT_RECOVERY_EXHAUSTED_WHERE } from "@/lib/payment-recovery-constants";
import { prisma } from "@/lib/prisma";

/**
 * #4210 round 3 (`INV-PAY-136`, UX 2): A CHECK ROW AN OFFICER FOUND NOT OWED.
 *
 * When Stripe fails a card refund after its row was closed "Paid another way",
 * and the close may not have paid it back - a part close's given-up share, a
 * resolved paid-twice row's refund, or a close that kept no record of what it
 * counted - the failed-later writer raises a dead row for an officer to check
 * (`PaidAnotherWayCheck` on its plan). It is never sent. If the member is owed
 * it, the officer pays them and closes it "Paid another way". If they are not,
 * this closes it as checked - not owed: the row leaves "Refunds owed" and Net
 * Collected, and the officer's note is audited (`payment`). It moves no money,
 * writes no ledger line and touches no Xero - nothing was paid.
 *
 * Only a check row, and only while it is dead. Gated `finance:edit` by its
 * route, as the "Paid another way" close is.
 *
 * ONE WRITE, STATUS-GUARDED, NO LOCK: the row moves to `SUCCEEDED` by an
 * `updateMany` on the plan, status and attempts it was read with, and the
 * audit row commits with it. It changes no refunded total and no refund row,
 * and the failed-later writer counts a check row against its close whatever
 * its status, so it joins no lock cohort. A "Paid another way" close of the
 * same row claims on the same dead status, so one of the two wins and the
 * other is told; a failed-later re-plan compares the status it read, so it
 * loses to this and is retried.
 */
export const CHECKED_NOT_OWED_MARKER = "Closed by an officer: checked - not owed (#4210)";

export class CardRefundCheckNotOwedError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409,
  ) {
    super(message);
    this.name = "CardRefundCheckNotOwedError";
  }
}

export interface CardRefundCheckNotOwedInput {
  operationId: string;
  /** Why the member is not owed it. Required. */
  note: string | null | undefined;
  actingMemberId: string;
}

/** Close one check row as checked - not owed. See the module comment. */
export async function closeCardRefundCheckNotOwed(
  input: CardRefundCheckNotOwedInput,
): Promise<{ operationId: string; bookingId: string; amountCents: number }> {
  const note = normaliseManualPaymentNote(input.note);
  if (!note) {
    throw new CardRefundCheckNotOwedError("Say why the member is not owed it - a note is required.", 400);
  }
  return prisma.$transaction(async (tx) => {
    const operation = await tx.paymentRecoveryOperation.findUnique({
      where: { id: input.operationId },
      select: { id: true, type: true, status: true, attempts: true, bookingId: true, paymentId: true, amountCents: true, allocationPlan: true },
    });
    if (!operation) throw new CardRefundCheckNotOwedError("Card refund not found.", 404);
    const check = paidAnotherWayCheckOf(operation);
    if (check === null) {
      throw new CardRefundCheckNotOwedError(
        "This card refund was not raised for a check, so it cannot be closed as not owed. If the member was paid back another way, close it as paid another way.",
        409,
      );
    }
    // Dead by the one rule: a check is raised dead, and a "Paid another way" close needs it dead too.
    if (!isPaymentRecoveryOperationExhausted(operation)) {
      throw new CardRefundCheckNotOwedError(
        operation.status === PaymentRecoveryOperationStatus.SUCCEEDED ? "This card refund has already been closed." : "This card refund is still being retried, so it cannot be closed yet.",
        409,
      );
    }
    const claimed = await tx.paymentRecoveryOperation.updateMany({
      where: {
        id: operation.id,
        ...CARD_REFUND_OPERATION_WHERE,
        AND: [PAYMENT_RECOVERY_EXHAUSTED_WHERE, { status: operation.status, attempts: operation.attempts }],
        allocationPlan: { equals: operation.allocationPlan as Prisma.InputJsonValue },
      },
      data: {
        status: PaymentRecoveryOperationStatus.SUCCEEDED,
        succeededAt: new Date(),
        nextRetryAt: null,
        processingStartedAt: null,
        lastError: CHECKED_NOT_OWED_MARKER,
      },
    });
    if (claimed.count !== 1) {
      throw new CardRefundCheckNotOwedError(
        operation.status === PaymentRecoveryOperationStatus.SUCCEEDED
          ? "This card refund has already been closed."
          : "This card refund changed while you were closing it - refresh and try again.",
        409,
      );
    }
    const booking = await tx.booking.findUnique({ where: { id: operation.bookingId }, select: { memberId: true } });
    await createAuditLog(
      {
        action: "booking-payment.card-refund.checked-not-owed",
        memberId: input.actingMemberId,
        actorMemberId: input.actingMemberId,
        ...(booking ? { subjectMemberId: bookingOwner(booking).memberId } : {}),
        targetId: operation.bookingId,
        entityType: "PaymentRecoveryOperation",
        entityId: operation.id,
        category: "payment",
        severity: "important",
        outcome: "success",
        summary: "Card refund raised for a check after a \"Paid another way\" close closed as checked - not owed",
        details: note,
        metadata: {
          operationId: operation.id,
          bookingId: operation.bookingId,
          paymentId: operation.paymentId,
          amountCents: operation.amountCents,
          checkReason: check.reason,
          closedOperationId: check.closedOperationId,
        },
      },
      tx,
    );
    return { operationId: operation.id, bookingId: operation.bookingId, amountCents: operation.amountCents };
  });
}
