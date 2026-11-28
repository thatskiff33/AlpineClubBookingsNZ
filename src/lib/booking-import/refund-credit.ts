import "server-only";

import { ManualRefundTaskDirection, ManualRefundTaskStatus, type Prisma } from "@prisma/client";

import { isEffectiveModuleEnabled } from "@/lib/admin-modules";
import { createAuditLog } from "@/lib/audit";
import { importedRefundCreditRefusal } from "@/lib/booking-import/refund-credit-rule";
import { bookingOwner } from "@/lib/booking-owner";
import { lockBookingRowForOwnerRead } from "@/lib/booking-row-lock";
import type { ClubFormat } from "@/lib/club-format";
import { LOCK1_HOLDER_TRANSACTION_BUDGET } from "@/lib/db-transaction";
import { sendImportedRefundCreditedEmail } from "@/lib/email/booking";
import logger from "@/lib/logger";
import { ManualBookingPaymentError } from "@/lib/manual-booking-payment-error";
import { normaliseManualPaymentNote } from "@/lib/manual-subscription-payment";
import { withdrawCreditedHandBackDebt } from "@/lib/manual-refund-task-hand-back-journal";
import { settlementWriteRefusal } from "@/lib/manual-refund-task-settlement-refusal";
import { createCancellationCredit, lockMemberCreditLedger, requireMemberCreditRecipient } from "@/lib/member-credit";
import { resolveBookingDoorClock } from "@/lib/member-money/doors";
import { applyLocalRefundAllocation, lockPaymentForRefundedTotal } from "@/lib/payment-transactions";
import { prisma } from "@/lib/prisma";
import { readSupersededCaptureHeldBack } from "@/lib/superseded-capture-hold-back";
import { enqueueXeroAccountCreditNoteOperation, kickQueuedXeroOutboxOperationsIfConnected } from "@/lib/xero-operation-outbox";
import { isXeroConnected } from "@/lib/xero-token-store";

/**
 * #5005 child D (owner decision O1, 11 Nov 2026; `INV-PAY-044` as amended): GIVE A CANCELLED IMPORTED BOOKING'S
 * REFUND AS ACCOUNT CREDIT. Cancelling an imported booking raises the by-hand refund task every cash booking's
 * cancel raises; the officer then settles it one of two ways. "Mark paid back" (`resolveManualRefundTask`) records a
 * bank transfer. This records account credit instead, at the same amount, in one transaction:
 *
 * 1. `lock(1)`, the booking row, the task re-read and the shared rule (`refund-credit-rule.ts`); then the member's
 *    credit ledger and the Payment row (`INV-LOCK-002`: global, booking row, member credit, Payment row), as a
 *    cancellation hand-back's completion takes them;
 * 2. the task claimed OPEN -> COMPLETED with a status- and amount-guarded update, so it can never also be marked
 *    paid back, and a lost claim writes nothing;
 * 3. the refund allocated against the payment (`applyLocalRefundAllocation`) and the credit created by the one
 *    cancellation-credit writer (`createCancellationCredit`, which posts its booking ledger line and the CREDITED
 *    event), as a cancelled bank-transfer booking's credit is; the task then names that credit;
 * 4. the journal's refund debt for the task withdrawn (`withdrawCreditedHandBackDebt`), so the journal shows no bank
 *    refund the club will never pay. The credit itself is not in the journal until ledger M5, the same known gap
 *    as every cancelled bank-transfer booking's credit;
 * 5. on a club with the Xero module on, the account-credit note every account credit carries, queued in the same
 *    transaction so it commits with the credit (it needs no original invoice); none on a club without Xero.
 *
 * After commit: the Xero worker is nudged, and the member is emailed that their refund is now account credit. No
 * provider call is made inside the transaction. A COMPLETED task cannot be reopened (`INV-PAY-099`).
 */

const TASK_SELECT = {
  id: true, bookingId: true, paymentId: true, kind: true, occurrenceKey: true, partPaymentReviewPaymentId: true, reason: true,
  status: true, amountCents: true, raisedAmountCents: true,
  booking: {
    select: {
      memberId: true, lodgeId: true, checkIn: true, checkOut: true,
      member: { select: { email: true, firstName: true } },
      organisation: { select: { name: true, email: true } },
      importRow: { select: { status: true } },
      payment: { select: { id: true } },
    },
  },
} satisfies Prisma.ManualRefundTaskSelect;

export const IMPORTED_REFUND_CREDIT_STALE =
  "This refund changed while you were giving it as credit - refresh and try again.";

/** What giving the refund as credit did. */
export type ImportedRefundCredit = {
  taskId: string;
  bookingId: string;
  amountCents: number;
  memberCreditId: string;
  /** The queued Xero account-credit note, or null on a club without the Xero module. */
  xeroOperationId: string | null;
};

export async function giveImportedRefundAsCredit(
  input: {
    taskId: string;
    actingMemberId: string;
    /** The amount the officer's confirmation showed: any other is a stale screen. */
    expectedAmountCents: number;
    note: string | null;
  },
  format: ClubFormat,
): Promise<ImportedRefundCredit> {
  const note = normaliseManualPaymentNote(input.note);
  // `INV-LOCK-004`: the journal and the module state are read before the transaction opens.
  const { journal } = await resolveBookingDoorClock();
  const xeroModuleOn = await isEffectiveModuleEnabled("xeroIntegration");

  const outcome = await prisma.$transaction(async (tx) => {
    // The completion's order: a journal hand-back's Mark paid back takes this key first too, so the two buttons
    // are serialised and the second reads the task the first closed.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
    const head = await tx.manualRefundTask.findUnique({ where: { id: input.taskId }, select: { bookingId: true } });
    if (!head) throw new ManualBookingPaymentError("Refund task not found.", 404);
    await lockBookingRowForOwnerRead(tx, head.bookingId);
    const task = await tx.manualRefundTask.findUniqueOrThrow({ where: { id: input.taskId }, select: TASK_SELECT });
    const refusal = importedRefundCreditRefusal(task);
    if (refusal) throw new ManualBookingPaymentError(refusal, 409);
    const amountCents = task.amountCents!;
    if (amountCents !== input.expectedAmountCents) throw new ManualBookingPaymentError(IMPORTED_REFUND_CREDIT_STALE, 409);
    const paymentId = task.paymentId!;
    const memberId = requireMemberCreditRecipient(task.booking.memberId);

    await lockMemberCreditLedger(memberId, tx);
    await lockPaymentForRefundedTotal(tx, paymentId);
    const now = new Date();
    const claimed = await tx.manualRefundTask.updateMany({
      where: { id: task.id, status: ManualRefundTaskStatus.OPEN, amountCents },
      data: {
        status: ManualRefundTaskStatus.COMPLETED,
        completedByMemberId: input.actingMemberId,
        completedAt: now,
        note,
        settlementDirection: ManualRefundTaskDirection.REFUND_TO_MEMBER,
      },
    });
    if (claimed.count === 0) throw new ManualBookingPaymentError(IMPORTED_REFUND_CREDIT_STALE, 409);

    const heldBack = await readSupersededCaptureHeldBack(tx, paymentId);
    try {
      await applyLocalRefundAllocation({ paymentId, amountCents, store: tx, heldBackByTransaction: heldBack.byTransaction });
    } catch (error) {
      throw settlementWriteRefusal(error, null, heldBack.totalCents);
    }
    const memberCreditId = await createCancellationCredit(tx, memberId, amountCents, task.bookingId);
    await tx.manualRefundTask.update({ where: { id: task.id }, data: { settledAsCreditId: memberCreditId } });
    await withdrawCreditedHandBackDebt(tx, journal, { task, actingMemberId: input.actingMemberId });
    const xeroOperationId = xeroModuleOn
      ? (await enqueueXeroAccountCreditNoteOperation(paymentId, amountCents, { store: tx, createdByMemberId: input.actingMemberId, memberCreditId })).queueOperationId
      : null;
    await createAuditLog({
      action: "booking-payment.manual-refund-task.give-as-credit",
      memberId: input.actingMemberId, actorMemberId: input.actingMemberId, subjectMemberId: memberId,
      targetId: task.bookingId, entityType: "ManualRefundTask", entityId: task.id,
      category: "payment", severity: "important", outcome: "success",
      summary: "Cancelled imported booking's refund given as account credit",
      metadata: { taskId: task.id, bookingId: task.bookingId, paymentId, amountCents, memberCreditId, xeroNoteQueued: xeroOperationId !== null, note },
    }, tx);

    const owner = bookingOwner(task.booking);
    return {
      result: { taskId: task.id, bookingId: task.bookingId, amountCents, memberCreditId, xeroOperationId },
      email: { recipientMemberId: owner.memberId, email: owner.member.email, firstName: owner.member.firstName,
        checkIn: task.booking.checkIn, checkOut: task.booking.checkOut, lodgeId: task.booking.lodgeId },
    };
  }, LOCK1_HOLDER_TRANSACTION_BUDGET);

  const { result, email } = outcome;
  if (result.xeroOperationId && (await isXeroConnected())) {
    void kickQueuedXeroOutboxOperationsIfConnected({ limit: 1 }).catch((err) =>
      logger.error({ err, taskId: result.taskId }, "Failed to kick the Xero outbox after an imported refund was given as credit"));
  }
  // The credit is committed: a failed email is logged, never a reason to report the settlement as failed.
  await sendImportedRefundCreditedEmail({
    bookingId: result.bookingId, ...email, creditCents: result.amountCents, idempotencyKey: `imported-refund-credited:${result.taskId}`,
  }, format).catch((err) => logger.error({ err, taskId: result.taskId }, "Failed to email the member that their refund is account credit"));
  return result;
}
