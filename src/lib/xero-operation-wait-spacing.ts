import type { Prisma } from "@prisma/client";

/**
 * #4692 review (`INV-SSOT`): THE scan filter for a Xero operation returned to
 * PENDING to wait, under a code naming the wait, with its `createdAt`
 * unchanged. Left out of the oldest-first scan until its recheck is due, so it
 * does not take the head of every kick; every other row - a null code
 * included, which `not` alone would drop - is scanned as before. One spelling
 * for each wait the outbox and the retry drain space out: a billed-offset note
 * waiting for its own note (`outboxScanLeavesAwaitingOwnNote`), a waiting
 * receipt (`outboxScanSpacesWaitingReceipts`) and a refund note held by an
 * unrecorded one (`scanSpacesRefundNotesAwaitingResolve`). The outbox scan
 * also spaces an admin grant note waiting to be retried
 * (`scanSpacesAdminGrantNotesAwaitingRetry`).
 */
export function scanSpacesWaitCode(code: string, recheckMs: number, now: Date) {
  return {
    OR: [
      { lastErrorCode: null },
      { lastErrorCode: { not: code } },
      { updatedAt: { lte: new Date(now.getTime() - recheckMs) } },
    ],
  } satisfies Prisma.XeroSyncOperationWhereInput;
}
