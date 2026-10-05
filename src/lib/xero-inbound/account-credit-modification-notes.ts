import { prisma } from "@/lib/prisma";
import { readModificationNoteWording } from "@/lib/xero-refund-method";
import { getJsonRecord } from "./amounts";

/**
 * #3809 (review M2): the modification credit notes, of these, that moved no
 * cash - worded as account credit when they were raised (`INV-PAY-101`): applied
 * credit given back, or a review's share given back. They are allocated
 * against the invoice like a refund's note, but no money left, so they must
 * not fold into `Payment.refundedAmountCents`. Read from the note's own
 * outbound operation, which records the wording it was built with.
 */
export async function accountCreditModificationNoteIds(creditNoteIds: string[]): Promise<Set<string>> {
  if (creditNoteIds.length === 0) return new Set();
  const operations = await prisma.xeroSyncOperation.findMany({
    where: { direction: "OUTBOUND", entityType: "CREDIT_NOTE", operationType: "CREATE", xeroObjectId: { in: creditNoteIds } },
    select: { xeroObjectId: true, requestPayload: true },
  });
  return new Set(
    operations
      .filter((operation) => readModificationNoteWording(getJsonRecord(operation.requestPayload)).refundMethod === "account-credit")
      .map((operation) => operation.xeroObjectId)
      .filter((id): id is string => id !== null),
  );
}
