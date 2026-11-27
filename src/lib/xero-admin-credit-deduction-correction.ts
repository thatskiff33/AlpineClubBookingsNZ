import { prisma } from "@/lib/prisma";
import { lockMemberCreditLedger } from "@/lib/member-credit";
import { correctXeroCreditNote } from "@/lib/xero-credit-note-correction";
import { adminCreditDeductionReference, type AdminCreditDeductionPayload } from "@/lib/admin-credit-deduction-payload";
import { creditDeductedDisclosureText } from "@/lib/admin-credit-deduction-reserve";
import { ownRunningClaim, type XeroOperationClaim } from "@/lib/xero-operation-outcome-guard";
import { completeXeroSyncOperation, failXeroSyncOperation, upsertXeroObjectLink } from "@/lib/xero-sync";
import { createAuditLog } from "@/lib/audit";
import { clubFormatValues } from "@/lib/club-format-server";
import { getXeroErrorStatusCode } from "@/lib/xero-error-shape";

/**
 * The fence says "a write may have landed without a reply". Lift it only when this
 * run ended on a definite answer and no line has completed: Xero refused a request
 * outright (a 4xx other than a timeout or rate limit), a call was refused before
 * anything was sent (`preHttp`), or Xero's own state refused the correction before
 * this run wrote anything. Otherwise a correction that can never finish could never
 * be cancelled either. Cancel still reads Xero itself before restoring any cents,
 * and refuses if this operation ran since it looked.
 */
async function releaseFenceAfterRefusal(correctionId: string, error: unknown, wroteThisRun: boolean): Promise<void> {
  const status = getXeroErrorStatusCode(error);
  const refusedByXero = status !== undefined && status >= 400 && status <= 499 && status !== 408 && status !== 429;
  const neverSent = (error as { preHttp?: unknown } | null)?.preHttp === true;
  const refusedOnRead = error instanceof Error && error.name === "XeroCreditNoteCorrectionRefusal" && !wroteThisRun;
  if (!refusedByXero && !neverSent && !refusedOnRead) return;
  await prisma.adminCreditDeductionCorrection.updateMany({
    where: { id: correctionId, status: "RESERVED", providerMutationStartedAt: { not: null }, lines: { none: { completedAt: { not: null } } } },
    data: { providerMutationStartedAt: null },
  }).catch(() => undefined);
}

/** Provider work is outside transactions; each durable record uses the member's existing ledger key. */
export async function completeAdminCreditDeductionCorrection(input: {
  syncOperation: XeroOperationClaim;
  payload: AdminCreditDeductionPayload;
}): Promise<void> {
  const { syncOperation, payload } = input;
  let completed: Awaited<ReturnType<typeof completeXeroSyncOperation>> = null;
  let wroteThisRun = false;
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
          wroteThisRun = true;
        },
      });
      await prisma.$transaction(async (tx) => {
        await lockMemberCreditLedger(correction.memberId, tx);
        const current = await tx.adminCreditDeductionCorrection.findUnique({ where: { id: correction.id }, select: { status: true } });
        if (current?.status !== "RESERVED") throw new Error("Credit correction is no longer reserved");
        await tx.adminCreditDeductionCorrectionLine.update({ where: { id: line.id }, data: { ...result, completedAt: new Date() } });
      });
    }
    completed = await prisma.$transaction(async (tx) => {
      await lockMemberCreditLedger(correction.memberId, tx);
      const claimed = await tx.adminCreditDeductionCorrection.updateMany({
        where: { id: correction.id, status: "RESERVED", lines: { every: { completedAt: { not: null } } } },
        data: { status: "COMPLETED", completedAt: new Date() },
      });
      if (claimed.count === 1) {
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
          memberDisclosure: { visibility: "member-facing", text: creditDeductedDisclosureText(correction.request, format) },
        }, tx);
      }
      return completeXeroSyncOperation(syncOperation, {}, { store: tx });
    });
  } catch (error) {
    await releaseFenceAfterRefusal(payload.correctionId, error, wroteThisRun);
    await failXeroSyncOperation(syncOperation, error);
    throw error;
  }
  // #4374 (INV-INT-029): a success on a row already resolved in Xero alerts after this commit, not inside it.
  await completed?.deferredPostCommit?.();
}
