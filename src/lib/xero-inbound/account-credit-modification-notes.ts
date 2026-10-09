import { prisma } from "@/lib/prisma";
import { readModificationNoteWording } from "@/lib/xero-refund-method";
import { queuedReviewTaskId, UNPAID_ASK_BILLED_OFFSET_NOTE_SCOPE } from "@/lib/xero-review-task-key";
import { getJsonRecord } from "./amounts";

/**
 * The modification credit notes, of these, that moved no cash, so they must not
 * fold into `Payment.refundedAmountCents`. They are allocated against the
 * invoice like a refund's note, but no money left. Read from the note's own
 * outbound operation, which records the wording and scope it was built with:
 *
 * - #3809 (review M2): worded as account credit when raised (`INV-PAY-101`) -
 *   applied credit given back, or a review's share given back;
 * - #3954 (owner decision 10 Oct 2026): a reduction's invoice correction for the
 *   part of its unpaid-ask offset the primary invoice had billed
 *   (`UNPAID_ASK_BILLED_OFFSET_NOTE_SCOPE`) - money the member never paid.
 */
export async function noCashModificationNoteIds(creditNoteIds: string[]): Promise<Set<string>> {
  if (creditNoteIds.length === 0) return new Set();
  const operations = await prisma.xeroSyncOperation.findMany({
    where: { direction: "OUTBOUND", entityType: "CREDIT_NOTE", operationType: "CREATE", xeroObjectId: { in: creditNoteIds } },
    select: { xeroObjectId: true, requestPayload: true },
  });
  return new Set(
    operations
      .filter(
        (operation) =>
          readModificationNoteWording(getJsonRecord(operation.requestPayload)).refundMethod === "account-credit" ||
          queuedReviewTaskId(operation) === UNPAID_ASK_BILLED_OFFSET_NOTE_SCOPE,
      )
      .map((operation) => operation.xeroObjectId)
      .filter((id): id is string => id !== null),
  );
}
