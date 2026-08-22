/**
 * Stripe-to-Xero payment creation against invoices and credit notes.
 *
 * Records a Stripe payment as a Xero payment against the booking invoice
 * (`createXeroPaymentForInvoice`) and a Stripe refund as a credit-note
 * payment against a previously-created refund credit note
 * (`createXeroRefundPaymentForInvoice`).
 *
 * Also exposes the shared refund-payment builder used by
 * `xero-credit-notes.createXeroCreditNote` when it settles the refund
 * credit note inline.
 */

import { Payment as XeroPayment } from "xero-node";
import { CLUB_NAME } from "@/config/club-identity";
import {
  buildXeroIdempotencyKey,
  completeXeroSyncOperation,
  failXeroSyncOperation,
  startXeroSyncOperation,
} from "@/lib/xero-sync";
import {
  callXeroApi,
  getAuthenticatedXeroClient,
} from "./xero-api-client";
import { getAccountMapping } from "./xero-mappings";
import { readClubTimeZoneOutsideRequest } from "@/lib/club-time-zone-runtime";
import { xeroDocumentDateForClubToday } from "@/lib/xero-provider-dates";

export const REFUND_CREDIT_NOTE_ALLOCATION_SKIP_REASON =
  "Refund credit notes are settled via a credit-note payment instead of invoice allocation.";

interface CreateXeroInvoicePaymentParams {
  localModel: string;
  localId: string;
  invoiceId: string;
  amountCents: number;
  idempotencyKey: string;
  reference: string;
  role: string;
  createdByMemberId?: string;
  metadata?: Record<string, unknown>;
}

export async function createXeroPaymentForInvoice(
  params: CreateXeroInvoicePaymentParams
): Promise<string> {
  const { xero, tenantId } = await getAuthenticatedXeroClient();
  const bankCode = (await getAccountMapping("stripeBankAccount")) ?? "606";
  const payment: XeroPayment = {
    invoice: { invoiceID: params.invoiceId },
    account: { code: bankCode },
    amount: params.amountCents / 100,
    // A payment date is bank-reconciliation input and decides the GST period the
    // cash falls in, so it is the club's calendar day rather than the UTC one,
    // which is still yesterday all New Zealand morning (INV-DATE-019, #2834) —
    // and "the club's" now means the PERSISTED zone rather than the container's
    // `TZ` (CT-5, #2869; INV-CONFIG-002).
    date: xeroDocumentDateForClubToday(await readClubTimeZoneOutsideRequest()),
    reference: params.reference,
  };

  const operation = await startXeroSyncOperation({
    direction: "OUTBOUND",
    entityType: "PAYMENT",
    operationType: "CREATE",
    localModel: params.localModel,
    localId: params.localId,
    idempotencyKey: params.idempotencyKey,
    correlationKey: params.idempotencyKey,
    requestPayload: { payments: [payment] },
    createdByMemberId: params.createdByMemberId ?? null,
  });

  try {
    const response = await callXeroApi(
      () =>
        xero.accountingApi.createPayments(
          tenantId,
          { payments: [payment] },
          undefined,
          params.idempotencyKey
        ),
      {
        operation: "createPayments",
        resourceType: "PAYMENT",
        workflow: "createXeroPaymentForInvoice",
        context: `createPayment(${params.localModel} ${params.localId})`,
      }
    );

    const createdPayment = response.body.payments?.[0];
    if (!createdPayment?.paymentID) {
      throw new Error("Failed to create Xero payment");
    }

    await completeXeroSyncOperation(operation.id, {
      responsePayload: response.body,
      xeroObjectType: "PAYMENT",
      xeroObjectId: createdPayment.paymentID,
      xeroObjectNumber: createdPayment.invoiceNumber ?? null,
      extraLinks: [
        {
          localModel: params.localModel,
          localId: params.localId,
          xeroObjectType: "PAYMENT",
          xeroObjectId: createdPayment.paymentID,
          xeroObjectNumber: createdPayment.invoiceNumber ?? null,
          role: params.role,
          metadata: params.metadata,
        },
      ],
    });

    return createdPayment.paymentID;
  } catch (error) {
    await failXeroSyncOperation(operation.id, error);
    throw error;
  }
}

interface CreateXeroRefundPaymentParams {
  paymentId: string;
  invoiceId: string;
  creditNoteId: string;
  refundAmountCents: number;
  createdByMemberId?: string;
}

/**
 * `paymentDate` is an ARGUMENT, not a clock read (CT-5, #2869).
 *
 * This builder is called from two places, one of them inside a provider-retry
 * closure, and it must be a pure function of its inputs so a retry sends the
 * date it first sent. The caller supplies the club's calendar day, which it
 * reads once from the PERSISTED club timezone (`INV-CONFIG-002`) — never from
 * the container's `TZ`, and never twice.
 */
export function buildRefundCreditNotePayment(params: {
  paymentId: string;
  creditNoteId: string;
  refundAmountCents: number;
  bankCode: string;
  paymentDate: string;
}): XeroPayment {
  return {
    creditNote: { creditNoteID: params.creditNoteId },
    account: { code: params.bankCode },
    amount: params.refundAmountCents / 100,
    date: params.paymentDate,
    reference: `Stripe Refund - ${CLUB_NAME} payment ${params.paymentId.slice(0, 8)}`,
    isReconciled: false,
  };
}

// test seam
export async function createXeroRefundPaymentForInvoice(
  params: CreateXeroRefundPaymentParams
): Promise<string> {
  const { xero, tenantId } = await getAuthenticatedXeroClient();
  const bankCode = (await getAccountMapping("stripeBankAccount")) ?? "606";
  const payment = buildRefundCreditNotePayment({
    paymentId: params.paymentId,
    creditNoteId: params.creditNoteId,
    refundAmountCents: params.refundAmountCents,
    bankCode,
    paymentDate: xeroDocumentDateForClubToday(await readClubTimeZoneOutsideRequest()),
  });
  // Key on the credit note id (#1162): equal-amount refund deltas each settle a
  // distinct credit note, so amount alone would collide onto one payment key.
  const idempotencyKey = buildXeroIdempotencyKey(
    "payment",
    params.paymentId,
    "refund-payment",
    params.refundAmountCents,
    params.creditNoteId,
    "v2"
  );
  const operation = await startXeroSyncOperation({
    direction: "OUTBOUND",
    entityType: "PAYMENT",
    operationType: "CREATE",
    localModel: "Payment",
    localId: params.paymentId,
    idempotencyKey,
    correlationKey: idempotencyKey,
    requestPayload: {
      payments: [payment],
      invoiceId: params.invoiceId,
      creditNoteId: params.creditNoteId,
    },
    createdByMemberId: params.createdByMemberId ?? null,
  });

  try {
    const response = await callXeroApi(
      () =>
        xero.accountingApi.createPayments(
          tenantId,
          { payments: [payment] },
          undefined,
          idempotencyKey
        ),
      {
        operation: "createPayments",
        resourceType: "PAYMENT",
        workflow: "createXeroRefundPaymentForInvoice",
        context: `createPayments(refund repair ${params.paymentId})`,
      }
    );

    const createdPayment = response.body.payments?.[0];
    if (!createdPayment?.paymentID) {
      throw new Error("Failed to create Xero refund payment");
    }
    const createdPaymentNumber =
      createdPayment.creditNoteNumber ??
      createdPayment.invoiceNumber ??
      ((
        createdPayment as unknown as {
          creditNote?: {
            creditNoteNumber?: string | null;
            CreditNoteNumber?: string | null;
          } | null;
        }
      ).creditNote?.creditNoteNumber ??
        (
          createdPayment as unknown as {
            creditNote?: {
              creditNoteNumber?: string | null;
              CreditNoteNumber?: string | null;
            } | null;
          }
        ).creditNote?.CreditNoteNumber ??
        null);

    await completeXeroSyncOperation(operation.id, {
      responsePayload: response.body,
      xeroObjectType: "PAYMENT",
      xeroObjectId: createdPayment.paymentID,
      xeroObjectNumber: createdPaymentNumber,
      extraLinks: [
        {
          localModel: "Payment",
          localId: params.paymentId,
          xeroObjectType: "PAYMENT",
          xeroObjectId: createdPayment.paymentID,
          xeroObjectNumber: createdPaymentNumber,
          role: "REFUND_PAYMENT",
          metadata: {
            creditNoteId: params.creditNoteId,
            invoiceId: params.invoiceId,
            amountCents: params.refundAmountCents,
          },
        },
      ],
    });

    return createdPayment.paymentID;
  } catch (error) {
    await failXeroSyncOperation(operation.id, error);
    throw error;
  }
}
