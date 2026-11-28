import { asRecord, readString } from "@/lib/xero-json";

export const XERO_OUTBOX_ADMIN_CREDIT_DEDUCTION_CORRECTION_TYPE = "ADMIN_CREDIT_DEDUCTION_CORRECTION" as const;
export interface AdminCreditDeductionPayload {
  queueType: typeof XERO_OUTBOX_ADMIN_CREDIT_DEDUCTION_CORRECTION_TYPE;
  correctionId: string;
}
export function buildAdminCreditDeductionPayload(input: { correctionId: string }): AdminCreditDeductionPayload {
  return { queueType: XERO_OUTBOX_ADMIN_CREDIT_DEDUCTION_CORRECTION_TYPE, correctionId: input.correctionId };
}
export function readAdminCreditDeductionPayload(value: unknown): AdminCreditDeductionPayload | null {
  const row = asRecord(value);
  const correctionId = row && readString(row.correctionId);
  return row?.queueType === XERO_OUTBOX_ADMIN_CREDIT_DEDUCTION_CORRECTION_TYPE && correctionId
    ? buildAdminCreditDeductionPayload({ correctionId }) : null;
}
/** The one outbox operation that corrects Xero for this deduction. */
export function adminCreditDeductionOperationWhere(correctionId: string) {
  return { localModel: "AdminCreditDeductionCorrection", localId: correctionId, queueType: XERO_OUTBOX_ADMIN_CREDIT_DEDUCTION_CORRECTION_TYPE } as const;
}
/** Immutable identifiers keep a lost reply discoverable even if an officer renumbers the note. */
export function adminCreditDeductionReference(requestId: string, noteId: string): string {
  return `Credit deduction ${requestId} / ${noteId}`;
}
