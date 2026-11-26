/**
 * The outbox's one branch for an officer's manual credit in Xero: a grant's credit
 * note (#4431) and a deduction's correction of an existing note (#5241). Kept here
 * so the queue's dispatch chain stays one branch for both.
 */
import { XERO_OUTBOX_ADMIN_CREDIT_DEDUCTION_CORRECTION_TYPE, type AdminCreditDeductionPayload } from "@/lib/admin-credit-deduction-payload";
import { XERO_OUTBOX_ADMIN_GRANT_CREDIT_NOTE_TYPE, type AdminGrantCreditNotePayload } from "@/lib/admin-grant-credit-note-payload";
import { completeAdminCreditDeductionCorrection } from "@/lib/xero-admin-credit-deduction-correction";
import { createAdminGrantCreditNote } from "@/lib/xero-admin-grant-credit-note";
import type { XeroOperationClaim } from "@/lib/xero-operation-outcome-guard";

type AdminCreditQueuePayload = AdminGrantCreditNotePayload | AdminCreditDeductionPayload;

export function isAdminCreditQueuePayload(payload: { queueType?: unknown } | null | undefined): payload is AdminCreditQueuePayload {
  return payload?.queueType === XERO_OUTBOX_ADMIN_GRANT_CREDIT_NOTE_TYPE || payload?.queueType === XERO_OUTBOX_ADMIN_CREDIT_DEDUCTION_CORRECTION_TYPE;
}

export async function runAdminCreditQueueOperation(syncOperation: XeroOperationClaim, payload: AdminCreditQueuePayload): Promise<void> {
  if (payload.queueType === XERO_OUTBOX_ADMIN_CREDIT_DEDUCTION_CORRECTION_TYPE) {
    await completeAdminCreditDeductionCorrection({ syncOperation, payload });
  } else {
    await createAdminGrantCreditNote({ syncOperation, payload });
  }
}
