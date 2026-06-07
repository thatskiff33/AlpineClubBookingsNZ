/**
 * Xero credit note creation, allocation, and refund-credit-note settlement.
 *
 * Owns three closely-related accounting documents:
 *
 * - `createXeroCreditNote` (refund credit note settled by a Stripe-refund
 *   credit-note payment in the same flow)
 * - `createUnappliedXeroCreditNote` (account credit balance, used for
 *   member-credit refunds rather than money out)
 * - `allocateCreditNoteToInvoice` (apply an unapplied credit note against
 *   an invoice via Xero allocation)
 *
 * Also exposes the shared `backfillCancellationCreditXeroNote` helper
 * that keeps the local `MemberCredit` rows in step with the canonical
 * Xero credit-note IDs.
 */

import { CreditNote, LineAmountTypes, type LineItem } from "xero-node";
import { CreditType } from "@prisma/client";
import { prisma } from "./prisma";
import logger from "@/lib/logger";
import { buildXeroInvoiceUrl } from "@/lib/xero-links";
import {
  buildXeroIdempotencyKey,
  completeXeroSyncOperation,
  failXeroSyncOperation,
  findCanonicalPaymentRefundCreditNote,
  sanitizeForJson,
  startXeroSyncOperation,
  upsertXeroObjectLink,
} from "@/lib/xero-sync";
import {
  callXeroApi,
  getAuthenticatedXeroClient,
} from "./xero-api-client";
import {
  getAccountMapping,
  getResolvedAccountMapping,
} from "./xero-mappings";
import {
  findOrCreateXeroContact,
  retryXeroWriteWithContactRepair,
  type FindOrCreateXeroContactOptions,
} from "./xero-contacts";
import {
  buildSyntheticAllocationId,
  formatDate,
} from "./xero-invoice-helpers";
import {
  buildRefundCreditNotePayment,
  REFUND_CREDIT_NOTE_ALLOCATION_SKIP_REASON,
} from "./xero-invoice-payments";

export interface CreateXeroRefundCreditNoteOptions
  extends FindOrCreateXeroContactOptions {
  syncOperationId?: string;
}

export interface CreateXeroUnappliedCreditNoteOptions
  extends FindOrCreateXeroContactOptions {
  syncOperationId?: string;
  bookingModificationId?: string;
}

export async function createXeroCreditNote(
  paymentId: string,
  refundAmountCents: number,
  options?: CreateXeroRefundCreditNoteOptions
): Promise<string> {
  const payment = await prisma.payment.findUnique({
    where: { id: paymentId },
    include: {
      booking: {
        include: { member: true, guests: true },
      },
    },
  });

  if (!payment) throw new Error(`Payment not found: ${paymentId}`);
  if (!payment.xeroInvoiceId) {
    throw new Error(`No Xero invoice linked to payment: ${paymentId}`);
  }
  const originalInvoiceId = payment.xeroInvoiceId;
  const queuedOperationId = options?.syncOperationId ?? null;
  const canonicalRefundCreditNote = await findCanonicalPaymentRefundCreditNote(paymentId);
  const existingCreditNoteId =
    payment.xeroRefundCreditNoteId ?? canonicalRefundCreditNote?.xeroObjectId ?? null;
  const existingCreditNoteNumber =
    canonicalRefundCreditNote?.xeroObjectNumber ?? null;

  // Idempotency guard: skip if credit note already created for this payment
  if (existingCreditNoteId) {
    if (payment.xeroRefundCreditNoteId !== existingCreditNoteId) {
      await prisma.payment.update({
        where: { id: paymentId },
        data: {
          xeroRefundCreditNoteId: existingCreditNoteId,
        },
      });
    }

    await upsertXeroObjectLink({
      localModel: "Payment",
      localId: paymentId,
      xeroObjectType: "CREDIT_NOTE",
      xeroObjectId: existingCreditNoteId,
      xeroObjectNumber: existingCreditNoteNumber,
      role: "REFUND_CREDIT_NOTE",
    });
    if (queuedOperationId) {
      await completeXeroSyncOperation(queuedOperationId, {
        responsePayload: {
          existingCreditNoteId,
        },
        xeroObjectType: "CREDIT_NOTE",
        xeroObjectId: existingCreditNoteId,
        xeroObjectNumber: existingCreditNoteNumber,
        extraLinks: [
          {
            localModel: "Payment",
            localId: paymentId,
            xeroObjectType: "CREDIT_NOTE",
            xeroObjectId: existingCreditNoteId,
            xeroObjectNumber: existingCreditNoteNumber,
            role: "REFUND_CREDIT_NOTE",
          },
        ],
      });
    }
    logger.info({ paymentId, creditNoteId: existingCreditNoteId }, "Xero credit note already exists, skipping");
    return existingCreditNoteId;
  }

  const { xero, tenantId } = await getAuthenticatedXeroClient();

  // Ensure the member has a Xero contact
  const contactId = await findOrCreateXeroContact(payment.booking.memberId, options);
  const refundMapping = await getResolvedAccountMapping("hutFeeRefunds");
  const accountCode = refundMapping.code ?? "200";

  const refundLineItem: LineItem = {
    description: `Refund for booking ${payment.booking.id.slice(0, 8)} (${formatDate(new Date(payment.booking.checkIn))} - ${formatDate(new Date(payment.booking.checkOut))})`,
    quantity: 1,
    unitAmount: refundAmountCents / 100,
    taxType: "OUTPUT2",
  };
  if (refundMapping.itemCode) {
    refundLineItem.itemCode = refundMapping.itemCode;
  }
  if (!refundMapping.itemCode || accountCode !== "200" || refundMapping.codeExplicitlyConfigured) {
    refundLineItem.accountCode = accountCode;
  }

  const buildCreditNote = (resolvedContactId: string): CreditNote => ({
    type: CreditNote.TypeEnum.ACCRECCREDIT,
    contact: { contactID: resolvedContactId },
    date: formatDate(new Date()),
    lineAmountTypes: LineAmountTypes.Inclusive,
    lineItems: [refundLineItem],
    reference: `Refund - Booking ${payment.booking.id.slice(0, 8)}`,
    status: CreditNote.StatusEnum.AUTHORISED,
  });

  const creditNoteIdempotencyKey = buildXeroIdempotencyKey(
    "payment",
    paymentId,
    "refund-credit-note",
    refundAmountCents,
    "v1"
  );
  let operationId = queuedOperationId;
  const requestPayload = {
    creditNotes: [buildCreditNote(contactId)],
    allocation: {
      invoiceId: originalInvoiceId,
      amount: refundAmountCents / 100,
    },
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
      localModel: "Payment",
      localId: paymentId,
      idempotencyKey: creditNoteIdempotencyKey,
      correlationKey: creditNoteIdempotencyKey,
      requestPayload,
      createdByMemberId: options?.createdByMemberId ?? null,
    });
    operationId = operation.id;
  }

  try {
    const response = await retryXeroWriteWithContactRepair({
      memberId: payment.booking.memberId,
      currentContactId: contactId,
      workflow: "createXeroCreditNote",
      operationId: operationId!,
      repairExistingLink: options?.repairExistingLink,
      createdByMemberId: options?.createdByMemberId,
      buildRequestPayload: (resolvedContactId) => ({
        creditNotes: [buildCreditNote(resolvedContactId)],
        allocation: {
          invoiceId: originalInvoiceId,
          amount: refundAmountCents / 100,
        },
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
            workflow: "createXeroCreditNote",
            context: `createCreditNotes(refund ${paymentId})`,
          }
        ),
    });

    const createdNote = response.body.creditNotes?.[0];
    if (!createdNote?.creditNoteID) {
      throw new Error("Failed to create Xero credit note");
    }

    // Save credit note ID immediately so follow-up retries repair the existing note instead
    // of minting duplicates when downstream bookkeeping calls fail.
    await prisma.payment.update({
      where: { id: paymentId },
      data: { xeroRefundCreditNoteId: createdNote.creditNoteID },
    });

    let refundPaymentResponseBody:
      | { paymentID?: string; invoiceNumber?: string; creditNoteNumber?: string; amount?: number }
      | null = null;
    let refundPaymentErr: unknown = null;

    try {
      const bankCode = (await getAccountMapping("stripeBankAccount")) ?? "606";
      const refundPaymentIdempotencyKey = buildXeroIdempotencyKey(
        "payment",
        paymentId,
        "refund-payment",
        refundAmountCents,
        "v1"
      );
      const refundPayment = buildRefundCreditNotePayment({
        paymentId,
        creditNoteId: createdNote.creditNoteID,
        refundAmountCents,
        bankCode,
      });
      const refundPaymentResponse = await callXeroApi(
        () =>
          xero.accountingApi.createPayments(
            tenantId,
            {
              payments: [refundPayment],
            },
            undefined,
            refundPaymentIdempotencyKey
          ),
        {
          operation: "createPayments",
          resourceType: "PAYMENT",
          workflow: "createXeroCreditNote",
          context: `createPayments(refund credit note ${paymentId})`,
        }
      );
      refundPaymentResponseBody = refundPaymentResponse.body.payments?.[0] ?? null;
      logger.info(
        { paymentId, creditNoteId: createdNote.creditNoteID },
        "Xero refund payment created against Stripe bank account via credit note"
      );
    } catch (error) {
      refundPaymentErr = error;
      logger.error(
        { err: error, paymentId, creditNoteId: createdNote.creditNoteID },
        "Failed to create Xero refund payment against Stripe bank account via credit note"
      );
    }

    await completeXeroSyncOperation(operationId!, {
      status: refundPaymentErr ? "PARTIAL" : "SUCCEEDED",
      responsePayload: {
        creditNote: response.body,
        allocation: null,
        allocationSkipped: true,
        allocationSkipReason: REFUND_CREDIT_NOTE_ALLOCATION_SKIP_REASON,
        refundPayment: refundPaymentResponseBody,
        refundPaymentError: refundPaymentErr,
      },
      xeroObjectType: "CREDIT_NOTE",
      xeroObjectId: createdNote.creditNoteID,
      xeroObjectNumber: createdNote.creditNoteNumber ?? null,
      extraLinks: [
        {
          localModel: "Payment",
          localId: paymentId,
          xeroObjectType: "CREDIT_NOTE",
          xeroObjectId: createdNote.creditNoteID,
          xeroObjectNumber: createdNote.creditNoteNumber ?? null,
          role: "REFUND_CREDIT_NOTE",
        },
        ...(refundPaymentResponseBody?.paymentID
          ? [
              {
                localModel: "Payment",
                localId: paymentId,
                xeroObjectType: "PAYMENT",
                xeroObjectId: refundPaymentResponseBody.paymentID,
                xeroObjectNumber:
                  refundPaymentResponseBody.creditNoteNumber
                  ?? refundPaymentResponseBody.invoiceNumber
                  ?? null,
                role: "REFUND_PAYMENT",
                metadata: {
                  creditNoteId: createdNote.creditNoteID,
                  invoiceId: originalInvoiceId,
                  amountCents: refundAmountCents,
                },
              },
            ]
          : []),
      ],
    });

    return createdNote.creditNoteID;
  } catch (error) {
    await failXeroSyncOperation(operationId!, error);
    throw error;
  }
}


async function backfillCancellationCreditXeroNote(params: {
  memberId: string;
  bookingId: string;
  refundAmountCents: number;
  creditNoteId: string;
}) {
  const bookingLabel = params.bookingId.slice(0, 8);
  await prisma.memberCredit.updateMany({
    where: {
      memberId: params.memberId,
      sourceBookingId: params.bookingId,
      amountCents: params.refundAmountCents,
      type: CreditType.CANCELLATION_REFUND,
      description: `Cancellation refund for booking ${bookingLabel}`,
      xeroCreditNoteId: null,
    },
    data: {
      xeroCreditNoteId: params.creditNoteId,
    },
  });
}

async function backfillBookingModificationCreditXeroNote(params: {
  memberId: string;
  bookingId: string;
  bookingModificationId: string;
  refundAmountCents: number;
  creditNoteId: string;
}) {
  await prisma.memberCredit.updateMany({
    where: {
      memberId: params.memberId,
      sourceBookingId: params.bookingId,
      sourceBookingModificationId: params.bookingModificationId,
      amountCents: params.refundAmountCents,
      type: CreditType.BOOKING_MODIFICATION_REFUND,
      xeroCreditNoteId: null,
    },
    data: {
      xeroCreditNoteId: params.creditNoteId,
    },
  });
}

/**
 * Create an UNAPPLIED Xero credit note for account credit refunds.
 * Unlike createXeroCreditNote(), this:
 * - Does NOT allocate against the original invoice
 * - Does NOT create a cash refund payment
 * The credit note stays as open credit on the member's Xero contact.
 */

export async function createUnappliedXeroCreditNote(
  paymentId: string,
  refundAmountCents: number,
  options?: CreateXeroUnappliedCreditNoteOptions
): Promise<string> {
  const payment = await prisma.payment.findUnique({
    where: { id: paymentId },
    include: {
      booking: {
        include: { member: true },
      },
    },
  });

  if (!payment) throw new Error(`Payment not found: ${paymentId}`);
  const queuedOperationId = options?.syncOperationId ?? null;
  const bookingModificationId = options?.bookingModificationId ?? null;
  const linkLocalModel = bookingModificationId ? "BookingModification" : "Payment";
  const linkLocalId = bookingModificationId ?? paymentId;
  const linkRole = bookingModificationId
    ? "MODIFICATION_ACCOUNT_CREDIT_NOTE"
    : "ACCOUNT_CREDIT_NOTE";
  const existingLink = await prisma.xeroObjectLink.findFirst({
    where: {
      localModel: linkLocalModel,
      localId: linkLocalId,
      xeroObjectType: "CREDIT_NOTE",
      role: linkRole,
      active: true,
    },
    select: {
      xeroObjectId: true,
      xeroObjectNumber: true,
    },
  });

  if (existingLink?.xeroObjectId) {
    if (bookingModificationId) {
      await backfillBookingModificationCreditXeroNote({
        memberId: payment.booking.memberId,
        bookingId: payment.booking.id,
        bookingModificationId,
        refundAmountCents,
        creditNoteId: existingLink.xeroObjectId,
      });
    } else {
      await backfillCancellationCreditXeroNote({
        memberId: payment.booking.memberId,
        bookingId: payment.booking.id,
        refundAmountCents,
        creditNoteId: existingLink.xeroObjectId,
      });
    }

    if (queuedOperationId) {
      await completeXeroSyncOperation(queuedOperationId, {
        responsePayload: {
          existingCreditNoteId: existingLink.xeroObjectId,
        },
        xeroObjectType: "CREDIT_NOTE",
        xeroObjectId: existingLink.xeroObjectId,
        xeroObjectNumber: existingLink.xeroObjectNumber ?? null,
        extraLinks: [
          {
            localModel: linkLocalModel,
            localId: linkLocalId,
            xeroObjectType: "CREDIT_NOTE",
            xeroObjectId: existingLink.xeroObjectId,
            xeroObjectNumber: existingLink.xeroObjectNumber ?? null,
            role: linkRole,
          },
        ],
      });
    }

    logger.info(
      { paymentId, creditNoteId: existingLink.xeroObjectId },
      "Xero account-credit note already exists, skipping"
    );

    return existingLink.xeroObjectId;
  }

  const { xero, tenantId } = await getAuthenticatedXeroClient();
  const contactId = await findOrCreateXeroContact(payment.booking.memberId, options);
  const refundMapping = await getResolvedAccountMapping("hutFeeRefunds");
  const accountCode = refundMapping.code ?? "200";

  const creditLineItem: LineItem = {
    description: bookingModificationId
      ? `Account credit from booking modification ${bookingModificationId.slice(0, 8)} (Booking ${payment.booking.id.slice(0, 8)})`
      : `Account credit from booking ${payment.booking.id.slice(0, 8)} (${formatDate(new Date(payment.booking.checkIn))} - ${formatDate(new Date(payment.booking.checkOut))})`,
    quantity: 1,
    unitAmount: refundAmountCents / 100,
    taxType: "OUTPUT2",
  };
  if (refundMapping.itemCode) {
    creditLineItem.itemCode = refundMapping.itemCode;
  }
  if (!refundMapping.itemCode || accountCode !== "200" || refundMapping.codeExplicitlyConfigured) {
    creditLineItem.accountCode = accountCode;
  }

  const buildCreditNote = (resolvedContactId: string): CreditNote => ({
    type: CreditNote.TypeEnum.ACCRECCREDIT,
    contact: { contactID: resolvedContactId },
    date: formatDate(new Date()),
    lineAmountTypes: LineAmountTypes.Inclusive,
    lineItems: [creditLineItem],
    reference: bookingModificationId
      ? `Modification Credit - Booking ${payment.booking.id.slice(0, 8)}`
      : `Account Credit - Booking ${payment.booking.id.slice(0, 8)}`,
    status: CreditNote.StatusEnum.AUTHORISED,
  });

  const idempotencyKey = buildXeroIdempotencyKey(
    bookingModificationId ? "booking-mod" : "payment",
    linkLocalId,
    bookingModificationId ? "mod-unapplied-credit-note" : "unapplied-credit-note",
    refundAmountCents,
    "v1"
  );
  let operationId = queuedOperationId;
  const requestPayload = { creditNotes: [buildCreditNote(contactId)] };

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
      localModel: linkLocalModel,
      localId: linkLocalId,
      idempotencyKey,
      correlationKey: idempotencyKey,
      requestPayload,
      createdByMemberId: options?.createdByMemberId ?? null,
    });
    operationId = operation.id;
  }

  try {
    const response = await retryXeroWriteWithContactRepair({
      memberId: payment.booking.memberId,
      currentContactId: contactId,
      workflow: "createUnappliedXeroCreditNote",
      operationId: operationId!,
      repairExistingLink: options?.repairExistingLink,
      createdByMemberId: options?.createdByMemberId,
      buildRequestPayload: (resolvedContactId) => ({
        creditNotes: [buildCreditNote(resolvedContactId)],
      }),
      run: ({ contactId: resolvedContactId }) =>
        callXeroApi(
          () =>
            xero.accountingApi.createCreditNotes(
              tenantId,
              { creditNotes: [buildCreditNote(resolvedContactId)] },
              undefined,
              undefined,
              idempotencyKey
            ),
          {
            operation: "createCreditNotes",
            resourceType: "CREDIT_NOTE",
            workflow: "createUnappliedXeroCreditNote",
            context: `createCreditNotes(unapplied ${paymentId})`,
          }
        ),
    });

    const createdNote = response.body.creditNotes?.[0];
    if (!createdNote?.creditNoteID) {
      throw new Error("Failed to create unapplied Xero credit note");
    }

    if (bookingModificationId) {
      await backfillBookingModificationCreditXeroNote({
        memberId: payment.booking.memberId,
        bookingId: payment.booking.id,
        bookingModificationId,
        refundAmountCents,
        creditNoteId: createdNote.creditNoteID,
      });
    } else {
      await backfillCancellationCreditXeroNote({
        memberId: payment.booking.memberId,
        bookingId: payment.booking.id,
        refundAmountCents,
        creditNoteId: createdNote.creditNoteID,
      });
    }

    await completeXeroSyncOperation(operationId!, {
      responsePayload: response.body,
      xeroObjectType: "CREDIT_NOTE",
      xeroObjectId: createdNote.creditNoteID,
      xeroObjectNumber: createdNote.creditNoteNumber ?? null,
      extraLinks: [
        {
          localModel: linkLocalModel,
          localId: linkLocalId,
          xeroObjectType: "CREDIT_NOTE",
          xeroObjectId: createdNote.creditNoteID,
          xeroObjectNumber: createdNote.creditNoteNumber ?? null,
          role: linkRole,
        },
      ],
    });

    logger.info(
      { paymentId, creditNoteId: createdNote.creditNoteID },
      "Created unapplied Xero credit note for account credit"
    );

    return createdNote.creditNoteID;
  } catch (error) {
    await failXeroSyncOperation(operationId!, error);
    throw error;
  }
}

export async function createUnappliedXeroCreditNoteForModification(params: {
  paymentId: string;
  refundAmountCents: number;
  bookingModificationId: string;
  createdByMemberId?: string;
  syncOperationId?: string;
}): Promise<string> {
  return createUnappliedXeroCreditNote(
    params.paymentId,
    params.refundAmountCents,
    {
      createdByMemberId: params.createdByMemberId,
      syncOperationId: params.syncOperationId,
      bookingModificationId: params.bookingModificationId,
    },
  );
}

/**
 * Allocate an existing Xero credit note against an invoice.
 * Used when account credit (backed by a Xero credit note) is applied to a new booking.
 */

export async function allocateCreditNoteToInvoice(
  creditNoteId: string,
  invoiceId: string,
  amountCents: number,
  options?: {
    localModel?: string;
    localId?: string;
    role?: string;
    createdByMemberId?: string;
    syncOperationId?: string;
  }
): Promise<void> {
  const { xero, tenantId } = await getAuthenticatedXeroClient();
  const idempotencyKey = buildXeroIdempotencyKey(
    "credit-note",
    creditNoteId,
    "invoice",
    invoiceId,
    "allocation",
    amountCents,
    "v1"
  );
  let operationId = options?.syncOperationId ?? null;
  const requestPayload = {
    creditNoteId,
    invoiceId,
    amountCents,
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
      entityType: "ALLOCATION",
      operationType: "ALLOCATE",
      localModel: options?.localModel,
      localId: options?.localId,
      idempotencyKey,
      correlationKey: idempotencyKey,
      requestPayload,
      createdByMemberId: options?.createdByMemberId ?? null,
    });
    operationId = operation.id;
  }

  try {
    const response = await callXeroApi(
      () =>
        xero.accountingApi.createCreditNoteAllocation(
          tenantId,
          creditNoteId,
          {
            allocations: [
              {
                invoice: { invoiceID: invoiceId },
                amount: amountCents / 100,
                date: formatDate(new Date()),
              },
            ],
          },
          undefined,
          idempotencyKey
        ),
      {
        operation: "createCreditNoteAllocation",
        resourceType: "ALLOCATION",
        workflow: "allocateCreditNoteToInvoice",
        context: `createCreditNoteAllocation(${creditNoteId} -> ${invoiceId})`,
      }
    );

    await completeXeroSyncOperation(operationId!, {
      responsePayload: response.body,
      xeroObjectType: "ALLOCATION",
      xeroObjectId: buildSyntheticAllocationId(creditNoteId, invoiceId, amountCents),
      xeroObjectUrl: buildXeroInvoiceUrl(invoiceId),
      extraLinks:
        options?.localModel && options.localId
          ? [
              {
                localModel: options.localModel,
                localId: options.localId,
                xeroObjectType: "ALLOCATION",
                xeroObjectId: buildSyntheticAllocationId(creditNoteId, invoiceId, amountCents),
                xeroObjectUrl: buildXeroInvoiceUrl(invoiceId),
                role: options.role ?? "CREDIT_NOTE_ALLOCATION",
                metadata: {
                  creditNoteId,
                  invoiceId,
                  amountCents,
                },
              },
            ]
          : [],
    });

    logger.info(
      { creditNoteId, invoiceId, amountCents },
      "Allocated Xero credit note against invoice"
    );
  } catch (error) {
    await failXeroSyncOperation(operationId!, error);
    throw error;
  }
}

// ---------------------------------------------------------------------------
// XER-01: Xero Invoice Adjustment on Booking Modification
// ---------------------------------------------------------------------------

/**
 * Create a supplementary Xero invoice when a booking modification increases
 * the price. Optionally includes a separate line item for a late-notice
 * change fee.
 *
 * Fire-and-forget: caller should catch errors and log them.
 */
