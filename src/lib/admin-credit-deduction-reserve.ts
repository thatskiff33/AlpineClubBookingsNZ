/** Reserve a manual deduction on the caller's member-credit ledger lock (#5241). */
import { CreditType, type MemberCredit, type Prisma } from "@prisma/client";
import { adminGrantCreditNoteOperationWhere } from "@/lib/admin-grant-credit-note";
import { planAdminCreditDeduction, type DeductionLot } from "@/lib/admin-credit-deduction-plan";
import { MemberCreditValidationError } from "@/lib/policies/member-credit";
import { loadFreeCreditLots } from "@/lib/xero-applied-credit-lots";
import { buildXeroIdempotencyKey, startXeroSyncOperation } from "@/lib/xero-sync";
import { createAuditLog } from "@/lib/audit";

/** The non-money links a reserve or restore row may carry beside its literal admin-adjustment fields. */
export interface CreditRowLinks {
  approvalRequestId?: string;
  xeroCreditNoteId?: string;
  outsideSpendConvergedAt?: Date;
}

export interface DeductionRequest {
  id: string;
  memberId: string;
  amountCents: number;
  description: string;
  requestedById: string;
  approvedById: string;
}

/**
 * Called only after the request's PENDING -> APPROVED guarded claim, in that
 * transaction and under lockMemberCreditLedger. Writes insert-only reserve rows;
 * the outbox alone corrects Xero, outside the transaction.
 */
export async function reserveNotedCreditDeduction(
  tx: Prisma.TransactionClient,
  request: DeductionRequest,
): Promise<{ credit: MemberCredit; correctionId: string | null }> {
  if (request.amountCents >= 0) throw new MemberCreditValidationError("Only deductions can be reserved.");
  const loaded = (await loadFreeCreditLots(tx, [request.memberId])).get(request.memberId);
  const free = loaded?.lots ?? [];
  const notelessIds = free.filter((lot) => !lot.xeroCreditNoteId).map((lot) => lot.memberCreditId);
  if (notelessIds.length > 0) {
    const queued = await tx.xeroSyncOperation.findFirst({
      where: adminGrantCreditNoteOperationWhere(notelessIds), select: { id: true },
    });
    if (queued) throw new MemberCreditValidationError("This credit's Xero note is still being raised; approve once its Xero note is raised.");
  }
  const [balance, cash, sources, slices] = await Promise.all([
    tx.memberCredit.aggregate({ where: { memberId: request.memberId }, _sum: { amountCents: true } }),
    tx.memberCredit.aggregate({ where: { memberId: request.memberId, xeroCashCreditId: { not: null } }, _sum: { amountCents: true } }),
    tx.memberCredit.findMany({ where: { id: { in: free.map((lot) => lot.memberCreditId) } }, select: { id: true, amountCents: true } }),
    tx.memberCreditNoteAllocation.findMany({ where: { memberCreditId: { in: free.map((lot) => lot.memberCreditId) } }, select: { memberCreditId: true } }),
  ]);
  const lots: DeductionLot[] = free.flatMap((lot) => {
    if (!lot.xeroCreditNoteId) return [];
    const source = sources.find((row) => row.id === lot.memberCreditId);
    if (!source) throw new MemberCreditValidationError("A credit lot changed while planning the deduction.");
    return [{
      memberCreditId: lot.memberCreditId,
      xeroCreditNoteId: lot.xeroCreditNoteId,
      remainingCents: lot.remainingCents,
      totalCents: source.amountCents,
      hasSlices: slices.some((slice) => slice.memberCreditId === lot.memberCreditId),
      writtenDownCents: loaded?.writtenDownByNote.get(lot.xeroCreditNoteId) ?? 0,
    }];
  });
  const plan = planAdminCreditDeduction(-request.amountCents, balance._sum.amountCents ?? 0, Math.max(0, cash._sum.amountCents ?? 0), lots);
  let firstCredit: MemberCredit | undefined;
  const writeCredit = async (amountCents: number, noteId?: string) => {
    // Links only, typed so the spread cannot carry money; the row is a literal ADMIN_ADJUSTMENT and
    // names no booking, so it has no booking-ledger leg to sync (INV-MONEY-035).
    const links: CreditRowLinks = {};
    if (!firstCredit) links.approvalRequestId = request.id;
    if (noteId) Object.assign(links, { xeroCreditNoteId: noteId, outsideSpendConvergedAt: new Date() });
    const row = await tx.memberCredit.create({ data: {
      ...links,
      memberId: request.memberId, amountCents: -amountCents, type: CreditType.ADMIN_ADJUSTMENT,
      description: request.description, requestedById: request.requestedById, approvedById: request.approvedById,
    } });
    firstCredit ??= row;
    return row;
  };
  if (plan.notelessCents > 0) await writeCredit(plan.notelessCents);
  let correctionId: string | null = null;
  if (plan.lines.length > 0) {
    const correction = await tx.adminCreditDeductionCorrection.create({ data: { requestId: request.id, memberId: request.memberId } });
    correctionId = correction.id;
    for (const line of plan.lines) {
      const row = await writeCredit(line.amountCents, line.xeroCreditNoteId);
      await tx.adminCreditDeductionCorrectionLine.create({ data: {
        correctionId, memberCreditId: row.id, sourceMemberCreditId: line.memberCreditId,
        xeroCreditNoteId: line.xeroCreditNoteId, amountCents: line.amountCents, mode: line.mode,
      } });
    }
    const key = buildXeroIdempotencyKey("admin-credit-deduction", request.id, "credit-note-correction", -request.amountCents, "v1");
    await startXeroSyncOperation({
      direction: "OUTBOUND", entityType: "CREDIT_NOTE", operationType: "UPDATE",
      localModel: "AdminCreditDeductionCorrection", localId: correctionId, status: "PENDING",
      idempotencyKey: key, correlationKey: key, createdByMemberId: request.approvedById,
      requestPayload: { queueType: "ADMIN_CREDIT_DEDUCTION_CORRECTION", correctionId }, store: tx,
    });
  }
  if (!firstCredit) throw new MemberCreditValidationError("The deduction has no available credit.");
  return { credit: firstCredit, correctionId };
}

/**
 * The officers' record of approving a deduction whose Xero correction is queued.
 * It declares no member disclosure: the member is told by the correction's
 * completion (`member.credit.deduction.xero_correction.complete`), once Xero agrees.
 */
export async function auditQueuedDeductionApproval(
  tx: Prisma.TransactionClient,
  input: { request: Pick<DeductionRequest, "id" | "memberId" | "requestedById" | "description">; adminId: string; creditId: string; amount: string; ipAddress?: string },
): Promise<void> {
  const { request } = input;
  await createAuditLog(
    {
      action: "member.credit.adjustment.approve",
      category: "payment",
      entityType: "AdminCreditAdjustmentRequest",
      entityId: request.id,
      memberId: input.adminId,
      targetId: request.memberId,
      details: `Xero correction queued. Approved admin credit adjustment ${request.id} as credit ${input.creditId}: ${input.amount}. Requested by ${request.requestedById}. Reason: ${request.description}.`,
      ipAddress: input.ipAddress,
    },
    tx,
  );
}
