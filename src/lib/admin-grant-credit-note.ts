/**
 * A manual credit grant's Xero note, apart from the worker that creates it
 * (#4431). Approval enqueues here. A deduction and the spend allocator both
 * ask the same helper whether a free lot already has this operation.
 */
import type { Prisma } from "@prisma/client";
import {
  adminCreditGrantMappingKey,
  NOTED_CREDIT_DEDUCTION_MESSAGE,
  type AdminCreditGrantAccount,
} from "@/lib/admin-credit-grant-account";
import {
  XERO_OUTBOX_ADMIN_GRANT_CREDIT_NOTE_TYPE,
  type AdminGrantNoteMappingKey,
} from "@/lib/admin-grant-credit-note-payload";
import { MemberCreditValidationError } from "@/lib/policies/member-credit";
import { prisma } from "@/lib/prisma";
import { loadFreeCreditLots } from "@/lib/xero-applied-credit-lots";
import { XeroAppliedCreditOperationBusyError } from "@/lib/xero-applied-credit-operation-serialization";
import { ADMIN_GRANT_NOTE_AWAITING_RETRY_CODE } from "@/lib/xero-operation-error-codes";
import { scanSpacesWaitCode } from "@/lib/xero-operation-wait-spacing";
import { buildXeroIdempotencyKey, startXeroSyncOperation } from "@/lib/xero-sync";

/** `XeroObjectLink.role` for the note this patch raises. One role, one credit. */
export const ADMIN_GRANT_CREDIT_NOTE_ROLE = "ADMIN_GRANT_CREDIT_NOTE";

/** Same spacing as a refund note waiting to be resolved: five minutes. */
export const ADMIN_GRANT_NOTE_AWAITING_RETRY_RECHECK_MS = 5 * 60 * 1000;

const GRANT_NOTE_RETRY_MESSAGE =
  "Retry the admin grant credit note for this credit before allocating it. A new note would be a second note.";

/**
 * Leave a row returned to wait on a failed grant note until its recheck is
 * due. Every other row, a null code included, is scanned as before.
 */
export function scanSpacesAdminGrantNotesAwaitingRetry(now: Date) {
  return scanSpacesWaitCode(
    ADMIN_GRANT_NOTE_AWAITING_RETRY_CODE,
    ADMIN_GRANT_NOTE_AWAITING_RETRY_RECHECK_MS,
    now,
  );
}

/** A grant-note operation that has not been cancelled. Succeeded still counts. */
export function adminGrantCreditNoteOperationWhere(creditIds: readonly string[]) {
  return {
    localModel: "MemberCredit",
    localId: { in: [...creditIds] },
    queueType: XERO_OUTBOX_ADMIN_GRANT_CREDIT_NOTE_TYPE,
    status: { not: "CANCELLED" },
  } satisfies Prisma.XeroSyncOperationWhereInput;
}

/**
 * Refuse a deduction while any free lot already has a Xero note, or is waiting
 * for the note queued at approval. Legacy noteless credit has neither, so a
 * deduction of that balance still proceeds. Convergence write-downs are not
 * free lots (`loadFreeCreditLots` excludes them) and are not sent here.
 */
export async function assertDeductionLeavesNotedCreditUntouched(
  memberId: string,
  amountCents: number,
  db: Prisma.TransactionClient,
): Promise<void> {
  if (amountCents >= 0) return;
  const loaded = await loadFreeCreditLots(db, [memberId]);
  const free = loaded.get(memberId)?.lots ?? [];
  if (free.length === 0) return;
  if (free.some((lot) => lot.xeroCreditNoteId)) {
    throw new MemberCreditValidationError(NOTED_CREDIT_DEDUCTION_MESSAGE);
  }
  const queued = await db.xeroSyncOperation.findMany({
    where: adminGrantCreditNoteOperationWhere(free.map((lot) => lot.memberCreditId)),
    select: { id: true },
  });
  if (queued.length > 0) {
    throw new MemberCreditValidationError(NOTED_CREDIT_DEDUCTION_MESSAGE);
  }
}

export async function enqueueAdminGrantCreditNote(
  tx: Prisma.TransactionClient,
  credit: { id: string; amountCents: number; grantAccount: AdminCreditGrantAccount },
): Promise<void> {
  const mappingKey: AdminGrantNoteMappingKey = adminCreditGrantMappingKey(credit.grantAccount);
  const idempotencyKey = buildXeroIdempotencyKey(
    "member-credit",
    credit.id,
    "admin-grant-credit-note",
    credit.amountCents,
    mappingKey,
    "v1",
  );
  await startXeroSyncOperation({
    direction: "OUTBOUND",
    entityType: "CREDIT_NOTE",
    operationType: "CREATE",
    localModel: "MemberCredit",
    localId: credit.id,
    status: "PENDING",
    idempotencyKey,
    correlationKey: idempotencyKey,
    requestPayload: {
      queueType: XERO_OUTBOX_ADMIN_GRANT_CREDIT_NOTE_TYPE,
      amountCents: credit.amountCents,
      mappingKey,
      memberCreditId: credit.id,
    },
    store: tx,
  });
}

/**
 * A mint slice whose credit has a grant-note operation must not raise a
 * remainder note. Pending or running goes back to the queue with no wait
 * code. Failed or partial waits, spaced out, until that operation is retried.
 */
export async function assertMintSlicesWaitForAdminGrantNotes(
  mintSlices: readonly { memberCreditId: string }[],
): Promise<void> {
  const creditIds = [...new Set(mintSlices.map((slice) => slice.memberCreditId))];
  if (creditIds.length === 0) return;
  const operations = await prisma.xeroSyncOperation.findMany({
    where: adminGrantCreditNoteOperationWhere(creditIds),
    select: { status: true },
  });
  if (operations.length === 0) return;
  const blocked = operations.find((operation) => operation.status === "FAILED" || operation.status === "PARTIAL");
  if (blocked) {
    throw new XeroAppliedCreditOperationBusyError(
      GRANT_NOTE_RETRY_MESSAGE,
      blocked.status,
      ADMIN_GRANT_NOTE_AWAITING_RETRY_CODE,
    );
  }
  throw new XeroAppliedCreditOperationBusyError(
    "This credit's Xero note is still being raised. Allocation continues once that note is stamped.",
  );
}
