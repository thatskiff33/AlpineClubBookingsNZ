import { CreditType, type Prisma } from "@prisma/client";
import { createAuditLog } from "@/lib/audit";
import { enqueueAdminGrantCreditNote } from "@/lib/admin-grant-credit-note";
import type { ClubFormat } from "@/lib/club-format";
import { formatAdjustmentAmount, MemberCreditValidationError } from "@/lib/policies/member-credit";

/**
 * #5190 PR 3 (`INV-MONEY-053`): a mid-season age-up credit the season invoice
 * could not take (it was paid, or owes less than the credit), as a positive
 * credit lot with its Xero note queued on the `membershipCancellationCredit`
 * mapping. The caller holds `lockMemberCreditLedger(memberId)` and has already
 * claimed the adjustment with a status-guarded write in this transaction, so a
 * second worker writes nothing. No second approver: the billing run's confirm
 * is the approval, as an opening-credit batch's is.
 */
export async function postAgeUpCreditLot(
  tx: Prisma.TransactionClient,
  input: { adjustmentId: string; memberId: string; amountCents: number; description: string; format: ClubFormat },
): Promise<{ id: string }> {
  if (!Number.isSafeInteger(input.amountCents) || input.amountCents <= 0) {
    throw new MemberCreditValidationError("An age-up credit must be a positive whole number of cents");
  }
  const credit = await tx.memberCredit.create({
    data: {
      memberId: input.memberId,
      amountCents: input.amountCents,
      type: CreditType.ADMIN_ADJUSTMENT,
      description: input.description,
    },
    select: { id: true },
  });
  await enqueueAdminGrantCreditNote(tx, {
    id: credit.id,
    amountCents: input.amountCents,
    mappingKey: "membershipCancellationCredit",
  });
  await createAuditLog(
    {
      action: "member.credit.age_up_credit",
      category: "payment",
      entityType: "MemberSubscriptionAgeUpAdjustment",
      entityId: input.adjustmentId,
      targetId: input.memberId,
      details: `Posted age-up credit ${credit.id} for adjustment ${input.adjustmentId}: ${formatAdjustmentAmount(input.amountCents, input.format)}. ${input.description}.`,
    },
    tx,
  );
  return credit;
}
