/**
 * The outbox's dispatch for the two queue types whose work ends in a credit
 * note for a member's credit: an approved admin grant's note (#4431) and a
 * mid-season age-up credit (#5190 PR 3). One seam, so the outbox's dispatch
 * chain (a file past its length ceiling, #4926) routes both through one arm.
 */
import type { AdminGrantCreditNotePayload } from "@/lib/admin-grant-credit-note-payload";
import { XERO_OUTBOX_ADMIN_GRANT_CREDIT_NOTE_TYPE } from "@/lib/admin-grant-credit-note-payload";
import { scanSpacesAdminGrantNotesAwaitingRetry } from "@/lib/admin-grant-credit-note";
import type { AgeUpCreditPayload } from "@/lib/age-up-credit-payload";
import { XERO_OUTBOX_AGE_UP_CREDIT_TYPE } from "@/lib/age-up-credit-payload";
import { createAgeUpCredit, scanSpacesAgeUpCreditsAwaitingSeasonInvoice } from "@/lib/subscription-age-up-credit";
import { createAdminGrantCreditNote } from "@/lib/xero-admin-grant-credit-note";
import type { XeroOperationClaim } from "@/lib/xero-operation-outcome-guard";

type CreditLotPayload = AdminGrantCreditNotePayload | AgeUpCreditPayload;

export function isCreditLotOutboxPayload(payload: { queueType: string } | null): payload is CreditLotPayload {
  return payload?.queueType === XERO_OUTBOX_ADMIN_GRANT_CREDIT_NOTE_TYPE || payload?.queueType === XERO_OUTBOX_AGE_UP_CREDIT_TYPE;
}

export async function runCreditLotOutboxOperation(
  payload: CreditLotPayload,
  syncOperation: XeroOperationClaim,
  createdByMemberId: string | null,
): Promise<void> {
  if (payload.queueType === XERO_OUTBOX_AGE_UP_CREDIT_TYPE) {
    await createAgeUpCredit({ syncOperation, payload, createdByMemberId: createdByMemberId ?? undefined });
    return;
  }
  await createAdminGrantCreditNote({ syncOperation, payload });
}

/** Both queue types' waits, spaced out by the outbox scan (`scanSpacesWaitCode`). */
export function scanSpacesCreditLotWaits(now: Date) {
  return { AND: [scanSpacesAdminGrantNotesAwaitingRetry(now), scanSpacesAgeUpCreditsAwaitingSeasonInvoice(now)] };
}
