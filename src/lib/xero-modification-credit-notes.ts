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
  modificationNoteWording,
  settledModificationNoteWording,
  type ModificationNoteWording,
} from "@/lib/xero-refund-method";
import { resolveModificationDocumentLineItems } from "@/lib/xero-modification-line-items";
import { XERO_OUTBOX_MODIFICATION_CREDIT_NOTE_TYPE } from "@/lib/xero-operation-outbox-payload";
import { isUnpaidAskBilledOffsetNoteScope, reviewTaskKeyParts } from "@/lib/xero-review-task-key";
import {
  awaitsMissingOwnNote,
  BILLED_OFFSET_AWAITING_OWN_NOTE_CODE,
  BILLED_OFFSET_OWN_NOTE_MISSING_MESSAGE,
  BILLED_OFFSET_OWN_NOTE_WAIT_MS,
  isOwnModificationNoteOperation,
  queuedOwnNoteExpected,
} from "@/lib/unpaid-ask-billed-offset-order";
import {
  findUnconvergedAppliedCreditDeallocation,
  needsOperatorXeroRetry,
  XeroAppliedCreditOperationBusyError,
} from "@/lib/xero-applied-credit-operation-serialization";
import {
  findBookingSupplementaryInvoiceIds,
  planClearingAllocations,
  readInvoiceAmountsDue,
  type ClearingAllocationTarget,
} from "@/lib/xero-clearing-allocations";
import { ModificationNoteExceedsInvoiceDueError } from "@/lib/xero-modification-note-refusal";
import type { ClubFormat } from "@/lib/club-format";
import type { XeroOperationClaim } from "@/lib/xero-operation-outcome-guard";

/**
 * `refundMethod` is how the reduction went back to the member (`INV-PAY-101`,
 * #3529) — the wording on the note. This note is allocated against the
 * original invoice rather than settled by a payment, so the method changes no
 * account here; it is what the treasurer reads. Absent on rows queued before
 * the field existed, which were all card refunds by this builder's own history.
 * `clearsUnpaidInvoice` instead says the invoice is closed because nobody paid
 * it (`INV-PAY-017`, #3535) — the same allocation, no refund named.
 */
export async function createXeroCreditNoteForModification(params: {
  bookingId: string;
  refundAmountCents: number;
  bookingModificationId?: string;
  createdByMemberId?: string;
  repairExistingLink?: boolean;
  syncOperation?: XeroOperationClaim;
  /**
   * #3791: one review task's share of the edit, which scopes the note's Xero
   * idempotency keys to that task (`reviewTaskKeyParts`) and is kept on the
   * operation so an operator retry rebuilds the same keys.
   */
  reviewTaskId?: string;
  /**
   * The club's format (#3565), for any amount a line description renders (a
   * promotion delta reads "reduced by $20.00" on the Xero line). Resolved once
   * by the job or request that raised this document, never here.
   */
  format: ClubFormat;
} & ModificationNoteWording): Promise<string | null> {
  const {
    bookingId,
    refundAmountCents,
    bookingModificationId,
    createdByMemberId,
    repairExistingLink,
    syncOperation,
  } = params;
  const reviewTaskId = bookingModificationId ? params.reviewTaskId : undefined;
  const recordedReviewTask = reviewTaskId ? { reviewTaskId } : {};
  const wording = modificationNoteWording(params);
  // Recorded on the operation so the treasurer's audit trail and any repair
  // read the same choice the note was built with.
  const recordedWording = settledModificationNoteWording(params);

  if (refundAmountCents <= 0) {
    if (syncOperation) {
      await completeXeroSyncOperation(syncOperation, {
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
    if (syncOperation) {
      await completeXeroSyncOperation(syncOperation, {
        responsePayload: {
          skipped: true,
          reason: "No original Xero invoice exists for this booking.",
        },
      });
    }
    return null;
  }
  const originalInvoiceId = booking.payment.xeroInvoiceId;

  // #3791: a review's note follows the give-back's deallocation of the same
  // payment, and since #3809 so does an edit's: a credit-paid booking's
  // reduction gives back through the same give-back. Run first, it would meet an
  // invoice the applied credit still covers and end PARTIAL. While that
  // deallocation is on its way it waits, and the outbox returns it to PENDING (a
  // busy error is transient). One that FAILED only an operator's retry moves, so
  // waiting would spin for ever: the note fails instead, naming the
  // deallocation, and is retried after it.
  if (bookingModificationId) {
    const deallocation = await findUnconvergedAppliedCreditDeallocation(booking.payment.id, prisma);
    if (deallocation) {
      const fence = new XeroAppliedCreditOperationBusyError(
        `Modification credit note waits for applied-credit deallocation ${deallocation.id} (${deallocation.status}) on payment ${booking.payment.id}`,
        deallocation.status,
      );
      if (!needsOperatorXeroRetry(fence)) throw fence;
      const failed = new Error(
        `Modification credit note held: applied-credit deallocation ${deallocation.id} is ${deallocation.status}. Retry that Xero operation first, then retry this note.`,
      );
      if (syncOperation) await failXeroSyncOperation(syncOperation, failed);
      throw failed;
    }
  }

  // #3954 round 6: a reduction's billed-offset note is raised AFTER the edit's
  // own note on the same anchor, never before it: while that note is still
  // queued or running, this one waits and the outbox returns it to PENDING.
  // Round 7: and while the edit expects one that is not queued yet, up to an
  // age limit (`unpaid-ask-billed-offset-order.ts`).
  if (bookingModificationId && isUnpaidAskBilledOffsetNoteScope(reviewTaskId)) {
    const ownNote = await findQueuedOwnModificationNote(bookingModificationId);
    if (ownNote) {
      throw new XeroAppliedCreditOperationBusyError(
        `Billed-offset credit note waits for modification ${bookingModificationId}'s own credit note ${ownNote.id} (${ownNote.status})`,
        ownNote.status,
      );
    }
    if (syncOperation) await waitForExpectedOwnNote(bookingModificationId, syncOperation);
  }

  const { xero, tenantId } = await getAuthenticatedXeroClient();
  // #3993: an edit's note targets the original invoice for the whole amount.
  // Read what it still owes before creating anything. A card-paid invoice owes
  // nothing, and creating first used to leave an unallocated note behind. A
  // give-back has already waited for its deallocation, so this read sees the
  // reopened amount. A partial row that already has a note is retried by
  // allocating only, and does not enter here.
  if (bookingModificationId) {
    const [due] = await readInvoiceAmountsDue(xero, tenantId, [originalInvoiceId]);
    const owed = due?.amountDueCents ?? 0;
    if (owed < refundAmountCents) {
      const error = new ModificationNoteExceedsInvoiceDueError(refundAmountCents, owed, params.format);
      if (syncOperation) await failXeroSyncOperation(syncOperation, error);
      throw error;
    }
  }
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
  const itemised = bookingModificationId
    ? await resolveModificationDocumentLineItems({
        bookingId,
        bookingModificationId,
        document: "MODIFICATION_CREDIT_NOTE",
        billedCents: refundAmountCents,
      }, params.format)
    : // A legacy row anchored on the booking has no edit behind it; nothing
      // to itemise and nothing to record, as the account-credit note does.
      null;

  const modRefundLineItem: LineItem = {
    description: buildRefundDocumentDescription({
      method: wording,
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
    lineItems: itemised?.lineItems ?? [modRefundLineItem],
    reference: buildRefundDocumentReference({ method: wording, bookingId }),
    status: CreditNote.StatusEnum.AUTHORISED,
  });

  const localModel = bookingModificationId ? "BookingModification" : "Booking";
  const localId = bookingModificationId ?? bookingId;

  // Where the note is allocated. An edit's reduction goes against the original
  // invoice, as it always has. A booking-anchored note clears an unpaid
  // booking's whole invoicing (INV-PAY-017), so it is spread across the
  // primary and any supplementary invoice, each up to what it still owes, and
  // is not created at all when they owe less than it (#3535,
  // `xero-clearing-allocations.ts`).
  let allocationTargets: ClearingAllocationTarget[];
  if (bookingModificationId) {
    allocationTargets = [{ invoiceId: originalInvoiceId, amountCents: refundAmountCents }];
  } else {
    try {
      allocationTargets = planClearingAllocations({
        format: params.format,
        noteCents: refundAmountCents,
        invoices: await readInvoiceAmountsDue(xero, tenantId, [
          originalInvoiceId,
          ...(await findBookingSupplementaryInvoiceIds(bookingId)).filter(
            (invoiceId) => invoiceId !== originalInvoiceId
          ),
        ]),
      });
    } catch (planError) {
      if (syncOperation) {
        await failXeroSyncOperation(syncOperation, planError);
      }
      throw planError;
    }
  }
  // Recorded only for the booking-anchored note: an edit's single target is
  // the `invoiceId` it has always recorded.
  const recordedAllocations = bookingModificationId ? {} : { allocations: allocationTargets };

  const creditNoteIdempotencyKey = buildXeroIdempotencyKey(
    bookingModificationId ? "booking-mod" : "booking",
    localId,
    ...reviewTaskKeyParts(reviewTaskId),
    "mod-credit-note",
    refundAmountCents,
    "v1"
  );
  let operationClaim = syncOperation ?? null;
  let operationId = operationClaim?.id ?? null;
  const requestPayload = {
    creditNotes: [buildCreditNote(contactId)],
    invoiceId: originalInvoiceId,
    refundAmountCents,
    ...recordedReviewTask,
    ...recordedWording,
    ...recordedAllocations,
    ...(itemised ? { priceLines: itemised.record } : {}),
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
      // #3535: a retry of a FAILED clearing note opens its row here; stamping
      // the column is what lets the hold-clearing audit and the late-cash
      // alert (which select clearing rows by it) see the retry and its note.
      ...(bookingModificationId ? {} : { queueType: XERO_OUTBOX_MODIFICATION_CREDIT_NOTE_TYPE }),
      createdByMemberId: createdByMemberId ?? null,
    });
    operationId = operation.id;
    operationClaim = operation;
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
        ...recordedReviewTask,
        ...recordedWording,
        ...recordedAllocations,
        ...(itemised ? { priceLines: itemised.record } : {}),
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

    // One allocation call per target, each with its own Xero idempotency key.
    // A single target (every edit's note, and a clearing note with no
    // supplementary invoice) keeps the key it always had.
    const noteLink = {
      localModel,
      localId,
      xeroObjectType: "CREDIT_NOTE",
      xeroObjectId: createdCreditNoteId,
      xeroObjectNumber: created.creditNoteNumber ?? null,
      role: "MODIFICATION_CREDIT_NOTE",
      // #3809: the scope travels to the links, so the repair pass can tell a
      // give-back note beside the edit's own from the edit's own.
      ...(reviewTaskId ? { metadata: { reviewTaskId } } : {}),
    };
    const allocated: ClearingAllocationTarget[] = [];
    const allocationResponses: unknown[] = [];
    let allocationError: unknown = null;
    for (const target of allocationTargets) {
      const allocationIdempotencyKey = buildXeroIdempotencyKey(
        bookingModificationId ? "booking-mod" : "booking",
        localId,
        ...reviewTaskKeyParts(reviewTaskId),
        "mod-credit-note-allocation",
        ...(allocationTargets.length > 1 ? [target.invoiceId] : []),
        target.amountCents,
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
                    invoice: { invoiceID: target.invoiceId },
                    amount: target.amountCents / 100,
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
            context: `createCreditNoteAllocation(modification ${localId} -> ${target.invoiceId})`,
          }
        );
        allocated.push(target);
        allocationResponses.push(allocationResponse.body);
      } catch (error) {
        allocationError = error;
        break;
      }
    }

    const allocationLinks = allocated.map((target) => ({
      localModel,
      localId,
      xeroObjectType: "ALLOCATION",
      xeroObjectId: buildSyntheticAllocationId(
        createdCreditNoteId,
        target.invoiceId,
        target.amountCents
      ),
      xeroObjectUrl: buildXeroInvoiceUrl(target.invoiceId),
      role: "MODIFICATION_CREDIT_NOTE_ALLOCATION",
      metadata: {
        creditNoteId: createdCreditNoteId,
        invoiceId: target.invoiceId,
        amountCents: target.amountCents,
        ...(reviewTaskId ? { reviewTaskId } : {}),
      },
    }));
    const allocationBody =
      allocationResponses.length === 1 ? allocationResponses[0] : allocationResponses;

    await completeXeroSyncOperation(operationClaim!, {
      ...(allocationError ? { status: "PARTIAL" as const } : {}),
      responsePayload: allocationError
        ? {
            creditNote: response.body,
            allocationError,
            ...(allocationResponses.length > 0 ? { allocation: allocationBody } : {}),
          }
        : { creditNote: response.body, allocation: allocationBody },
      xeroObjectType: "CREDIT_NOTE",
      xeroObjectId: createdCreditNoteId,
      xeroObjectNumber: created.creditNoteNumber ?? null,
      extraLinks: [noteLink, ...allocationLinks],
    });

    return createdCreditNoteId;
  } catch (error) {
    await failXeroSyncOperation(operationClaim!, error);
    throw error;
  }
}

/**
 * The edit's OWN (unscoped) modification credit note, while it is still queued
 * or running (#3954 round 6) - either kind, by the one definition
 * (`isOwnModificationNoteOperation`, round 8).
 */
async function findQueuedOwnModificationNote(
  bookingModificationId: string,
): Promise<{ id: string; status: string } | null> {
  const operations = await prisma.xeroSyncOperation.findMany({
    where: {
      direction: "OUTBOUND",
      entityType: "CREDIT_NOTE",
      operationType: "CREATE",
      localModel: "BookingModification",
      localId: bookingModificationId,
      status: { in: ["PENDING", "RUNNING"] },
    },
    select: { id: true, status: true, entityType: true, operationType: true, queueType: true, requestPayload: true },
  });
  return operations.find(isOwnModificationNoteOperation) ?? null;
}

/**
 * #3954 round 7: a billed-offset note whose edit expects an own note waits
 * until an own-note operation or link exists - returned to PENDING by the
 * outbox - and, past `BILLED_OFFSET_OWN_NOTE_WAIT_MS`, fails for a person
 * (`awaitsMissingOwnNote`). Only the outbox's own run waits: an operator's
 * retry carries no operation of its own here and raises the note.
 */
async function waitForExpectedOwnNote(bookingModificationId: string, syncOperation: XeroOperationClaim): Promise<void> {
  const queued = await prisma.xeroSyncOperation.findUnique({
    where: { id: syncOperation.id },
    select: { requestPayload: true, createdAt: true },
  });
  if (!queued || !queuedOwnNoteExpected(queued)) return;
  const [operations, links] = await Promise.all([
    prisma.xeroSyncOperation.findMany({
      where: { localModel: "BookingModification", localId: bookingModificationId, entityType: "CREDIT_NOTE", operationType: "CREATE" },
      select: { entityType: true, operationType: true, queueType: true, status: true, requestPayload: true },
    }),
    prisma.xeroObjectLink.findMany({
      where: { localModel: "BookingModification", localId: bookingModificationId, xeroObjectType: "CREDIT_NOTE", active: true },
      select: { xeroObjectType: true, role: true, active: true, metadata: true },
    }),
  ]);
  if (!awaitsMissingOwnNote(queued, { operations, links })) return;
  if (Date.now() - queued.createdAt.getTime() < BILLED_OFFSET_OWN_NOTE_WAIT_MS) {
    // Round 8: coded, so the outbox looks at it again only every few minutes.
    throw new XeroAppliedCreditOperationBusyError(
      `Billed-offset credit note waits for modification ${bookingModificationId}'s own credit note, which is not queued yet`,
      "PENDING",
      BILLED_OFFSET_AWAITING_OWN_NOTE_CODE,
    );
  }
  const failed = new Error(BILLED_OFFSET_OWN_NOTE_MISSING_MESSAGE);
  await failXeroSyncOperation(syncOperation, failed);
  throw failed;
}
