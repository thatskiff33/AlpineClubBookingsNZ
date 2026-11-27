import { CreditType } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { CreditRowLinks } from "@/lib/admin-credit-deduction-reserve";
import { lockMemberCreditLedger } from "@/lib/member-credit";
import { MemberCreditValidationError } from "@/lib/policies/member-credit";
import { assertXeroCreditNoteCorrectionUntouched } from "@/lib/xero-credit-note-correction";
import { adminCreditDeductionReference, XERO_OUTBOX_ADMIN_CREDIT_DEDUCTION_CORRECTION_TYPE } from "@/lib/admin-credit-deduction-payload";
import { createAuditLog } from "@/lib/audit";

const RETRY = "This correction may already have changed Xero. Retry it; its reserved credit cannot be restored.";
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
  for (const line of correction.lines) {
    try {
      await assertXeroCreditNoteCorrectionUntouched({ noteId: line.xeroCreditNoteId, reference: adminCreditDeductionReference(correction.requestId, line.xeroCreditNoteId) });
    } catch {
      throw new MemberCreditValidationError(RETRY);
    }
  }
  await prisma.$transaction(async (tx) => {
    await lockMemberCreditLedger(input.memberId, tx);
    const operation = await tx.xeroSyncOperation.findFirst({
      where: { localModel: "AdminCreditDeductionCorrection", localId: correction.id, queueType: XERO_OUTBOX_ADMIN_CREDIT_DEDUCTION_CORRECTION_TYPE },
    });
    if (!operation) throw new MemberCreditValidationError("Credit correction operation not found");
    const claim = await tx.xeroSyncOperation.updateMany({
      where: { id: operation.id, status: { in: ["PENDING", "FAILED"] } },
      data: { status: "CANCELLED", completedAt: new Date() },
    });
    if (claim.count !== 1) throw new MemberCreditValidationError("The Xero correction is running; wait for it to finish, then retry");
    // The one locked recheck: a worker that reached Xero during the read above set the fence.
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
