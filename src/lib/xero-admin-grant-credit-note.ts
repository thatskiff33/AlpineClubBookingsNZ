/**
 * Creates the Xero credit note for one approved manual grant and stamps that
 * credit row (#4431). The outbox calls this. Approval only queues the row.
 */
import { CreditType } from "@prisma/client";
import { CreditNote, LineAmountTypes } from "xero-node";
import { ADMIN_GRANT_CREDIT_NOTE_ROLE } from "@/lib/admin-grant-credit-note";
import type { AdminGrantCreditNotePayload } from "@/lib/admin-grant-credit-note-payload";
import { readClubTimeZoneOutsideRequest } from "@/lib/club-time-zone-runtime";
import { prisma } from "@/lib/prisma";
import { callXeroApi, getAuthenticatedXeroClient } from "@/lib/xero-api-client";
import { codeMintLine, mintLineItems } from "@/lib/xero-applied-credit-mint-accounts";
import { findOrCreateXeroContact, retryXeroWriteWithContactRepair } from "@/lib/xero-contacts";
import { getResolvedAccountMappingWithFallback } from "@/lib/xero-mappings";
import type { XeroOperationClaim } from "@/lib/xero-operation-outcome-guard";
import { xeroDocumentDateForClubToday } from "@/lib/xero-provider-dates";
import { completeXeroSyncOperation, failXeroSyncOperation, upsertXeroObjectLink } from "@/lib/xero-sync";

/**
 * Stamp this credit with this note, and no other row. A second note id does
 * not overwrite. The same id is success, so a replay after a crash between
 * the stamp and the link finishes the link.
 */
async function stampAdminGrantCreditNote(
  creditId: string,
  amountCents: number,
  noteId: string,
): Promise<void> {
  const stamped = await prisma.memberCredit.updateMany({
    where: {
      id: creditId,
      type: CreditType.ADMIN_ADJUSTMENT,
      amountCents,
      xeroCreditNoteId: null,
    },
    data: { xeroCreditNoteId: noteId },
  });
  if (stamped.count === 1) return;
  const row = await prisma.memberCredit.findUnique({
    where: { id: creditId },
    select: { type: true, amountCents: true, xeroCreditNoteId: true },
  });
  if (
    row?.type === CreditType.ADMIN_ADJUSTMENT &&
    row.amountCents === amountCents &&
    row.xeroCreditNoteId === noteId
  ) {
    return;
  }
  throw new Error("This credit already has a different Xero credit note, so the grant note was not stamped.");
}

async function finishGrantNote(
  claim: XeroOperationClaim,
  creditId: string,
  noteId: string,
  noteNumber: string | null,
): Promise<void> {
  await upsertXeroObjectLink({
    localModel: "MemberCredit",
    localId: creditId,
    xeroObjectType: "CREDIT_NOTE",
    xeroObjectId: noteId,
    xeroObjectNumber: noteNumber,
    role: ADMIN_GRANT_CREDIT_NOTE_ROLE,
  });
  await completeXeroSyncOperation(claim, {
    xeroObjectType: "CREDIT_NOTE",
    xeroObjectId: noteId,
    xeroObjectNumber: noteNumber,
    extraLinks: [
      {
        localModel: "MemberCredit",
        localId: creditId,
        xeroObjectType: "CREDIT_NOTE",
        xeroObjectId: noteId,
        xeroObjectNumber: noteNumber,
        role: ADMIN_GRANT_CREDIT_NOTE_ROLE,
      },
    ],
  });
}

export async function createAdminGrantCreditNote(input: {
  syncOperation: XeroOperationClaim;
  payload: AdminGrantCreditNotePayload;
}): Promise<void> {
  const { syncOperation, payload } = input;
  try {
    const credit = await prisma.memberCredit.findUnique({
      where: { id: payload.memberCreditId },
      select: {
        id: true,
        memberId: true,
        amountCents: true,
        type: true,
        description: true,
      },
    });
    if (
      !credit ||
      credit.type !== CreditType.ADMIN_ADJUSTMENT ||
      credit.amountCents !== payload.amountCents ||
      credit.amountCents <= 0
    ) {
      throw new Error("Admin grant credit note does not match a positive admin adjustment for that amount.");
    }

    const operation = await prisma.xeroSyncOperation.findUnique({
      where: { id: syncOperation.id },
      select: { idempotencyKey: true, createdByMemberId: true },
    });
    if (!operation?.idempotencyKey) {
      throw new Error("Admin grant credit note has no idempotency key.");
    }

    // The member the credit belongs to now, not an id frozen when it was approved.
    const contactId = await findOrCreateXeroContact(credit.memberId, {
      createdByMemberId: operation.createdByMemberId ?? undefined,
    });

    const existing = await prisma.xeroObjectLink.findFirst({
      where: {
        localModel: "MemberCredit",
        localId: credit.id,
        xeroObjectType: "CREDIT_NOTE",
        role: ADMIN_GRANT_CREDIT_NOTE_ROLE,
        active: true,
      },
      select: { xeroObjectId: true, xeroObjectNumber: true },
    });
    if (existing?.xeroObjectId) {
      await stampAdminGrantCreditNote(credit.id, payload.amountCents, existing.xeroObjectId);
      await finishGrantNote(syncOperation, credit.id, existing.xeroObjectId, existing.xeroObjectNumber);
      return;
    }

    const mapping = await getResolvedAccountMappingWithFallback(payload.mappingKey);
    const description = `Account credit granted: ${credit.description}`;
    const lineItems = mintLineItems([codeMintLine(mapping, payload.amountCents)], description);
    const noteDate = xeroDocumentDateForClubToday(await readClubTimeZoneOutsideRequest());
    const reference = `Admin credit ${credit.id.slice(0, 8)}`;
    const buildCreditNote = (resolvedContactId: string): CreditNote => ({
      type: CreditNote.TypeEnum.ACCRECCREDIT,
      contact: { contactID: resolvedContactId },
      date: noteDate,
      lineAmountTypes: LineAmountTypes.Inclusive,
      lineItems,
      reference,
      status: CreditNote.StatusEnum.AUTHORISED,
    });

    const { xero, tenantId } = await getAuthenticatedXeroClient();
    const response = await retryXeroWriteWithContactRepair({
      memberId: credit.memberId,
      currentContactId: contactId,
      workflow: "createAdminGrantCreditNote",
      operationId: syncOperation.id,
      createdByMemberId: operation.createdByMemberId ?? undefined,
      buildRequestPayload: (resolvedContactId) => ({ creditNotes: [buildCreditNote(resolvedContactId)] }),
      run: ({ contactId: resolvedContactId }) =>
        callXeroApi(
          () =>
            xero.accountingApi.createCreditNotes(
              tenantId,
              { creditNotes: [buildCreditNote(resolvedContactId)] },
              undefined,
              undefined,
              operation.idempotencyKey ?? undefined,
            ),
          {
            operation: "createCreditNotes",
            resourceType: "CREDIT_NOTE",
            workflow: "createAdminGrantCreditNote",
            context: `createCreditNotes(admin grant ${credit.id})`,
          },
        ),
    });

    const created = response.body.creditNotes?.[0];
    if (!created?.creditNoteID) {
      throw new Error("Xero did not return a credit note for this admin grant.");
    }
    await stampAdminGrantCreditNote(credit.id, payload.amountCents, created.creditNoteID);
    await finishGrantNote(
      syncOperation,
      credit.id,
      created.creditNoteID,
      created.creditNoteNumber ?? null,
    );
  } catch (error) {
    await failXeroSyncOperation(syncOperation, error);
    throw error;
  }
}
