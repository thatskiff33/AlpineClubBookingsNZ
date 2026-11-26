import { prisma } from "@/lib/prisma";
import { lockMemberCreditLedger } from "@/lib/member-credit";
import { correctXeroCreditNote } from "@/lib/xero-credit-note-correction";
import { adminCreditDeductionReference, type AdminCreditDeductionPayload } from "@/lib/admin-credit-deduction-payload";
import { ownRunningClaim, type XeroOperationClaim } from "@/lib/xero-operation-outcome-guard";
import { completeXeroSyncOperation, failXeroSyncOperation, upsertXeroObjectLink } from "@/lib/xero-sync";
import { createAuditLog } from "@/lib/audit";
import { clubFormatValues } from "@/lib/club-format-server";
import { formatCents } from "@/lib/utils";

/** Provider work is outside transactions; each durable record uses the member's existing ledger key. */
export async function completeAdminCreditDeductionCorrection(input: {
  syncOperation: XeroOperationClaim;
  payload: AdminCreditDeductionPayload;
}): Promise<void> {
  const { syncOperation, payload } = input;
  try {
    const correction = await prisma.adminCreditDeductionCorrection.findUnique({
      where: { id: payload.correctionId }, include: { lines: true, request: true },
    });
    if (!correction) throw new Error("Credit deduction correction not found");
    if (correction.status === "CANCELLED") throw new Error("This credit deduction correction was cancelled");
    const operation = await prisma.xeroSyncOperation.findUnique({ where: { id: syncOperation.id } });
    if (!operation?.idempotencyKey) throw new Error("Credit correction has no durable idempotency key");
    if (operation.status !== "RUNNING" || operation.startedAt?.getTime() !== syncOperation.startedAt?.getTime()) return;
    const format = await clubFormatValues();
    for (const line of correction.lines) {
      if (line.completedAt) continue;
      const result = await correctXeroCreditNote({
        noteId: line.xeroCreditNoteId, cents: line.amountCents, mode: line.mode,
        reference: adminCreditDeductionReference(correction.requestId, line.xeroCreditNoteId),
        keyBase: operation.idempotencyKey,
        beforeMutation: async () => {
          await prisma.$transaction(async (tx) => {
            await lockMemberCreditLedger(correction.memberId, tx);
            const held = await tx.xeroSyncOperation.findFirst({ where: { id: syncOperation.id, ...ownRunningClaim(syncOperation) }, select: { id: true } });
            if (!held) throw new Error("Credit correction worker lost its claim; retry the correction");
            const marked = await tx.adminCreditDeductionCorrection.updateMany({
              where: { id: correction.id, status: "RESERVED" },
              data: { providerMutationStartedAt: new Date() },
            });
            if (marked.count !== 1) throw new Error("Credit correction is no longer reserved");
          });
        },
      });
      await prisma.$transaction(async (tx) => {
        await lockMemberCreditLedger(correction.memberId, tx);
        const current = await tx.adminCreditDeductionCorrection.findUnique({ where: { id: correction.id }, select: { status: true } });
        if (current?.status !== "RESERVED") throw new Error("Credit correction is no longer reserved");
        await tx.adminCreditDeductionCorrectionLine.update({ where: { id: line.id }, data: { ...result, completedAt: new Date() } });
      });
    }
    await prisma.$transaction(async (tx) => {
      await lockMemberCreditLedger(correction.memberId, tx);
      const completed = await tx.adminCreditDeductionCorrection.updateMany({
        where: { id: correction.id, status: "RESERVED", lines: { every: { completedAt: { not: null } } } },
        data: { status: "COMPLETED", completedAt: new Date() },
      });
      if (completed.count === 1) {
        const lines = await tx.adminCreditDeductionCorrectionLine.findMany({ where: { correctionId: correction.id } });
        for (const line of lines) {
          if (line.xeroInvoiceId) await upsertXeroObjectLink({
            localModel: "AdminCreditDeductionCorrection", localId: correction.id,
            xeroObjectType: "INVOICE", xeroObjectId: line.xeroInvoiceId,
            role: "CREDIT_DEDUCTION_CORRECTION",
          }, { store: tx });
        }
        await createAuditLog({
          action: "member.credit.deduction.xero_correction.complete", category: "payment",
          entityType: "AdminCreditAdjustmentRequest", entityId: correction.requestId,
          targetId: correction.memberId, memberId: correction.request.reviewedById ?? undefined,
          details: "Approved credit deduction completed in Xero.",
          memberDisclosure: { visibility: "member-facing", text: `Credit of ${formatCents(Math.abs(correction.request.amountCents), format)} deducted from your account. Reason: ${correction.request.description}` },
        }, tx);
      }
      await completeXeroSyncOperation(syncOperation, {}, { store: tx });
    });
  } catch (error) {
    await failXeroSyncOperation(syncOperation, error);
    throw error;
  }
}
