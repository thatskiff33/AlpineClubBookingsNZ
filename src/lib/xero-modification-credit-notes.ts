/**
 * Modification credit notes for negative booking modifications.
 *
 * When a booking modification reduces the total (guests removed, shorter
 * stay, rate change downward), `createXeroCreditNoteForModification`
 * creates a credit note for the reduction and allocates it against the
 * original invoice when possible.
 */

import { CreditNote, LineAmountTypes, type LineItem } from "xero-node";
import { prisma } from "./prisma";
import { bookingOwner } from "@/lib/booking-owner";
import { buildXeroInvoiceUrl } from "@/lib/xero-links";
import {
  buildXeroIdempotencyKey,
  completeXeroSyncOperation,
  failXeroSyncOperation,
  sanitizeForJson,
  startXeroSyncOperation,
} from "@/lib/xero-sync";
import {
  callXeroApi,
  getAuthenticatedXeroClient,
} from "./xero-api-client";
import { getResolvedAccountMapping } from "./xero-mappings";
import { retryXeroWriteWithContactRepair } from "./xero-contacts";
import {
  findOrCreateXeroContactForInvoicedParty,
  invoicedPartyContactRepair,
} from "@/lib/organisation-xero-contacts";
import { readClubTimeZoneOutsideRequest } from "@/lib/club-time-zone-runtime";
import { xeroDocumentDateForClubToday } from "@/lib/xero-provider-dates";
import { buildSyntheticAllocationId } from "./xero-invoice-helpers";
import {
  buildRefundDocumentDescription,
  buildRefundDocumentReference,
  type RefundMethod,
} from "@/lib/xero-refund-method";
import { resolveModificationDocumentLineItems } from "@/lib/xero-modification-line-items";

export async function createXeroCreditNoteForModification(params: {
  bookingId: string;
  refundAmountCents: number;
  bookingModificationId?: string;
  createdByMemberId?: string;
  repairExistingLink?: boolean;
  syncOperationId?: string;
  /**
   * How the reduction went back to the member (`INV-PAY-101`, #3529) — the
   * wording on the note. This note is allocated against the original invoice
   * rather than settled by a payment, so the method changes no account here;
   * it is what the treasurer reads. Absent on rows queued before the field
   * existed, which were all card refunds by this builder's own history.
   */
  refundMethod?: RefundMethod;
}): Promise<string | null> {
  const {
    bookingId,
    refundAmountCents,
    bookingModificationId,
    createdByMemberId,
    repairExistingLink,
    syncOperationId,
  } = params;
  const refundMethod: RefundMethod = params.refundMethod ?? "card";

  if (refundAmountCents <= 0) {
    if (syncOperationId) {
      await completeXeroSyncOperation(syncOperationId, {
        responsePayload: {
          skipped: true,
          reason: "Refund amount is zero or negative.",
        },
      });
    }
    return null;
  }

  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
    // #3369: the owner may be an Organisation; bookingOwner() reads both.
    include: { payment: true, member: true, organisation: { select: { name: true, email: true } } },
  });

  if (!booking?.payment?.xeroInvoiceId) {
    if (syncOperationId) {
      await completeXeroSyncOperation(syncOperationId, {
        responsePayload: {
          skipped: true,
          reason: "No original Xero invoice exists for this booking.",
        },
      });
    }
    return null;
  }
  const originalInvoiceId = booking.payment.xeroInvoiceId;

  const { xero, tenantId } = await getAuthenticatedXeroClient();
  // The INVOICED PARTY, not the booking's member (#3368; #3367's leftover).
  // A modification credit note on a school booking belongs against the
  // school's own Xero customer, exactly as the original invoice was. Where no
  // organisation is linked, this is the same member resolved the same way.
  const contactId = await findOrCreateXeroContactForInvoicedParty(booking, {
    createdByMemberId,
    repairExistingLink,
  });
  const refundMapping = await getResolvedAccountMapping("hutFeeRefunds");
  const accountCode = refundMapping.code ?? "200";

  /**
   * #3530 (`INV-MOD-058`): the lines the edit stored, inverted for a credit
   * note, when they explain exactly what this note returns - which they do
   * not when policy retained part of the reduction (`INV-PAY-019`), or the
   * row stores none. Then the single line below, exactly as before, with the
   * reason recorded on the operation. The method wording (`INV-PAY-101`)
   * stays on the note's reference either way.
   */
  const itemised = await resolveModificationDocumentLineItems({
    bookingId,
    bookingModificationId,
    document: "MODIFICATION_CREDIT_NOTE",
    billedCents: refundAmountCents,
  });

  const modRefundLineItem: LineItem = {
    description: buildRefundDocumentDescription({
      method: refundMethod,
      bookingId,
      modificationId: bookingModificationId ?? null,
    }),
    quantity: 1,
    unitAmount: refundAmountCents / 100,
    taxType: "OUTPUT2",
  };
  if (refundMapping.itemCode) {
    modRefundLineItem.itemCode = refundMapping.itemCode;
  }
  if (!refundMapping.itemCode || accountCode !== "200" || refundMapping.codeExplicitlyConfigured) {
    modRefundLineItem.accountCode = accountCode;
  }

  // The credit note and the allocation that settles it are both dated on the
  // club's calendar, not the UTC day, which is still yesterday for roughly the
  // first half of every New Zealand day (INV-DATE-019, #2834). Read once so the
  // recorded payload, every contact-repair attempt and the allocation all agree.
  const modificationCreditNoteDate = xeroDocumentDateForClubToday(await readClubTimeZoneOutsideRequest());

  const buildCreditNote = (resolvedContactId: string): CreditNote => ({
    type: CreditNote.TypeEnum.ACCRECCREDIT,
    contact: { contactID: resolvedContactId },
    date: modificationCreditNoteDate,
    lineAmountTypes: LineAmountTypes.Inclusive,
    lineItems: itemised.lineItems ?? [modRefundLineItem],
    reference: buildRefundDocumentReference({ method: refundMethod, bookingId }),
    status: CreditNote.StatusEnum.AUTHORISED,
  });

  const localModel = bookingModificationId ? "BookingModification" : "Booking";
  const localId = bookingModificationId ?? bookingId;
  const creditNoteIdempotencyKey = buildXeroIdempotencyKey(
    bookingModificationId ? "booking-mod" : "booking",
    localId,
    "mod-credit-note",
    refundAmountCents,
    "v1"
  );
  let operationId = syncOperationId ?? null;
  const requestPayload = {
    creditNotes: [buildCreditNote(contactId)],
    invoiceId: originalInvoiceId,
    refundAmountCents,
    refundMethod,
    priceLines: itemised.record,
  };

  if (operationId) {
    await prisma.xeroSyncOperation.update({
      where: { id: operationId },
      data: {
        requestPayload: sanitizeForJson(requestPayload),
      },
    });
  } else {
    const operation = await startXeroSyncOperation({
      direction: "OUTBOUND",
      entityType: "CREDIT_NOTE",
      operationType: "CREATE",
      localModel,
      localId,
      idempotencyKey: creditNoteIdempotencyKey,
      correlationKey: creditNoteIdempotencyKey,
      requestPayload,
      createdByMemberId: createdByMemberId ?? null,
    });
    operationId = operation.id;
  }

  try {
    const response = await retryXeroWriteWithContactRepair({
      memberId: bookingOwner(booking).memberId,
      currentContactId: contactId,
      // The repair entity matches the invoiced party (#3368, `INV-INT-019`) —
      // the default repair searches Xero by email and would adopt a teacher's
      // personal contact for a school's credit note.
      repairContactLink: invoicedPartyContactRepair(booking),
      workflow: "createXeroCreditNoteForModification",
      operationId: operationId!,
      repairExistingLink,
      createdByMemberId,
      buildRequestPayload: (resolvedContactId) => ({
        creditNotes: [buildCreditNote(resolvedContactId)],
        invoiceId: originalInvoiceId,
        refundAmountCents,
        refundMethod,
        priceLines: itemised.record,
      }),
      run: ({ contactId: resolvedContactId }) =>
        callXeroApi(
          () =>
            xero.accountingApi.createCreditNotes(
              tenantId,
              { creditNotes: [buildCreditNote(resolvedContactId)] },
              undefined,
              undefined,
              creditNoteIdempotencyKey
            ),
          {
            operation: "createCreditNotes",
            resourceType: "CREDIT_NOTE",
            workflow: "createXeroCreditNoteForModification",
            context: `createCreditNotes(modification ${localId})`,
          }
        ),
    });

    const created = response.body.creditNotes?.[0];
    if (!created?.creditNoteID) {
      throw new Error("Failed to create modification credit note");
    }
    const createdCreditNoteId = created.creditNoteID;

    const allocationIdempotencyKey = buildXeroIdempotencyKey(
      bookingModificationId ? "booking-mod" : "booking",
      localId,
      "mod-credit-note-allocation",
      refundAmountCents,
      "v1"
    );

    try {
      const allocationResponse = await callXeroApi(
        () =>
          xero.accountingApi.createCreditNoteAllocation(
            tenantId,
            createdCreditNoteId,
            {
              allocations: [
                {
                  invoice: { invoiceID: originalInvoiceId },
                  amount: refundAmountCents / 100,
                  date: modificationCreditNoteDate,
                },
              ],
            },
            undefined,
            allocationIdempotencyKey
          ),
        {
          operation: "createCreditNoteAllocation",
          resourceType: "ALLOCATION",
          workflow: "createXeroCreditNoteForModification",
          context: `createCreditNoteAllocation(modification ${localId})`,
        }
      );

      await completeXeroSyncOperation(operationId!, {
        responsePayload: {
          creditNote: response.body,
          allocation: allocationResponse.body,
        },
        xeroObjectType: "CREDIT_NOTE",
        xeroObjectId: createdCreditNoteId,
        xeroObjectNumber: created.creditNoteNumber ?? null,
        extraLinks: [
          {
            localModel,
            localId,
            xeroObjectType: "CREDIT_NOTE",
            xeroObjectId: createdCreditNoteId,
            xeroObjectNumber: created.creditNoteNumber ?? null,
            role: "MODIFICATION_CREDIT_NOTE",
          },
          {
            localModel,
            localId,
            xeroObjectType: "ALLOCATION",
            xeroObjectId: buildSyntheticAllocationId(
              createdCreditNoteId,
              originalInvoiceId,
              refundAmountCents
            ),
            xeroObjectUrl: buildXeroInvoiceUrl(originalInvoiceId),
            role: "MODIFICATION_CREDIT_NOTE_ALLOCATION",
            metadata: {
              creditNoteId: createdCreditNoteId,
              invoiceId: originalInvoiceId,
              amountCents: refundAmountCents,
            },
          },
        ],
      });

      return createdCreditNoteId;
    } catch (allocationError) {
      await completeXeroSyncOperation(operationId!, {
        status: "PARTIAL",
        responsePayload: {
          creditNote: response.body,
          allocationError,
        },
        xeroObjectType: "CREDIT_NOTE",
        xeroObjectId: createdCreditNoteId,
        xeroObjectNumber: created.creditNoteNumber ?? null,
        extraLinks: [
          {
            localModel,
            localId,
            xeroObjectType: "CREDIT_NOTE",
            xeroObjectId: createdCreditNoteId,
            xeroObjectNumber: created.creditNoteNumber ?? null,
            role: "MODIFICATION_CREDIT_NOTE",
          },
        ],
      });
      return createdCreditNoteId;
    }
  } catch (error) {
    await failXeroSyncOperation(operationId!, error);
    throw error;
  }
}
