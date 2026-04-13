import type { XeroContactUpdateData } from "@/lib/xero";
import type { XeroSyncOperation } from "@prisma/client";
import { prisma } from "@/lib/prisma";

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
  | "xeroObjectId"
>;

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

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  return value as Record<string, unknown>;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function readNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

function readPayloadContact(operation: Pick<RetryableOperation, "requestPayload">): Record<string, unknown> | null {
  const payload = asRecord(operation.requestPayload);
  const contact = payload ? asArray(payload.contacts)[0] : null;
  return asRecord(contact);
}

function parseXeroDateOfBirth(value: string | null): Date | null {
  if (!value) {
    return null;
  }

  const match = value.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!match) {
    return null;
  }

  const date = new Date(Date.UTC(Number(match[3]), Number(match[2]) - 1, Number(match[1])));
  return Number.isNaN(date.getTime()) ? null : date;
}

function parseContactUpdateRetryInput(
  operation: Pick<RetryableOperation, "requestPayload" | "xeroObjectId">
): { xeroContactId: string; data: XeroContactUpdateData } | null {
  const contact = readPayloadContact(operation);
  if (!contact) {
    return null;
  }

  const xeroContactId = readString(contact.contactID) ?? operation.xeroObjectId;
  const firstName = readString(contact.firstName);
  const lastName = readString(contact.lastName);
  const email = readString(contact.emailAddress);

  if (!xeroContactId || !firstName || !lastName || !email) {
    return null;
  }

  const phone = asRecord(asArray(contact.phones)[0]);
  const addresses = asArray(contact.addresses).map(asRecord).filter((value): value is Record<string, unknown> => Boolean(value));
  const street = addresses.find((address) => readString(address.addressType) === "STREET") ?? null;
  const postal = addresses.find((address) => readString(address.addressType) === "POBOX") ?? null;

  return {
    xeroContactId,
    data: {
      firstName,
      lastName,
      email,
      dateOfBirth: parseXeroDateOfBirth(readString(contact.companyNumber)),
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
  };
}

function parsePaymentCreditNoteRetryInput(
  operation: Pick<RetryableOperation, "requestPayload">
): { amountCents: number; kind: "refund" | "unapplied" } | null {
  const payload = asRecord(operation.requestPayload);
  if (!payload) {
    return null;
  }

  const allocation = asRecord(payload.allocation);
  const allocationAmount = readNumber(allocation?.amount);
  if (allocationAmount !== null) {
    return {
      amountCents: Math.round(allocationAmount * 100),
      kind: "refund",
    };
  }

  const creditNote = asRecord(asArray(payload.creditNotes)[0]);
  const lineItem = asRecord(creditNote ? asArray(creditNote.lineItems)[0] : null);
  const unitAmount = readNumber(lineItem?.unitAmount);
  if (unitAmount === null) {
    return null;
  }

  return {
    amountCents: Math.round(unitAmount * 100),
    kind: "unapplied",
  };
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

export function getXeroOperationRetryMeta(operation: RetryableOperation): XeroOperationRetryMeta {
  if (!operation.replayable) {
    return {
      supported: false,
      reason: "This operation is not marked replayable.",
    };
  }

  if (operation.status !== "FAILED") {
    return {
      supported: false,
      reason:
        operation.status === "PARTIAL"
          ? "Automatic retry for partial operations is not implemented in this pass."
          : "Only failed operations can be retried from this screen.",
    };
  }

  if (operation.direction !== "OUTBOUND") {
    return {
      supported: false,
      reason: "Only outbound operations are retryable in this pass.",
    };
  }

  if (operation.entityType === "CONTACT" && operation.operationType === "CREATE") {
    return operation.localModel === "Member" && operation.localId
      ? { supported: true, reason: null }
      : { supported: false, reason: "Contact create retries require a member-local record." };
  }

  if (operation.entityType === "CONTACT" && operation.operationType === "UPDATE") {
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

    return {
      supported: false,
      reason: "This invoice retry path is not supported by the current replay helper.",
    };
  }

  if (operation.entityType === "CREDIT_NOTE" && operation.operationType === "CREATE") {
    if (operation.localModel === "Payment" && operation.localId && parsePaymentCreditNoteRetryInput(operation)) {
      return { supported: true, reason: null };
    }

    if (operation.localModel === "BookingModification" && operation.localId) {
      return { supported: true, reason: null };
    }

    return {
      supported: false,
      reason: "This credit note retry path is not supported by the current replay helper.",
    };
  }

  if (operation.entityType === "ALLOCATION" && operation.operationType === "ALLOCATE") {
    return parseAllocationRetryInput(operation)
      ? { supported: true, reason: null }
      : { supported: false, reason: "Stored allocation payload is incomplete." };
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

  const xero = await import("@/lib/xero");
  const createdByMemberId = options?.createdByMemberId ?? undefined;

  if (operation.entityType === "CONTACT" && operation.operationType === "CREATE") {
    await xero.findOrCreateXeroContact(operation.localId!, { createdByMemberId });
    return { message: "Retried Xero contact creation." };
  }

  if (operation.entityType === "CONTACT" && operation.operationType === "UPDATE") {
    const retryInput = parseContactUpdateRetryInput(operation);
    if (!retryInput) {
      throw new XeroOperationRetryError("Stored contact update payload is incomplete.");
    }

    await xero.updateXeroContact(retryInput.xeroContactId, retryInput.data, {
      localModel: operation.localModel ?? undefined,
      localId: operation.localId ?? undefined,
      createdByMemberId,
    });

    return { message: "Retried Xero contact update." };
  }

  if (operation.entityType === "INVOICE" && operation.operationType === "CREATE") {
    if (operation.localModel === "Payment") {
      const bookingId = await getPaymentBookingId(operation.localId!);
      await xero.createXeroInvoiceForBooking(bookingId, { createdByMemberId });
      return { message: "Retried Xero booking invoice creation." };
    }

    if (operation.localModel === "Member") {
      await xero.createXeroEntranceFeeInvoice(operation.localId!, { createdByMemberId });
      return { message: "Retried Xero entrance fee invoice creation." };
    }

    if (operation.localModel === "BookingModification") {
      const modification = await getBookingModificationRetryData(operation.localId!);
      await xero.createXeroSupplementaryInvoice({
        bookingId: modification.bookingId,
        priceDiffCents: Math.max(modification.priceDiffCents, 0),
        changeFeeCents: modification.changeFeeCents,
        bookingModificationId: operation.localId!,
        createdByMemberId,
      });
      return { message: "Retried Xero supplementary invoice creation." };
    }
  }

  if (operation.entityType === "CREDIT_NOTE" && operation.operationType === "CREATE") {
    if (operation.localModel === "Payment") {
      const retryInput = parsePaymentCreditNoteRetryInput(operation);
      if (!retryInput) {
        throw new XeroOperationRetryError("Stored credit note payload is incomplete.");
      }

      if (retryInput.kind === "refund") {
        await xero.createXeroCreditNote(operation.localId!, retryInput.amountCents, { createdByMemberId });
        return { message: "Retried Xero refund credit note creation." };
      }

      await xero.createUnappliedXeroCreditNote(operation.localId!, retryInput.amountCents, {
        createdByMemberId,
      });
      return { message: "Retried Xero account-credit note creation." };
    }

    if (operation.localModel === "BookingModification") {
      const modification = await getBookingModificationRetryData(operation.localId!);
      const refundAmountCents = Math.abs(modification.priceDiffCents);
      if (refundAmountCents <= 0) {
        throw new XeroOperationRetryError("Booking modification no longer has a refundable Xero delta.");
      }

      await xero.createXeroCreditNoteForModification({
        bookingId: modification.bookingId,
        refundAmountCents,
        bookingModificationId: operation.localId!,
        createdByMemberId,
      });
      return { message: "Retried Xero modification credit note creation." };
    }
  }

  if (operation.entityType === "ALLOCATION" && operation.operationType === "ALLOCATE") {
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

  if (operation.entityType === "SUBSCRIPTION" && operation.operationType === "FETCH") {
    const retryInput = parseSubscriptionRetryInput(operation);
    await xero.checkMembershipStatus(operation.localId!, retryInput?.seasonYear);
    return { message: "Retried Xero membership status refresh." };
  }

  throw new XeroOperationRetryError("This Xero operation does not have a retry handler yet.");
}
