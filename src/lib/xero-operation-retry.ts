import type { XeroContactUpdateData } from "@/lib/xero-contacts";
import {
  readQueuedOutboxPayload,
  XERO_OUTBOX_ACCOUNT_CREDIT_NOTE_TYPE,
  XERO_OUTBOX_APPLIED_CREDIT_ALLOCATION_TYPE,
  XERO_OUTBOX_APPLIED_CREDIT_DEALLOCATION_TYPE,
  XERO_OUTBOX_MODIFICATION_ACCOUNT_CREDIT_NOTE_TYPE,
  XERO_OUTBOX_MODIFICATION_CREDIT_NOTE_TYPE,
  XERO_OUTBOX_REFUND_CREDIT_NOTE_TYPE,
  XERO_OUTBOX_SUPPLEMENTARY_INVOICE_TYPE,
} from "@/lib/xero-operation-outbox-payload";
import { getModificationNetAmountCents } from "@/lib/xero-booking-repair-analysis";
import type { XeroSyncOperation } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { asRecord, readNumber, readString } from "@/lib/xero-json";
import { providerAmountToCents } from "@/lib/money-provider-amount";
import { shouldRepairXeroContactNameOrder } from "@/lib/xero-contact-sync";
import { parseXeroContactDateOfBirth } from "@/lib/xero-contact-date-of-birth";
import { buildXeroIdempotencyKey, completeXeroSyncOperation } from "@/lib/xero-sync";
import { CLUB_NAME } from "@/config/club-identity";

type RetryableOperation = Pick<
  XeroSyncOperation,
  | "id"
  | "status"
  | "replayable"
  | "direction"
  | "entityType"
  | "operationType"
  | "localModel"
  | "localId"
  | "requestPayload"
  | "responsePayload"
  | "xeroObjectId"
  | "xeroObjectNumber"
> & {
  // #1354: enqueue-time queue type (never updated afterward) — the only
  // reliable delta-mode marker once a handler has overwritten requestPayload.
  // Optional so row shapes selected before #1354 stay assignable; callers
  // that omit it simply fall back to payload-based delta detection.
  queueType?: XeroSyncOperation["queueType"];
};

export class XeroOperationRetryError extends Error {
  status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = "XeroOperationRetryError";
    this.status = status;
  }
}

export interface XeroOperationRetryMeta {
  supported: boolean;
  reason: string | null;
}

function readAppliedCreditAllocationChildContext(payload: unknown): {
  parentOperationId: string | null;
  bookingId: string;
  paymentId: string;
} | null {
  const context = asRecord(asRecord(payload)?.appliedCreditContext);
  const bookingId = readString(context?.bookingId);
  const paymentId = readString(context?.paymentId);
  if (!bookingId || !paymentId) return null;
  return {
    parentOperationId: readString(context?.parentOperationId),
    bookingId,
    paymentId,
  };
}

function isLegacyContextlessAppliedCreditAllocationChild(
  operation: RetryableOperation,
): boolean {
  if (
    operation.entityType !== "ALLOCATION" ||
    operation.operationType !== "ALLOCATE" ||
    !parseAllocationRetryInput(operation)
  ) {
    return false;
  }

  if (operation.localModel === "MemberCreditNoteAllocation") {
    // #1620 existing-note children always used the precise slice as their local
    // record. No unrelated allocation workflow uses this model.
    return true;
  }

  const payload = asRecord(operation.requestPayload);
  // Before appliedCreditContext was added, the only direct (non-queue-shaped)
  // Payment allocation emitted by the codebase was the #1620 minted-remainder
  // child. Explicit queueType payloads remain eligible for their normal repair
  // path, preserving unrelated CREDIT_NOTE_ALLOCATION retries.
  return (
    operation.localModel === "Payment" &&
    !readString(payload?.queueType)
  );
}

const REFUND_CREDIT_NOTE_ALLOCATION_SKIP_REASON =
  "Refund credit notes are settled via a credit-note payment instead of invoice allocation.";
const REDACTED_SECRET = "[REDACTED]";

const MEMBER_CONTACT_RETRY_SELECT = {
  xeroContactId: true,
  firstName: true,
  lastName: true,
  email: true,
  dateOfBirth: true,
  phoneCountryCode: true,
  phoneAreaCode: true,
  phoneNumber: true,
  streetAddressLine1: true,
  streetAddressLine2: true,
  streetCity: true,
  streetRegion: true,
  streetPostalCode: true,
  streetCountry: true,
  postalAddressLine1: true,
  postalAddressLine2: true,
  postalCity: true,
  postalRegion: true,
  postalPostalCode: true,
  postalCountry: true,
} as const;

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function readPayloadContact(operation: Pick<RetryableOperation, "requestPayload">): Record<string, unknown> | null {
  const payload = asRecord(operation.requestPayload);
  const contact = payload ? asArray(payload.contacts)[0] : null;
  return asRecord(contact);
}

function parseContactUpdateRetryInput(
  operation: Pick<RetryableOperation, "requestPayload" | "xeroObjectId">
): { xeroContactId: string; data: XeroContactUpdateData; preserveXeroName: boolean } | null {
  const contact = readPayloadContact(operation);
  if (!contact) {
    return null;
  }

  const xeroContactId = readString(contact.contactID) ?? operation.xeroObjectId;
  const name = readString(contact.name);
  const firstName = readString(contact.firstName);
  const lastName = readString(contact.lastName);
  const email = readString(contact.emailAddress);
  const preserveXeroName = !name && !firstName && !lastName;

  if (!xeroContactId || !email || (!preserveXeroName && (!firstName || !lastName))) {
    return null;
  }

  const phone = asRecord(asArray(contact.phones)[0]);
  const addresses = asArray(contact.addresses).map(asRecord).filter((value): value is Record<string, unknown> => Boolean(value));
  const street = addresses.find((address) => readString(address.addressType) === "STREET") ?? null;
  const postal = addresses.find((address) => readString(address.addressType) === "POBOX") ?? null;

  return {
    xeroContactId,
    data: {
      ...(firstName ? { firstName } : {}),
      ...(lastName ? { lastName } : {}),
      email,
      // #2859: `companyNumber` is redacted out of the STORED payload, because
      // it now carries a date of birth (INV-PRIV-011). A replay therefore
      // reconstructs no date of birth and sends none, which leaves Xero's copy
      // exactly as it is — the same "never assert an absence" rule the writer
      // follows. A Member-scoped retry does not come through here at all: it
      // rebuilds the authoritative payload from the Member row.
      dateOfBirth: parseXeroContactDateOfBirth(readString(contact.companyNumber)),
      phoneCountryCode: readString(phone?.phoneCountryCode),
      phoneAreaCode: readString(phone?.phoneAreaCode),
      phoneNumber: readString(phone?.phoneNumber),
      streetAddressLine1: readString(street?.addressLine1),
      streetAddressLine2: readString(street?.addressLine2),
      streetCity: readString(street?.city),
      streetRegion: readString(street?.region),
      streetPostalCode: readString(street?.postalCode),
      streetCountry: readString(street?.country),
      postalAddressLine1: readString(postal?.addressLine1),
      postalAddressLine2: readString(postal?.addressLine2),
      postalCity: readString(postal?.city),
      postalRegion: readString(postal?.region),
      postalPostalCode: readString(postal?.postalCode),
      postalCountry: readString(postal?.country),
    },
    preserveXeroName,
  };
}

async function buildCurrentMemberContactUpdateRetryInput(
  operation: Pick<RetryableOperation, "localModel" | "localId">
): Promise<{
  xeroContactId: string;
  preserveXeroName: boolean;
  memberScoped: true;
} | null> {
  if (operation.localModel !== "Member" || !operation.localId) {
    return null;
  }

  const member = await prisma.member.findUnique({
    where: { id: operation.localId },
    select: MEMBER_CONTACT_RETRY_SELECT,
  });

  if (!member?.xeroContactId) {
    return null;
  }

  const shouldRepairContactNameOrder = await shouldRepairXeroContactNameOrder(member);

  return {
    xeroContactId: member.xeroContactId,
    preserveXeroName: !shouldRepairContactNameOrder,
    memberScoped: true,
  };
}

function containsRedactedContactRetryData(input: { data: XeroContactUpdateData }) {
  return Object.values(input.data).some((value) => value === REDACTED_SECRET);
}

function parsePaymentCreditNoteRetryInput(
  operation: Pick<RetryableOperation, "requestPayload">
): {
  amountCents: number;
  kind: "refund" | "unapplied";
  /**
   * F4 (#1354): present when the operation is a per-delta Stripe refund note.
   * The retry MUST re-enter delta mode — pre-#1354 it dropped the watermark,
   * fell into legacy single-note mode, and silently skipped as soon as ANY
   * refund note existed, reporting the swallowed delta as resolved. The
   * value itself is advisory: createXeroCreditNote recomputes coverage at
   * execution time.
   */
  watermarkCents?: number;
} | null {
  const payload = asRecord(operation.requestPayload);
  if (!payload) {
    return null;
  }

  // Queued payload shape (#1354): an operation that failed BEFORE the handler
  // overwrote requestPayload still carries the enqueue-time
  // {queueType, refundAmountCents[, watermarkCents]} — previously unparseable
  // here, leaving operator-reset operations permanently dead-ended.
  const queueType = typeof payload.queueType === "string" ? payload.queueType : null;
  const queuedRefundAmount = readNumber(payload.refundAmountCents);
  if (queueType === XERO_OUTBOX_REFUND_CREDIT_NOTE_TYPE && queuedRefundAmount !== null) {
    const queuedWatermark = readNumber(payload.watermarkCents);
    return {
      amountCents: Math.round(queuedRefundAmount),
      kind: "refund",
      watermarkCents: queuedWatermark !== null ? Math.round(queuedWatermark) : 0,
    };
  }
  if (queueType === XERO_OUTBOX_ACCOUNT_CREDIT_NOTE_TYPE && queuedRefundAmount !== null) {
    return {
      amountCents: Math.round(queuedRefundAmount),
      kind: "unapplied",
    };
  }

  const allocation = asRecord(payload.allocation);
  const allocationAmountCents = providerAmountToCents(readNumber(allocation?.amount));
  if (allocationAmountCents !== null) {
    return {
      amountCents: allocationAmountCents,
      kind: "refund",
    };
  }

  const creditNote = asRecord(asArray(payload.creditNotes)[0]);
  const lineItem = asRecord(creditNote ? asArray(creditNote.lineItems)[0] : null);
  const unitAmountCents = providerAmountToCents(readNumber(lineItem?.unitAmount));
  if (unitAmountCents === null) {
    return null;
  }

  return {
    amountCents: unitAmountCents,
    kind: "unapplied",
  };
}

function parseMembershipCancellationCreditNoteRetryInput(
  operation: Pick<RetryableOperation, "requestPayload">
): { requestId: string; participantId: string } | null {
  const payload = asRecord(operation.requestPayload);
  if (!payload) {
    return null;
  }

  const requestId = readString(payload.requestId);
  const participantId = readString(payload.participantId);

  if (!requestId || !participantId) {
    return null;
  }

  return { requestId, participantId };
}

function parseAllocationRetryInput(
  operation: Pick<RetryableOperation, "requestPayload">
): { creditNoteId: string; invoiceId: string; amountCents: number } | null {
  const payload = asRecord(operation.requestPayload);
  if (!payload) {
    return null;
  }

  const creditNoteId = readString(payload.creditNoteId);
  const invoiceId = readString(payload.invoiceId);
  const amountCents = readNumber(payload.amountCents);

  if (!creditNoteId || !invoiceId || amountCents === null) {
    return null;
  }

  return { creditNoteId, invoiceId, amountCents };
}

function parseSubscriptionRetryInput(
  operation: Pick<RetryableOperation, "requestPayload">
): { seasonYear?: number } | null {
  const payload = asRecord(operation.requestPayload);
  if (!payload) {
    return { seasonYear: undefined };
  }

  const seasonYear = readNumber(payload.seasonYear);
  if (seasonYear === null) {
    return { seasonYear: undefined };
  }

  return { seasonYear };
}

function readStoredInvoiceTotalCents(
  operation: Pick<RetryableOperation, "requestPayload" | "responsePayload">
): number | null {
  const responsePayload = asRecord(operation.responsePayload);
  const invoiceResponse = asRecord(responsePayload?.invoice);
  const responseInvoice = asRecord(asArray(invoiceResponse?.invoices)[0]);
  const responseTotalCents = providerAmountToCents(readNumber(responseInvoice?.total));
  if (responseTotalCents !== null) {
    return responseTotalCents;
  }

  const requestPayload = asRecord(operation.requestPayload);
  const requestInvoice = asRecord(asArray(requestPayload?.invoices)[0]);
  const lineItems = asArray(requestInvoice?.lineItems)
    .map(asRecord)
    .filter((value): value is Record<string, unknown> => Boolean(value));

  if (lineItems.length === 0) {
    return null;
  }

  const totalCents = lineItems.reduce((sum, lineItem) => {
    const quantity = readNumber(lineItem.quantity) ?? 1;
    const unitAmount = readNumber(lineItem.unitAmount);
    if (unitAmount === null) {
      return sum;
    }

    // `unitAmount * quantity` first, then the cents boundary — the same
    // left-to-right evaluation the inline `Math.round(unitAmount * quantity *
    // 100)` performed, so the stored-total comparison is unchanged (#2685).
    const lineTotalCents = providerAmountToCents(unitAmount * quantity);
    return lineTotalCents === null ? sum : sum + lineTotalCents;
  }, 0);

  return totalCents > 0 || lineItems.some((lineItem) => readNumber(lineItem.unitAmount) === 0)
    ? totalCents
    : null;
}

/**
 * Whether a PARTIAL invoice-create operation is a PAYMENT problem at all.
 *
 * The repair handler for a PARTIAL invoice create is `createXeroPaymentForInvoice`
 * — it records a payment against the invoice. That is right when the payment
 * write is what failed, and dangerous otherwise: an invoice can also be marked
 * PARTIAL because only its EMAIL failed, and every such case is an
 * INTERNET_BANKING booking whose Xero payment is deliberately skipped because
 * the member has not paid yet. Repairing one of those records a bank payment
 * against an unpaid invoice and falsely settles it (#2258 review finding; the
 * hazard predates the switch but the fail-closed email gate routes more traffic
 * into it).
 *
 * Positive evidence only. A payload with a real `paymentError`, or one whose
 * shape we do not recognise, keeps the pre-existing behaviour; the repair is
 * refused only when the payload positively says the payment was skipped or that
 * the fault was the invoice email.
 */
function partialInvoiceOperationHasPaymentFault(
  operation: Pick<RetryableOperation, "responsePayload">
): boolean {
  const payload = asRecord(operation.responsePayload);
  if (!payload) return true;
  if (payload.paymentError != null) return true;
  if (payload.paymentSkipped === true) return false;
  if (payload.invoiceEmailError != null) return false;
  if (payload.invoiceEmailWithheldByNoEmails === true) return false;
  return true;
}

function parsePartialInvoiceRepairInput(
  operation: Pick<RetryableOperation, "localModel" | "localId" | "xeroObjectId" | "requestPayload" | "responsePayload">
): { invoiceId: string; amountCents: number; linkRole: string; idempotencyKey: string; reference: string } | null {
  if (!operation.localModel || !operation.localId || !operation.xeroObjectId) {
    return null;
  }

  const amountCents = readStoredInvoiceTotalCents(operation);
  if (amountCents === null) {
    return null;
  }

  if (operation.localModel === "Payment") {
    return {
      invoiceId: operation.xeroObjectId,
      amountCents,
      linkRole: "INVOICE_PAYMENT",
      idempotencyKey: buildXeroIdempotencyKey(
        "payment",
        operation.localId,
        "invoice-payment",
        "v1"
      ),
      reference:
        amountCents > 0
          ? `${CLUB_NAME} invoice payment ${operation.localId.slice(0, 8)}`
          : "Zero-dollar booking (100% promo discount)",
    };
  }

  if (operation.localModel === "Booking" || operation.localModel === "BookingModification") {
    return {
      invoiceId: operation.xeroObjectId,
      amountCents,
      linkRole: "SUPPLEMENTARY_INVOICE_PAYMENT",
      idempotencyKey: buildXeroIdempotencyKey(
        operation.localModel === "BookingModification" ? "booking-mod" : "booking",
        operation.localId,
        "supplementary-payment",
        amountCents,
        "v1"
      ),
      reference: `${CLUB_NAME} supplementary payment ${operation.localId.slice(0, 8)}`,
    };
  }

  return null;
}

function parseRefundCreditNoteRepairInput(
  operation: Pick<RetryableOperation, "localModel" | "localId" | "requestPayload" | "responsePayload" | "xeroObjectId">
): { creditNoteId: string; invoiceId: string; amountCents: number; needsRefundPaymentRepair: boolean } | null {
  if (operation.localModel !== "Payment" || !operation.localId || !operation.xeroObjectId) {
    return null;
  }

  const payload = asRecord(operation.requestPayload);
  const allocation = asRecord(payload?.allocation);
  const invoiceId = readString(allocation?.invoiceId);
  const amount = readNumber(allocation?.amount);
  if (!invoiceId || amount === null) {
    return null;
  }

  const amountCents = providerAmountToCents(amount);
  if (amountCents === null) {
    return null;
  }

  const responsePayload = asRecord(operation.responsePayload);
  return {
    creditNoteId: operation.xeroObjectId,
    invoiceId,
    amountCents,
    needsRefundPaymentRepair: !asRecord(responsePayload?.refundPayment),
  };
}

async function repairRefundCreditNoteFollowUpActions(
  operation: Pick<RetryableOperation, "id" | "localId" | "responsePayload" | "xeroObjectNumber">,
  xero: typeof import("@/lib/xero"),
  repair: {
    creditNoteId: string;
    invoiceId: string;
    amountCents: number;
    needsRefundPaymentRepair: boolean;
  },
  createdByMemberId?: string
) {
  await prisma.payment.update({
    where: { id: operation.localId! },
    data: {
      xeroRefundCreditNoteId: repair.creditNoteId,
    },
  });

  if (repair.needsRefundPaymentRepair) {
    await xero.createXeroRefundPaymentForInvoice({
      paymentId: operation.localId!,
      invoiceId: repair.invoiceId,
      creditNoteId: repair.creditNoteId,
      refundAmountCents: repair.amountCents,
      createdByMemberId,
    });
  }

  const existingResponsePayload = asRecord(operation.responsePayload);
  await completeXeroSyncOperation(operation.id, {
    status: "SUCCEEDED",
    responsePayload: {
      ...(existingResponsePayload ?? {}),
      allocation: null,
      allocationSkipped: true,
      allocationSkipReason: REFUND_CREDIT_NOTE_ALLOCATION_SKIP_REASON,
      refundPaymentError: null,
    },
    xeroObjectType: "CREDIT_NOTE",
    xeroObjectId: repair.creditNoteId,
    xeroObjectNumber: operation.xeroObjectNumber ?? null,
    extraLinks: [
      {
        localModel: "Payment",
        localId: operation.localId!,
        xeroObjectType: "CREDIT_NOTE",
        xeroObjectId: repair.creditNoteId,
        xeroObjectNumber: operation.xeroObjectNumber ?? null,
        role: "REFUND_CREDIT_NOTE",
      },
    ],
  });
}

function parseModificationCreditNoteRepairInput(
  operation: Pick<RetryableOperation, "localModel" | "localId" | "requestPayload" | "xeroObjectId">
): { creditNoteId: string; invoiceId: string; amountCents: number; allocationRole: string } | null {
  if (
    (!operation.localModel || (operation.localModel !== "Booking" && operation.localModel !== "BookingModification")) ||
    !operation.localId ||
    !operation.xeroObjectId
  ) {
    return null;
  }

  const payload = asRecord(operation.requestPayload);
  const invoiceId = readString(payload?.invoiceId);
  const amountCents = readNumber(payload?.refundAmountCents);
  if (!invoiceId || amountCents === null) {
    return null;
  }

  return {
    creditNoteId: operation.xeroObjectId,
    invoiceId,
    amountCents,
    allocationRole: "MODIFICATION_CREDIT_NOTE_ALLOCATION",
  };
}

export function getXeroOperationRetryMeta(operation: RetryableOperation): XeroOperationRetryMeta {
  if (!operation.replayable) {
    return {
      supported: false,
      reason: "This operation is not marked replayable.",
    };
  }

  if (operation.direction !== "OUTBOUND") {
    return {
      supported: false,
      reason: "Only outbound operations are retryable in this pass.",
    };
  }

  const queuedAppliedCredit = readQueuedOutboxPayload(operation.requestPayload);
  const isQueuedAppliedCreditOperation =
    operation.entityType === "ALLOCATION" &&
    operation.localModel === "Payment" &&
    ((queuedAppliedCredit?.queueType ===
      XERO_OUTBOX_APPLIED_CREDIT_ALLOCATION_TYPE &&
      operation.operationType === "ALLOCATE") ||
      (queuedAppliedCredit?.queueType ===
        XERO_OUTBOX_APPLIED_CREDIT_DEALLOCATION_TYPE &&
        operation.operationType === "UPDATE"));
  if (
    isQueuedAppliedCreditOperation &&
    (operation.status === "FAILED" || operation.status === "PARTIAL")
  ) {
    return { supported: true, reason: null };
  }

  const appliedCreditChild =
    operation.entityType === "ALLOCATION" &&
    operation.operationType === "ALLOCATE"
      ? readAppliedCreditAllocationChildContext(operation.requestPayload)
      : null;
  if (appliedCreditChild) {
    return {
      supported: false,
      reason: appliedCreditChild.parentOperationId
        ? `Retry the serialized parent applied-credit operation ${appliedCreditChild.parentOperationId}; this child allocation cannot run inline.`
        : "This applied-credit child allocation cannot run inline outside its serialized workflow.",
    };
  }
  if (isLegacyContextlessAppliedCreditAllocationChild(operation)) {
    return {
      supported: false,
      reason:
        "This legacy applied-credit child allocation must be retried through its serialized parent workflow.",
    };
  }

  if (operation.status === "PARTIAL") {
    if (operation.entityType === "INVOICE" && operation.operationType === "CREATE") {
      if (!partialInvoiceOperationHasPaymentFault(operation)) {
        return {
          supported: false,
          reason:
            "This invoice is partial because it was not emailed, not because its payment failed. Recording a payment here would falsely settle an unpaid invoice — send the invoice from Xero instead.",
        };
      }
      return parsePartialInvoiceRepairInput(operation)
        ? { supported: true, reason: null }
        : { supported: false, reason: "Stored invoice payload is incomplete for payment repair." };
    }

    if (operation.entityType === "CREDIT_NOTE" && operation.operationType === "CREATE") {
      if (parseRefundCreditNoteRepairInput(operation) || parseModificationCreditNoteRepairInput(operation)) {
        return { supported: true, reason: null };
      }

      return {
        supported: false,
        reason: "Stored credit note payload is incomplete for partial repair.",
      };
    }

    return {
      supported: false,
      reason: "This partial Xero operation does not have a repair handler yet.",
    };
  }

  if (operation.status !== "FAILED") {
    return {
      supported: false,
      reason: "Only failed or partially-completed operations can be retried from this screen.",
    };
  }

  if (operation.entityType === "CONTACT" && operation.operationType === "CREATE") {
    return operation.localModel === "Member" && operation.localId
      ? { supported: true, reason: null }
      : { supported: false, reason: "Contact create retries require a member-local record." };
  }

  if (operation.entityType === "CONTACT" && operation.operationType === "UPDATE") {
    if (operation.localModel === "Member" && operation.localId) {
      return { supported: true, reason: null };
    }

    return parseContactUpdateRetryInput(operation)
      ? { supported: true, reason: null }
      : { supported: false, reason: "Stored contact update payload is incomplete." };
  }

  if (operation.entityType === "INVOICE" && operation.operationType === "CREATE") {
    if (
      (operation.localModel === "Payment" || operation.localModel === "Member" || operation.localModel === "BookingModification") &&
      operation.localId
    ) {
      return { supported: true, reason: null };
    }

    /**
     * #3193 fix round: A SECOND ASK, anchored on the review task whose settled
     * share it bills.
     *
     * That anchor is what stops the booking change's own reads raising it to the
     * combined total. It also meant nothing could retry it: this screen's only
     * supplementary-invoice branch matched `BookingModification`, so a second ask
     * that failed in Xero sat FAILED forever while the booking's audit trail
     * already said the amount was being billed.
     *
     * Retryable only from its QUEUED payload. A second ask bills one settled
     * share, and that figure lives nowhere else - unlike the change's own
     * invoice, which can be rebuilt from the `BookingModification` row.
     * Rebuilding from the task's current `amountCents` would be a guess about
     * what this row was queued with, so it refuses and says so instead.
     *
     * AND THE PAYLOAD IS THERE TO READ, which the first version of this branch
     * assumed and did not check (#3193 fix round, second pass).
     * `createXeroSupplementaryInvoice` records the Xero invoice body on the row
     * BEFORE it calls Xero, so a rejection used to leave a FAILED row holding
     * only the refused request - making this branch dead in the one case it was
     * written for. That handler now keeps a second ask's queued payload and adds
     * the Xero body beside it, so the ordinary Xero-rejection path arrives here
     * replayable. The refusal below is what remains: a row whose payload was
     * destroyed some other way. It is deliberately not a rebuild.
     */
    if (operation.localModel === "ManualRefundTask" && operation.localId) {
      const queuedSecondAsk = readQueuedOutboxPayload(operation.requestPayload);
      return queuedSecondAsk?.queueType === XERO_OUTBOX_SUPPLEMENTARY_INVOICE_TYPE &&
        queuedSecondAsk.shortfallReviewTaskId &&
        queuedSecondAsk.bookingModificationId
        ? { supported: true, reason: null }
        : {
            supported: false,
            reason:
              "This second supplementary invoice cannot be replayed from this screen: the amounts it was queued with were overwritten by an earlier attempt. Check Xero for an invoice against this booking review before raising one by hand.",
          };
    }

    return {
      supported: false,
      reason: "This invoice retry path is not supported by the current replay helper.",
    };
  }

  if (operation.entityType === "INVOICE" && operation.operationType === "UPDATE") {
    return operation.localModel === "Payment" && operation.localId
      ? { supported: true, reason: null }
      : {
          supported: false,
          reason: "Invoice update retries require a payment-local record.",
        };
  }

  if (operation.entityType === "CREDIT_NOTE" && operation.operationType === "CREATE") {
    if (operation.localModel === "Payment" && operation.localId && parsePaymentCreditNoteRetryInput(operation)) {
      return { supported: true, reason: null };
    }

    if (operation.localModel === "BookingModification" && operation.localId) {
      return { supported: true, reason: null };
    }

    if (
      operation.localModel === "MemberSubscription" &&
      operation.localId &&
      parseMembershipCancellationCreditNoteRetryInput(operation)
    ) {
      return { supported: true, reason: null };
    }

    return {
      supported: false,
      reason: "This credit note retry path is not supported by the current replay helper.",
    };
  }

  if (operation.entityType === "ALLOCATION" && operation.operationType === "ALLOCATE") {
    // #1620 applied-credit allocation ops carry a {queueType, bookingId} queued
    // payload (never the generic single-allocation shape parsed below). The
    // retry action CAS-requeues it; only the outbox may claim and execute the
    // multi-provider-call engine.
    const queued = readQueuedOutboxPayload(operation.requestPayload);
    if (queued?.queueType === XERO_OUTBOX_APPLIED_CREDIT_ALLOCATION_TYPE) {
      return { supported: true, reason: null };
    }
    return parseAllocationRetryInput(operation)
      ? { supported: true, reason: null }
      : { supported: false, reason: "Stored allocation payload is incomplete." };
  }
  if (operation.entityType === "ALLOCATION" && operation.operationType === "UPDATE") {
    const queued = readQueuedOutboxPayload(operation.requestPayload);
    return queued?.queueType === XERO_OUTBOX_APPLIED_CREDIT_DEALLOCATION_TYPE
      ? { supported: true, reason: null }
      : { supported: false, reason: "Stored applied-credit deallocation payload is incomplete." };
  }

  if (
    operation.entityType === "SUBSCRIPTION" &&
    operation.operationType === "FETCH" &&
    operation.localModel === "Member" &&
    operation.localId
  ) {
    return { supported: true, reason: null };
  }

  return {
    supported: false,
    reason: "This operation type does not have a retry handler yet.",
  };
}

async function getPaymentBookingId(paymentId: string): Promise<string> {
  const payment = await prisma.payment.findUnique({
    where: { id: paymentId },
    select: { bookingId: true },
  });

  if (!payment) {
    throw new XeroOperationRetryError("Payment not found for retry.", 404);
  }

  return payment.bookingId;
}

async function getBookingModificationRetryData(bookingModificationId: string) {
  const modification = await prisma.bookingModification.findUnique({
    where: { id: bookingModificationId },
    select: {
      bookingId: true,
      priceDiffCents: true,
      changeFeeCents: true,
      createdAt: true,
    },
  });

  if (!modification) {
    throw new XeroOperationRetryError("Booking modification not found for retry.", 404);
  }

  return modification;
}

export async function retryXeroSyncOperation(
  operationId: string,
  options?: { createdByMemberId?: string }
): Promise<{ message: string }> {
  const operation = await prisma.xeroSyncOperation.findUnique({
    where: { id: operationId },
  });

  if (!operation) {
    throw new XeroOperationRetryError("Xero operation not found.", 404);
  }

  const retryMeta = getXeroOperationRetryMeta(operation);
  if (!retryMeta.supported) {
    throw new XeroOperationRetryError(retryMeta.reason ?? "This Xero operation cannot be retried.");
  }

  const queuedAppliedCredit = readQueuedOutboxPayload(operation.requestPayload);
  const isQueuedAppliedCreditOperation =
    operation.entityType === "ALLOCATION" &&
    operation.localModel === "Payment" &&
    ((queuedAppliedCredit?.queueType ===
      XERO_OUTBOX_APPLIED_CREDIT_ALLOCATION_TYPE &&
      operation.operationType === "ALLOCATE") ||
      (queuedAppliedCredit?.queueType ===
        XERO_OUTBOX_APPLIED_CREDIT_DEALLOCATION_TYPE &&
        operation.operationType === "UPDATE"));
  if (isQueuedAppliedCreditOperation) {
    // These handlers make multi-step provider calls and have their own durable
    // checkpoint/fencing protocol. Manual retry must never execute them inline:
    // atomically return exactly one failed/partial row to the outbox, whose
    // PENDING -> RUNNING claim is the sole provider-execution authority.
    const queued = await prisma.xeroSyncOperation.updateMany({
      where: {
        id: operation.id,
        status: { in: ["FAILED", "PARTIAL"] },
      },
      data: {
        status: "PENDING",
        startedAt: null,
        completedAt: null,
        lastErrorCode: null,
        lastErrorMessage: null,
      },
    });
    if (queued.count !== 1) {
      throw new XeroOperationRetryError(
        "This applied-credit operation was already queued or claimed by another retry.",
        409,
      );
    }
    return {
      message:
        queuedAppliedCredit.queueType ===
        XERO_OUTBOX_APPLIED_CREDIT_ALLOCATION_TYPE
          ? "Queued applied-credit allocation retry."
          : "Queued applied-credit deallocation retry.",
    };
  }

  const xero = await import("@/lib/xero");
  const createdByMemberId = options?.createdByMemberId ?? undefined;

  if (operation.status === "PARTIAL") {
    const partialInvoiceRepair = partialInvoiceOperationHasPaymentFault(operation)
      ? parsePartialInvoiceRepairInput(operation)
      : null;
    if (
      operation.entityType === "INVOICE" &&
      operation.operationType === "CREATE" &&
      partialInvoiceRepair &&
      operation.localModel &&
      operation.localId
    ) {
      if (partialInvoiceRepair.amountCents === 0) {
        const existingResponsePayload = asRecord(operation.responsePayload);

        await completeXeroSyncOperation(operation.id, {
          status: "SUCCEEDED",
          responsePayload: {
            ...(existingResponsePayload ?? {}),
            payment: null,
            paymentError: null,
            paymentSkipped: true,
            paymentSkipReason: "Zero-total invoice does not require Xero payment recording.",
          },
          xeroObjectType: "INVOICE",
          xeroObjectId: partialInvoiceRepair.invoiceId,
        });

        return {
          message:
            partialInvoiceRepair.linkRole === "INVOICE_PAYMENT"
              ? "Marked zero-total Xero booking invoice as repaired without payment recording."
              : "Marked zero-total Xero supplementary invoice as repaired without payment recording.",
        };
      }

      await xero.createXeroPaymentForInvoice({
        localModel: operation.localModel,
        localId: operation.localId,
        invoiceId: partialInvoiceRepair.invoiceId,
        amountCents: partialInvoiceRepair.amountCents,
        idempotencyKey: partialInvoiceRepair.idempotencyKey,
        reference: partialInvoiceRepair.reference,
        role: partialInvoiceRepair.linkRole,
        createdByMemberId,
        metadata: {
          invoiceId: partialInvoiceRepair.invoiceId,
          amountCents: partialInvoiceRepair.amountCents,
        },
      });

      return {
        message:
          partialInvoiceRepair.linkRole === "INVOICE_PAYMENT"
            ? "Repaired Xero booking invoice payment recording."
            : "Repaired Xero supplementary invoice payment recording.",
      };
    }

    const refundCreditNoteRepair = parseRefundCreditNoteRepairInput(operation);
    if (
      operation.entityType === "CREDIT_NOTE" &&
      operation.operationType === "CREATE" &&
      refundCreditNoteRepair
    ) {
      await repairRefundCreditNoteFollowUpActions(
        operation,
        xero,
        refundCreditNoteRepair,
        createdByMemberId
      );

      return { message: "Repaired Xero refund credit note follow-up actions." };
    }

    const modificationCreditNoteRepair = parseModificationCreditNoteRepairInput(operation);
    if (
      operation.entityType === "CREDIT_NOTE" &&
      operation.operationType === "CREATE" &&
      modificationCreditNoteRepair &&
      operation.localModel &&
      operation.localId
    ) {
      await xero.allocateCreditNoteToInvoice(
        modificationCreditNoteRepair.creditNoteId,
        modificationCreditNoteRepair.invoiceId,
        modificationCreditNoteRepair.amountCents,
        {
          localModel: operation.localModel,
          localId: operation.localId,
          role: modificationCreditNoteRepair.allocationRole,
          createdByMemberId,
        }
      );

      return { message: "Repaired Xero modification credit note allocation." };
    }

    throw new XeroOperationRetryError(
      "This partial Xero operation does not have a repair handler yet."
    );
  }

  if (operation.entityType === "CONTACT" && operation.operationType === "CREATE") {
    await xero.findOrCreateXeroContact(operation.localId!, { createdByMemberId });
    return { message: "Retried Xero contact creation." };
  }

  if (operation.entityType === "CONTACT" && operation.operationType === "UPDATE") {
    const retryInput =
      operation.localModel === "Member" && operation.localId
        ? await buildCurrentMemberContactUpdateRetryInput(operation)
        : parseContactUpdateRetryInput(operation);
    if (!retryInput) {
      throw new XeroOperationRetryError(
        operation.localModel === "Member" && operation.localId
          ? "The current member Xero contact is unavailable. Refresh the member and do not replay the stored contact payload."
          : "Stored contact update payload is incomplete.",
      );
    }
    if (
      !("memberScoped" in retryInput) &&
      containsRedactedContactRetryData(retryInput)
    ) {
      throw new XeroOperationRetryError(
        "Stored contact update payload is redacted and the current member contact could not be used for retry."
      );
    }

    await xero.updateXeroContact(
      retryInput.xeroContactId,
      "memberScoped" in retryInput ? undefined : retryInput.data,
      {
        localModel: operation.localModel ?? undefined,
        localId: operation.localId ?? undefined,
        createdByMemberId,
        preserveXeroName: retryInput.preserveXeroName,
      },
    );

    return { message: "Retried Xero contact update." };
  }

  if (operation.entityType === "INVOICE" && operation.operationType === "CREATE") {
    if (operation.localModel === "Payment") {
      const bookingId = await getPaymentBookingId(operation.localId!);
      // #2262 H3 — CLAIM FIRST. Without this the retry minted inline while the
      // row sat FAILED throughout, invisible to the manual mark-paid
      // settle-time fence (whose in-flight set is PENDING/RUNNING/
      // WAITING_PAYMENT): a settle could commit mid-retry and the retry's
      // create then fired with shouldEmailInvoice flipped TRUE by the settle's
      // source change — Xero emailing an invoice for cash already collected.
      // The status-fenced claim makes the retry visible to that fence for its
      // whole execution, serialises concurrent retries (count !== 1 -> 409),
      // and passing syncOperationId through makes completion/abandon reporting
      // land on THIS row (accurate outbox/ops-panel state instead of a
      // permanently-FAILED row behind a false success message).
      const claimed = await prisma.xeroSyncOperation.updateMany({
        where: { id: operation.id, status: { in: ["FAILED", "PARTIAL"] } },
        data: { status: "RUNNING", startedAt: new Date() },
      });
      if (claimed.count !== 1) {
        throw new XeroOperationRetryError(
          "This Xero operation was already claimed by another retry.",
          409
        );
      }
      const invoiceId = await xero.createXeroInvoiceForBooking(bookingId, {
        createdByMemberId,
        repairExistingLink: true,
        syncOperationId: operation.id,
      });
      if (invoiceId === null) {
        // The handler abandoned the mint (manual mark-paid provenance re-check)
        // and already closed the operation CANCELLED with the reason. Report
        // honestly — this retry created nothing and never will.
        return {
          message:
            "No invoice was created: this booking's payment was manually marked paid (cash / off-Xero), so no Xero invoice is expected. The operation was closed.",
        };
      }
      return { message: "Retried Xero booking invoice creation." };
    }

    if (operation.localModel === "Member") {
      await xero.createXeroEntranceFeeInvoice(operation.localId!, {
        createdByMemberId,
        repairExistingLink: true,
      });
      return { message: "Retried Xero joining fee invoice creation." };
    }

    if (operation.localModel === "BookingModification") {
      // Replay the enqueued payload's amounts when they survive (#1356,
      // following the #1354 queued-payload-first rule): the Xero idempotency
      // key embeds the amounts, so replaying the stored values keeps the key
      // identical to the original attempt and Xero dedups instead of creating
      // a second invoice. Only rebuild from the (signed) modification record
      // when the payload was overwritten by a prior execution.
      const queuedPayload = readQueuedOutboxPayload(operation.requestPayload);
      const modification = await getBookingModificationRetryData(operation.localId!);
      const queuedSupplementaryPayload =
        queuedPayload?.queueType === XERO_OUTBOX_SUPPLEMENTARY_INVOICE_TYPE
          ? queuedPayload
          : null;
      const amounts = queuedSupplementaryPayload ?? modification;
      const netAmountCents = amounts.priceDiffCents + amounts.changeFeeCents;
      if (netAmountCents <= 0) {
        throw new XeroOperationRetryError(
          "Booking modification no longer has a billable Xero delta; a reduction settles via a modification credit note."
        );
      }
      // F7 (#1882): thread recordPayment like the outbox dispatch
      // (`payload.recordPayment ?? true`) — dropping it let the worker's
      // recordPayment=true default book a Xero Payment from the Stripe
      // clearing account for an uncaptured (e.g. Internet-Banking)
      // supplementary invoice. When a prior execution overwrote the payload
      // with the raw Xero request shape (the flag is gone), derive it from
      // capture evidence: record only when a SUCCEEDED ADDITIONAL Stripe
      // transaction on this booking matches the modification net and
      // postdates the modification (the additional intent is minted with the
      // edit, so an earlier same-amount capture belongs to another edit).
      // Never record cash without evidence — a skipped payment stays
      // recoverable via the PARTIAL invoice-repair path.
      const recordPayment = queuedSupplementaryPayload
        ? queuedSupplementaryPayload.recordPayment ?? true
        : Boolean(
            await prisma.paymentTransaction.findFirst({
              where: {
                payment: { bookingId: modification.bookingId },
                kind: "ADDITIONAL",
                source: "STRIPE",
                status: "SUCCEEDED",
                amountCents: netAmountCents,
                createdAt: { gte: modification.createdAt },
              },
              select: { id: true },
            })
          );
      await xero.createXeroSupplementaryInvoice({
        bookingId: modification.bookingId,
        priceDiffCents: amounts.priceDiffCents,
        changeFeeCents: amounts.changeFeeCents,
        bookingModificationId: operation.localId!,
        createdByMemberId,
        recordPayment,
        repairExistingLink: true,
      });
      return { message: "Retried Xero supplementary invoice creation." };
    }

    if (operation.localModel === "ManualRefundTask") {
      // #3193 fix round: replay a SECOND ASK exactly as it was queued. The
      // payload is the only record of the share it bills - which is why the
      // create path preserves it through a failed attempt rather than replacing
      // it with the refused Xero body. `getXeroOperationRetryMeta` has already
      // refused the row if it no longer holds one; this re-check is the type
      // narrowing, not a second policy.
      const queuedPayload = readQueuedOutboxPayload(operation.requestPayload);
      const secondAsk =
        queuedPayload?.queueType === XERO_OUTBOX_SUPPLEMENTARY_INVOICE_TYPE &&
        queuedPayload.shortfallReviewTaskId &&
        queuedPayload.bookingModificationId
          ? queuedPayload
          : null;
      if (!secondAsk?.shortfallReviewTaskId || !secondAsk.bookingModificationId) {
        throw new XeroOperationRetryError(
          "This second supplementary invoice cannot be replayed: the amounts it was queued with were overwritten by an earlier attempt. Check Xero for an invoice against this booking review before raising one by hand.",
        );
      }
      await xero.createXeroSupplementaryInvoice({
        bookingId: secondAsk.bookingId,
        priceDiffCents: secondAsk.priceDiffCents,
        changeFeeCents: secondAsk.changeFeeCents,
        bookingModificationId: secondAsk.bookingModificationId,
        shortfallReviewTaskId: secondAsk.shortfallReviewTaskId,
        createdByMemberId,
        // NEVER a payment, and hard-coded rather than read off the payload
        // because it is a property of what a second ask IS: it is raised only
        // when the change's invoice had already gone out, so on the card route
        // the card was taken at the earlier figure and nothing has been paid
        // against this one. Recording a payment here would invent money.
        recordPayment: false,
        repairExistingLink: true,
      });
      return {
        message:
          "Retried the second Xero supplementary invoice for a settled booking-review share.",
      };
    }
  }

  if (operation.entityType === "INVOICE" && operation.operationType === "UPDATE") {
    if (operation.localModel === "Payment") {
      const bookingId = await getPaymentBookingId(operation.localId!);
      await xero.updateXeroBookingInvoiceForBooking(bookingId, {
        createdByMemberId,
        repairExistingLink: true,
      });
      return { message: "Retried Xero booking invoice update." };
    }
  }

  if (operation.entityType === "CREDIT_NOTE" && operation.operationType === "CREATE") {
    if (operation.localModel === "Payment") {
      const refundCreditNoteRepair = parseRefundCreditNoteRepairInput(operation);
      if (refundCreditNoteRepair) {
        await repairRefundCreditNoteFollowUpActions(
          operation,
          xero,
          refundCreditNoteRepair,
          createdByMemberId
        );
        return { message: "Repaired Xero refund credit note follow-up actions." };
      }

      const retryInput = parsePaymentCreditNoteRetryInput(operation);
      if (!retryInput) {
        throw new XeroOperationRetryError("Stored credit note payload is incomplete.");
      }

      if (retryInput.kind === "refund") {
        // F4 (#1354): re-enter delta mode when the payload carries a
        // watermark OR the operation's denormalized queue type says this was
        // a per-delta refund note whose payload was later overwritten with
        // the Xero request shape. The advisory value 0 is safe:
        // createXeroCreditNote recomputes coverage at execution time.
        const deltaWatermarkCents =
          retryInput.watermarkCents ??
          (operation.queueType === XERO_OUTBOX_REFUND_CREDIT_NOTE_TYPE
            ? 0
            : undefined);
        await xero.createXeroCreditNote(operation.localId!, retryInput.amountCents, {
          createdByMemberId,
          repairExistingLink: true,
          ...(deltaWatermarkCents !== undefined
            ? { watermarkCents: deltaWatermarkCents }
            : {}),
        });
        return { message: "Retried Xero refund credit note creation." };
      }

      await xero.createUnappliedXeroCreditNote(operation.localId!, retryInput.amountCents, {
        createdByMemberId,
        repairExistingLink: true,
      });
      return { message: "Retried Xero account-credit note creation." };
    }

    if (operation.localModel === "BookingModification") {
      const modification = await getBookingModificationRetryData(operation.localId!);
      // Replay the enqueued (policy-limited) refund amount when it survives
      // (#1356, #1354 queued-payload-first): the classifier caps the credit at
      // the cancellation-policy settlement, which the modification row does
      // not record, and the amount is embedded in the Xero idempotency key —
      // rebuilding a different amount both over-credits and breaks dedup. The
      // executor-overwritten payload preserves refundAmountCents too, so only
      // fully-legacy rows fall back to the record; that fallback is the NET of
      // the signed components (a mixed-sign edit only returns the net —
      // |priceDiff| alone would over-credit by the fee), mirroring the primary
      // classifier's abs(net) fallback when no settlement amount is available.
      const queuedPayload = readQueuedOutboxPayload(operation.requestPayload);
      const storedRefundAmountCents =
        queuedPayload?.queueType === XERO_OUTBOX_MODIFICATION_CREDIT_NOTE_TYPE ||
        queuedPayload?.queueType === XERO_OUTBOX_MODIFICATION_ACCOUNT_CREDIT_NOTE_TYPE
          ? queuedPayload.refundAmountCents
          : readNumber(asRecord(operation.requestPayload)?.refundAmountCents);
      const netAmountCents = getModificationNetAmountCents(modification);
      const refundAmountCents =
        storedRefundAmountCents ??
        (netAmountCents < 0 ? Math.abs(netAmountCents) : 0);
      if (refundAmountCents <= 0) {
        throw new XeroOperationRetryError("Booking modification no longer has a refundable Xero delta.");
      }

      // An account-credit settlement must be rebuilt as an UNAPPLIED credit
      // note, never applied against the invoice — the member already holds
      // the matching spendable credit locally. Discriminate via the queued
      // payload, falling back to the enqueue-time queueType column when a
      // prior execution overwrote the payload (#1354 decision 2).
      const isAccountCredit =
        queuedPayload?.queueType === XERO_OUTBOX_MODIFICATION_ACCOUNT_CREDIT_NOTE_TYPE ||
        (!queuedPayload &&
          operation.queueType === XERO_OUTBOX_MODIFICATION_ACCOUNT_CREDIT_NOTE_TYPE);
      if (isAccountCredit) {
        const paymentId =
          queuedPayload?.queueType === XERO_OUTBOX_MODIFICATION_ACCOUNT_CREDIT_NOTE_TYPE
            ? queuedPayload.paymentId
            : (
                await prisma.booking.findUnique({
                  where: { id: modification.bookingId },
                  select: { payment: { select: { id: true } } },
                })
              )?.payment?.id;
        if (!paymentId) {
          throw new XeroOperationRetryError(
            "No payment exists to anchor the modification account-credit note retry."
          );
        }

        await xero.createUnappliedXeroCreditNoteForModification({
          paymentId,
          refundAmountCents,
          bookingModificationId: operation.localId!,
          createdByMemberId,
        });
        return { message: "Retried Xero modification account-credit note creation." };
      }

      await xero.createXeroCreditNoteForModification({
        bookingId: modification.bookingId,
        refundAmountCents,
        bookingModificationId: operation.localId!,
        createdByMemberId,
        repairExistingLink: true,
      });
      return { message: "Retried Xero modification credit note creation." };
    }

    if (operation.localModel === "MemberSubscription") {
      const retryInput = parseMembershipCancellationCreditNoteRetryInput(operation);
      if (!retryInput) {
        throw new XeroOperationRetryError(
          "Stored membership cancellation credit note payload is incomplete."
        );
      }

      const { createXeroMembershipCancellationCreditNote } = await import(
        "@/lib/membership-cancellation-xero"
      );
      await createXeroMembershipCancellationCreditNote({
        subscriptionId: operation.localId!,
        requestId: retryInput.requestId,
        participantId: retryInput.participantId,
        createdByMemberId,
        syncOperationId: operation.id,
      });
      return { message: "Retried Xero membership cancellation credit note creation." };
    }
  }

  if (operation.entityType === "ALLOCATION" && operation.operationType === "ALLOCATE") {
    // Applied-credit queue shapes are intercepted by the CAS-requeue branch
    // above. Keep this guard fail-closed if control flow is ever rearranged.
    const queued = readQueuedOutboxPayload(operation.requestPayload);
    if (queued?.queueType === XERO_OUTBOX_APPLIED_CREDIT_ALLOCATION_TYPE) {
      throw new XeroOperationRetryError(
        "Applied-credit allocation retries must be queued through the outbox.",
      );
    }
    if (readAppliedCreditAllocationChildContext(operation.requestPayload)) {
      throw new XeroOperationRetryError(
        "Applied-credit child allocations must be retried through their serialized parent workflow.",
      );
    }
    if (isLegacyContextlessAppliedCreditAllocationChild(operation)) {
      throw new XeroOperationRetryError(
        "Legacy applied-credit child allocations must be retried through their serialized parent workflow.",
      );
    }

    const retryInput = parseAllocationRetryInput(operation);
    if (!retryInput) {
      throw new XeroOperationRetryError("Stored allocation payload is incomplete.");
    }

    await xero.allocateCreditNoteToInvoice(
      retryInput.creditNoteId,
      retryInput.invoiceId,
      retryInput.amountCents,
      {
        localModel: operation.localModel ?? undefined,
        localId: operation.localId ?? undefined,
        createdByMemberId,
      }
    );

    return { message: "Retried Xero credit note allocation." };
  }
  if (operation.entityType === "ALLOCATION" && operation.operationType === "UPDATE") {
    const queued = readQueuedOutboxPayload(operation.requestPayload);
    if (queued?.queueType !== XERO_OUTBOX_APPLIED_CREDIT_DEALLOCATION_TYPE) {
      throw new XeroOperationRetryError("Stored applied-credit deallocation payload is incomplete.");
    }
    throw new XeroOperationRetryError(
      "Applied-credit deallocation retries must be queued through the outbox.",
    );
  }

  if (operation.entityType === "SUBSCRIPTION" && operation.operationType === "FETCH") {
    const retryInput = parseSubscriptionRetryInput(operation);
    await xero.checkMembershipStatus(operation.localId!, retryInput?.seasonYear);
    return { message: "Retried Xero membership status refresh." };
  }

  throw new XeroOperationRetryError("This Xero operation does not have a retry handler yet.");
}
