import { CreditType } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { CreditRowLinks } from "@/lib/admin-credit-deduction-reserve";
import { lockMemberCreditLedger } from "@/lib/member-credit";
import { MemberCreditValidationError } from "@/lib/policies/member-credit";
import { assertXeroCreditNoteCorrectionUntouched } from "@/lib/xero-credit-note-correction";
import { adminCreditDeductionOperationWhere, adminCreditDeductionReference } from "@/lib/admin-credit-deduction-payload";
import { createAuditLog } from "@/lib/audit";
import logger from "@/lib/logger";

const RETRY = "This correction may already have changed Xero. Retry it; its reserved credit cannot be restored.";
const HELD_IN_XERO = "Xero already holds part of this correction, so its reserved credit cannot be restored. Retry it; if it cannot finish, void its correction invoice in Xero, then cancel.";
const XERO_UNREADABLE = "Xero could not be checked just now, so nothing was changed. Try cancelling again shortly.";
const RAN_MEANWHILE = "The Xero correction ran while it was being checked. Reload, then retry or cancel it.";
const CANCELLABLE = ["PENDING", "FAILED"];

/** A failed preflight can be cancelled; an ambiguous dispatched write can only be retried. */
export async function cancelAdminCreditDeductionCorrection(input: {
  memberId: string; correctionId: string; adminId: string; ipAddress?: string;
}): Promise<void> {
  const correction = await prisma.adminCreditDeductionCorrection.findUnique({
    where: { id: input.correctionId }, include: { lines: true, request: true },
  });
  if (!correction || correction.memberId !== input.memberId) throw new MemberCreditValidationError("Credit correction not found");
  if (correction.status !== "RESERVED") throw new MemberCreditValidationError("This credit correction has already ended");
  if (correction.providerMutationStartedAt) throw new MemberCreditValidationError(RETRY);
  // Read before Xero is asked. A worker that runs during the reads below changes this row, and
  // may by then have written to Xero and lifted its own fence, so the claim below demands the
  // row exactly as it was seen here.
  const seen = await prisma.xeroSyncOperation.findFirst({
    where: adminCreditDeductionOperationWhere(correction.id), select: { id: true, status: true, startedAt: true, updatedAt: true },
  });
  if (!seen) throw new MemberCreditValidationError("Credit correction operation not found");
  if (!CANCELLABLE.includes(seen.status)) throw new MemberCreditValidationError("The Xero correction is running; wait for it to finish, then retry");
  for (const line of correction.lines) {
    try {
      await assertXeroCreditNoteCorrectionUntouched({
        noteId: line.xeroCreditNoteId, mode: line.mode,
        reference: adminCreditDeductionReference(correction.requestId, line.xeroCreditNoteId),
      });
    } catch (error) {
      // Only Xero showing the correction's own work means "retry"; an outage must not send the
      // officer to the one action that performs the write they are trying to stop.
      const held = error instanceof Error && error.name === "XeroCreditNoteCorrectionRefusal" &&
        (error as { code?: unknown }).code === "CORRECTION_ALREADY_STARTED";
      if (!held) logger.warn({ err: error, correctionId: correction.id }, "Could not check Xero before cancelling a credit deduction correction");
      throw new MemberCreditValidationError(held ? HELD_IN_XERO : XERO_UNREADABLE);
    }
  }
  await prisma.$transaction(async (tx) => {
    await lockMemberCreditLedger(input.memberId, tx);
    const claim = await tx.xeroSyncOperation.updateMany({
      where: { id: seen.id, status: { in: CANCELLABLE }, startedAt: seen.startedAt, updatedAt: seen.updatedAt },
      data: { status: "CANCELLED", completedAt: new Date() },
    });
    if (claim.count !== 1) throw new MemberCreditValidationError(RAN_MEANWHILE);
    // The locked recheck: a worker still holding its fence since the read above is refused here.
    const cancelled = await tx.adminCreditDeductionCorrection.updateMany({
      where: { id: correction.id, status: "RESERVED", providerMutationStartedAt: null },
      data: { status: "CANCELLED", cancelledById: input.adminId, cancelledAt: new Date() },
    });
    if (cancelled.count !== 1) throw new MemberCreditValidationError(RETRY);
    const at = new Date();
    const notelessCents = -correction.request.amountCents - correction.lines.reduce((sum, line) => sum + line.amountCents, 0);
    // A literal ADMIN_ADJUSTMENT names no booking, so it has no booking-ledger leg to sync (INV-MONEY-035).
    const restore = (amountCents: number, noteId?: string) => {
      const links: CreditRowLinks = noteId === undefined ? {} : { xeroCreditNoteId: noteId, outsideSpendConvergedAt: at };
      return tx.memberCredit.create({ data: {
        ...links,
        memberId: input.memberId, amountCents, type: CreditType.ADMIN_ADJUSTMENT, approvedById: input.adminId,
        description: `Credit deduction cancelled: ${correction.request.description}`,
      } });
    };
    if (notelessCents > 0) await restore(notelessCents);
    for (const line of correction.lines) await restore(line.amountCents, line.xeroCreditNoteId);
    await createAuditLog({
      action: "member.credit.deduction.xero_correction.cancel", category: "payment",
      entityType: "AdminCreditAdjustmentRequest", entityId: correction.requestId,
      memberId: input.adminId, targetId: input.memberId, ipAddress: input.ipAddress,
      details: "Cancelled the untouched Xero correction and restored its reserved credit.",
    }, tx);
  });
}
