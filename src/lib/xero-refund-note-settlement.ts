/**
 * The settling payment of a cash refund credit note, and the completion that
 * records it (`INV-PAY-101`) — one path for the first attempt and for the
 * retry that finds the note already raised (#3548).
 *
 * `createXeroCreditNote` raises the note, saves `Payment.xeroRefundCreditNoteId`
 * at once, then records the settling payment and completes the operation. A
 * process that dies between the save and the completion leaves a note with no
 * payment and no recorded outcome. Before #3548 the retry saw the saved id,
 * took the idempotency early-return and marked its row SUCCEEDED with neither
 * the payment nor `refundPaymentSkipped`, so the repair leg in
 * `xero-operation-retry.ts` never offered it and the card refund's
 * Stripe-account payment went permanently missing.
 *
 * The retry now finishes the job in place (orchestrator decision on #3548):
 * `findInterruptedRefundNoteSettlement` recognises that note, and
 * `completeInterruptedRefundNoteSettlement` asks Xero what the note carries,
 * then settles it through the same `settleRefundCreditNote` and completes it
 * through the same `refundCreditNoteCompletion` the first attempt uses. A
 * payment call that fails completes the row PARTIAL, which the repair leg
 * offers. A SUCCEEDED row carrying neither the payment nor the skip flag is no
 * longer written on this path.
 */
import type { CreditNote as XeroCreditNote, Payment as XeroPayment } from "xero-node";
import logger from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import { providerAmountToCents } from "@/lib/money-provider-amount";
import { callXeroApi, getAuthenticatedXeroClient } from "@/lib/xero-api-client";
import { asRecord, readString } from "@/lib/xero-json";
import {
  buildRefundCreditNotePayment,
  REFUND_CREDIT_NOTE_ALLOCATION_SKIP_REASON,
  resolveRefundSettlement,
  type CashRefundMethod,
} from "@/lib/xero-invoice-payments";
import { readResolvedRefundCreditNoteCoverage } from "@/lib/xero-resolved-in-xero-fences";
import {
  buildXeroIdempotencyKey,
  completeXeroSyncOperation,
  failXeroSyncOperation,
  sanitizeForJson,
  startXeroSyncOperation,
  type XeroObjectLinkInput,
  type XeroSyncOperationCompletion,
} from "@/lib/xero-sync";

type XeroClient = Awaited<ReturnType<typeof getAuthenticatedXeroClient>>["xero"];

/** Recorded when the note already carries a payment or allocation in Xero. */
export const REFUND_NOTE_SETTLED_IN_XERO_REASON =
  "The credit note was already settled or allocated in Xero when the interrupted attempt was finished, so no second payment was recorded.";
/** Recorded when an officer resolved one of this payment's refund notes by hand in Xero. */
export const REFUND_NOTE_RESOLVED_IN_XERO_REASON =
  "An officer resolved a refund credit note on this payment by hand in Xero, so the app records no payment against this note; settle it in Xero if it is still outstanding.";

type RefundPaymentBody = {
  paymentID?: string;
  invoiceNumber?: string;
  creditNoteNumber?: string;
  amount?: number;
};

export interface RefundNoteSettlementOutcome {
  refundPaymentResponseBody: RefundPaymentBody | null;
  refundPaymentErr: unknown;
  /** Set when no payment is due: the note is complete, never a leg to repair. */
  refundPaymentSkipReason: string | null;
}

/**
 * `INV-PAY-101` (owner decision, 20 Sep 2026): Xero records a payment only
 * where the money verifiably moved. A card refund settles from the Stripe
 * account; a bank-transfer refund from the club's configured account, and is
 * otherwise left UNSETTLED — visibly outstanding for the bank-feed match —
 * never marked paid from the Stripe account it did not come from. A failed
 * payment call is returned, not thrown, so the caller completes PARTIAL.
 */
export async function settleRefundCreditNote(input: {
  xero: XeroClient;
  tenantId: string;
  paymentId: string;
  creditNoteId: string;
  amountCents: number;
  refundMethod: CashRefundMethod;
  refundMethodRecorded: boolean;
  paymentDate: string;
}): Promise<RefundNoteSettlementOutcome> {
  const { xero, tenantId, paymentId, creditNoteId, refundMethod } = input;
  const settlement = await resolveRefundSettlement({
    method: refundMethod,
    methodRecorded: input.refundMethodRecorded,
  });
  if (settlement.kind === "unsettled") {
    logger.info(
      { paymentId, creditNoteId, refundMethod, reason: settlement.reason },
      "Xero refund credit note left unsettled: no verifiable settlement account for this refund"
    );
    return { refundPaymentResponseBody: null, refundPaymentErr: null, refundPaymentSkipReason: settlement.reason };
  }
  try {
    const bankCode = settlement.bankCode;
    // Keyed on the note id (#1162), so equal-amount refunds never collide
    // onto one payment key, and a retry that finishes an interrupted attempt
    // (#3548) sends the very key the first attempt sent: a payment Xero
    // already holds under it is replayed, not duplicated.
    const refundPaymentIdempotencyKey = buildXeroIdempotencyKey(
      "payment",
      paymentId,
      "refund-payment",
      creditNoteId,
      "v2"
    );
    const refundPayment = buildRefundCreditNotePayment({
      paymentId,
      creditNoteId,
      refundAmountCents: input.amountCents,
      bankCode,
      // The club's calendar day, from the persisted zone (CT-5, #2869).
      paymentDate: input.paymentDate,
      refundMethod,
    });
    const refundPaymentResponse = await callXeroApi(
      () =>
        xero.accountingApi.createPayments(
          tenantId,
          { payments: [refundPayment] },
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
    logger.info(
      { paymentId, creditNoteId, refundMethod, bankCode },
      "Xero refund payment created against the refund settlement bank account via credit note"
    );
    return {
      refundPaymentResponseBody: refundPaymentResponse.body.payments?.[0] ?? null,
      refundPaymentErr: null,
      refundPaymentSkipReason: null,
    };
  } catch (error) {
    logger.error(
      { err: error, paymentId, creditNoteId, refundMethod },
      "Failed to create Xero refund payment against the refund settlement bank account via credit note"
    );
    return { refundPaymentResponseBody: null, refundPaymentErr: error, refundPaymentSkipReason: null };
  }
}

/**
 * The completion a refund credit note's operation is closed with: PARTIAL
 * exactly when the settling payment failed, and the payload the repair leg
 * reads (`refundPayment`, `refundPaymentSkipped`).
 */
export function refundCreditNoteCompletion(input: {
  paymentId: string;
  creditNoteBody: unknown;
  creditNoteId: string;
  creditNoteNumber: string | null;
  /** The note link's metadata; omitted where the link already carries its own. */
  noteLinkMetadata?: Record<string, unknown>;
  originalInvoiceId: string;
  refundPaymentAmountCents: number;
  refundMethod: CashRefundMethod;
  outcome: RefundNoteSettlementOutcome;
  extraResponse?: Record<string, unknown>;
}): XeroSyncOperationCompletion {
  const { paymentId, creditNoteId, creditNoteNumber, outcome } = input;
  const paymentBody = outcome.refundPaymentResponseBody;
  const paymentLinks: XeroObjectLinkInput[] = paymentBody?.paymentID
    ? [
        {
          localModel: "Payment",
          localId: paymentId,
          xeroObjectType: "PAYMENT",
          xeroObjectId: paymentBody.paymentID,
          xeroObjectNumber: paymentBody.creditNoteNumber ?? paymentBody.invoiceNumber ?? null,
          role: "REFUND_PAYMENT",
          metadata: {
            creditNoteId,
            invoiceId: input.originalInvoiceId,
            amountCents: input.refundPaymentAmountCents,
          },
        },
      ]
    : [];
  return {
    status: outcome.refundPaymentErr ? "PARTIAL" : "SUCCEEDED",
    responsePayload: {
      creditNote: input.creditNoteBody,
      allocation: null,
      allocationSkipped: true,
      allocationSkipReason: REFUND_CREDIT_NOTE_ALLOCATION_SKIP_REASON,
      refundPayment: paymentBody,
      refundPaymentError: outcome.refundPaymentErr,
      // Read by the repair leg (`INV-PAY-101`): an unsettled-by-design note
      // is complete, not a payment leg waiting to be repaired.
      refundPaymentSkipped: outcome.refundPaymentSkipReason !== null,
      refundPaymentSkipReason: outcome.refundPaymentSkipReason,
      refundMethod: input.refundMethod,
      ...(input.extraResponse ?? {}),
    },
    xeroObjectType: "CREDIT_NOTE",
    xeroObjectId: creditNoteId,
    xeroObjectNumber: creditNoteNumber,
    extraLinks: [
      {
        localModel: "Payment",
        localId: paymentId,
        xeroObjectType: "CREDIT_NOTE",
        xeroObjectId: creditNoteId,
        xeroObjectNumber: creditNoteNumber,
        role: "REFUND_CREDIT_NOTE",
        ...(input.noteLinkMetadata ? { metadata: input.noteLinkMetadata } : {}),
      },
      ...paymentLinks,
    ],
  };
}

/**
 * Whether the payment's saved refund note is the residue of an interrupted
 * first attempt (#3548): no `REFUND_PAYMENT` link names it, and no
 * create operation for it recorded how its payment went — none completed
 * PARTIAL (the repair leg owns those), none recorded a payment or a skip by
 * design (`INV-PAY-101`: never re-repaired), none was resolved in Xero
 * (`INV-INT-025`). Null when the note's outcome is already on record, which
 * keeps the plain idempotent early-return for every ordinary replay.
 */
export async function findInterruptedRefundNoteSettlement(
  paymentId: string,
  creditNoteId: string,
): Promise<{ noteLinked: boolean } | null> {
  const paymentLinks = await prisma.xeroObjectLink.findMany({
    where: { localModel: "Payment", localId: paymentId, xeroObjectType: "PAYMENT", role: "REFUND_PAYMENT" },
    select: { metadata: true },
  });
  if ((paymentLinks ?? []).some((link) => readString(asRecord(link.metadata)?.creditNoteId) === creditNoteId)) {
    return null;
  }
  const operations = await prisma.xeroSyncOperation.findMany({
    where: {
      direction: "OUTBOUND",
      entityType: "CREDIT_NOTE",
      operationType: "CREATE",
      localModel: "Payment",
      localId: paymentId,
      xeroObjectId: creditNoteId,
    },
    select: { status: true, responsePayload: true, manuallyResolvedAt: true },
  });
  const outcomeRecorded = (operations ?? []).some((operation) => {
    const response = asRecord(operation.responsePayload);
    return (
      operation.status === "PARTIAL" ||
      operation.manuallyResolvedAt !== null ||
      asRecord(response?.refundPayment) !== null ||
      response?.refundPaymentSkipped === true
    );
  });
  if (outcomeRecorded) return null;
  const noteLink = await prisma.xeroObjectLink.findFirst({
    where: {
      localModel: "Payment",
      localId: paymentId,
      xeroObjectType: "CREDIT_NOTE",
      xeroObjectId: creditNoteId,
      role: "REFUND_CREDIT_NOTE",
    },
    select: { id: true },
  });
  return { noteLinked: Boolean(noteLink) };
}

function isLivePayment(payment: XeroPayment): boolean {
  return Boolean(payment.paymentID) && String(payment.status ?? "") !== "DELETED";
}

/**
 * Finish an interrupted first attempt (#3548): read the note back from Xero,
 * record its settling payment (or the skip) through the first attempt's own
 * leg, and complete the operation with the first attempt's payload shape.
 *
 * Never a second payment: a note Xero already shows paid, part-paid or
 * allocated — our own payment whose link was never written, or an officer's by
 * hand — is recorded as it stands. A voided or missing note throws, so the row
 * fails visibly rather than reading as settled.
 */
export async function completeInterruptedRefundNoteSettlement(input: {
  paymentId: string;
  creditNoteId: string;
  noteLinked: boolean;
  queuedOperationId: string | null;
  idempotencyKey: string;
  originalInvoiceId: string;
  refundMethod: CashRefundMethod;
  refundMethodRecorded: boolean;
  paymentDate: string;
  watermarkCents: number | null;
  lateCaptureFields: { paymentIntentId?: string; documentDate?: string };
  createdByMemberId: string | null;
}): Promise<void> {
  const { paymentId, creditNoteId } = input;
  const { xero, tenantId } = await getAuthenticatedXeroClient();
  const response = await callXeroApi(
    () => xero.accountingApi.getCreditNote(tenantId, creditNoteId),
    {
      operation: "getCreditNote",
      resourceType: "CREDIT_NOTE",
      workflow: "createXeroCreditNote",
      context: `getCreditNote(refund settlement of ${paymentId})`,
    }
  );
  const note: XeroCreditNote | undefined = response.body.creditNotes?.[0];
  const status = String(note?.status ?? "");
  const totalCents = providerAmountToCents(note?.total);
  if (!note?.creditNoteID || totalCents === null || status === "VOIDED" || status === "DELETED") {
    throw new Error(
      `Refund credit note ${creditNoteId} for payment ${paymentId} is ${status || "missing"} in Xero, so its settling payment cannot be recorded (#3548). Check the refund in Xero and record it by hand.`
    );
  }
  const remainingCents = providerAmountToCents(note.remainingCredit);
  const livePayments = (note.payments ?? []).filter(isLivePayment);
  const settledInXero =
    livePayments.length > 0 || status === "PAID" || (remainingCents !== null && remainingCents < totalCents);

  const requestPayload = {
    allocation: { invoiceId: input.originalInvoiceId, amount: totalCents / 100 },
    refundMethod: input.refundMethod,
    ...input.lateCaptureFields,
    interruptedAttemptCreditNoteId: creditNoteId,
  };
  let operationId = input.queuedOperationId;
  if (operationId) {
    await prisma.xeroSyncOperation.update({
      where: { id: operationId },
      data: { requestPayload: sanitizeForJson(requestPayload) },
    });
  } else {
    const operation = await startXeroSyncOperation({
      direction: "OUTBOUND",
      entityType: "CREDIT_NOTE",
      operationType: "CREATE",
      localModel: "Payment",
      localId: paymentId,
      idempotencyKey: input.idempotencyKey,
      correlationKey: input.idempotencyKey,
      requestPayload,
      createdByMemberId: input.createdByMemberId,
    });
    operationId = operation.id;
  }

  try {
    let outcome: RefundNoteSettlementOutcome;
    let paidCents = totalCents;
    if (settledInXero) {
      const found = livePayments[0];
      paidCents = providerAmountToCents(found?.amount) ?? totalCents;
      logger.warn(
        { paymentId, creditNoteId, status, payments: livePayments.length },
        "Interrupted Xero refund credit note is already settled in Xero; recording it without a second payment (#3548)"
      );
      outcome = found
        ? {
            refundPaymentResponseBody: { paymentID: found.paymentID, amount: found.amount },
            refundPaymentErr: null,
            refundPaymentSkipReason: null,
          }
        : { refundPaymentResponseBody: null, refundPaymentErr: null, refundPaymentSkipReason: REFUND_NOTE_SETTLED_IN_XERO_REASON };
    } else {
      const resolved = await readResolvedRefundCreditNoteCoverage(paymentId);
      if (resolved.operationIds.length > 0 || resolved.unreadableOperationIds.length > 0) {
        logger.warn(
          { paymentId, creditNoteId, resolvedOperationIds: [...resolved.operationIds, ...resolved.unreadableOperationIds] },
          "Interrupted Xero refund credit note left unsettled: an officer resolved a refund note on this payment by hand in Xero (#3548, INV-INT-025)"
        );
        outcome = { refundPaymentResponseBody: null, refundPaymentErr: null, refundPaymentSkipReason: REFUND_NOTE_RESOLVED_IN_XERO_REASON };
      } else {
        outcome = await settleRefundCreditNote({
          xero,
          tenantId,
          paymentId,
          creditNoteId,
          amountCents: totalCents,
          refundMethod: input.refundMethod,
          refundMethodRecorded: input.refundMethodRecorded,
          paymentDate: input.paymentDate,
        });
      }
    }

    await completeXeroSyncOperation(
      operationId,
      refundCreditNoteCompletion({
        paymentId,
        creditNoteBody: response.body,
        creditNoteId,
        creditNoteNumber: note.creditNoteNumber ?? null,
        // A link written earlier keeps its own amounts; only a note the
        // interrupted attempt never linked is given them here.
        noteLinkMetadata: input.noteLinked
          ? undefined
          : {
              amountCents: totalCents,
              watermarkCents: input.watermarkCents ?? totalCents,
              ...(input.lateCaptureFields.paymentIntentId
                ? { paymentIntentId: input.lateCaptureFields.paymentIntentId }
                : {}),
            },
        originalInvoiceId: input.originalInvoiceId,
        refundPaymentAmountCents: paidCents,
        refundMethod: input.refundMethod,
        outcome,
        extraResponse: { interruptedAttemptCompleted: true },
      })
    );
  } catch (error) {
    await failXeroSyncOperation(operationId, error);
    throw error;
  }
}
