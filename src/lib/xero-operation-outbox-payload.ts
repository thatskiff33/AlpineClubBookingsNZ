import type { EntranceFeeCategory } from "@prisma/client";

export const XERO_OUTBOX_ENTRANCE_FEE_TYPE = "ENTRANCE_FEE_INVOICE";
export const XERO_OUTBOX_BOOKING_INVOICE_TYPE = "BOOKING_INVOICE";
export const XERO_OUTBOX_BOOKING_INVOICE_UPDATE_TYPE =
  "BOOKING_INVOICE_UPDATE";
export const XERO_OUTBOX_REFUND_CREDIT_NOTE_TYPE = "REFUND_CREDIT_NOTE";
export const XERO_OUTBOX_ACCOUNT_CREDIT_NOTE_TYPE = "ACCOUNT_CREDIT_NOTE";
export const XERO_OUTBOX_SUPPLEMENTARY_INVOICE_TYPE =
  "SUPPLEMENTARY_INVOICE";
export const XERO_OUTBOX_MODIFICATION_CREDIT_NOTE_TYPE =
  "MODIFICATION_CREDIT_NOTE";
export const XERO_OUTBOX_MODIFICATION_ACCOUNT_CREDIT_NOTE_TYPE =
  "MODIFICATION_ACCOUNT_CREDIT_NOTE";
export const XERO_OUTBOX_CREDIT_NOTE_ALLOCATION_TYPE =
  "CREDIT_NOTE_ALLOCATION";
export const XERO_OUTBOX_MEMBERSHIP_CANCELLATION_CREDIT_NOTE_TYPE =
  "MEMBERSHIP_CANCELLATION_CREDIT_NOTE";
export const XERO_OUTBOX_MEMBERSHIP_CANCELLATION_CONTACT_TYPE =
  "MEMBERSHIP_CANCELLATION_CONTACT";

export interface QueuedEntranceFeeOutboxPayload {
  queueType: typeof XERO_OUTBOX_ENTRANCE_FEE_TYPE;
  category: EntranceFeeCategory;
  itemCode: string | null;
  feeAmountCents: number;
  description?: string | null;
}

export interface QueuedBookingInvoiceOutboxPayload {
  queueType: typeof XERO_OUTBOX_BOOKING_INVOICE_TYPE;
  bookingId: string;
}

export interface QueuedBookingInvoiceUpdateOutboxPayload {
  queueType: typeof XERO_OUTBOX_BOOKING_INVOICE_UPDATE_TYPE;
  bookingId: string;
  xeroInvoiceId?: string;
}

export interface QueuedRefundCreditNoteOutboxPayload {
  queueType: typeof XERO_OUTBOX_REFUND_CREDIT_NOTE_TYPE;
  refundAmountCents: number;
}

export interface QueuedAccountCreditNoteOutboxPayload {
  queueType: typeof XERO_OUTBOX_ACCOUNT_CREDIT_NOTE_TYPE;
  refundAmountCents: number;
}

export interface QueuedSupplementaryInvoiceOutboxPayload {
  queueType: typeof XERO_OUTBOX_SUPPLEMENTARY_INVOICE_TYPE;
  bookingId: string;
  priceDiffCents: number;
  changeFeeCents: number;
  bookingModificationId?: string;
  recordPayment?: boolean;
  paymentIntentId?: string;
  waitForConfirmedAdditionalPayment?: boolean;
}

export interface QueuedModificationCreditNoteOutboxPayload {
  queueType: typeof XERO_OUTBOX_MODIFICATION_CREDIT_NOTE_TYPE;
  bookingId: string;
  refundAmountCents: number;
  bookingModificationId?: string;
}

export interface QueuedModificationAccountCreditNoteOutboxPayload {
  queueType: typeof XERO_OUTBOX_MODIFICATION_ACCOUNT_CREDIT_NOTE_TYPE;
  bookingId: string;
  paymentId: string;
  refundAmountCents: number;
  bookingModificationId: string;
}

export interface QueuedCreditNoteAllocationOutboxPayload {
  queueType: typeof XERO_OUTBOX_CREDIT_NOTE_ALLOCATION_TYPE;
  creditNoteId: string;
  invoiceId: string;
  amountCents: number;
  role?: string;
}

export interface QueuedMembershipCancellationCreditNoteOutboxPayload {
  queueType: typeof XERO_OUTBOX_MEMBERSHIP_CANCELLATION_CREDIT_NOTE_TYPE;
  subscriptionId: string;
  requestId: string;
  participantId: string;
}

export interface QueuedMembershipCancellationContactOutboxPayload {
  queueType: typeof XERO_OUTBOX_MEMBERSHIP_CANCELLATION_CONTACT_TYPE;
  memberId: string;
  requestId: string;
  participantId: string;
}

export type QueuedOutboxPayload =
  | QueuedEntranceFeeOutboxPayload
  | QueuedBookingInvoiceOutboxPayload
  | QueuedBookingInvoiceUpdateOutboxPayload
  | QueuedRefundCreditNoteOutboxPayload
  | QueuedAccountCreditNoteOutboxPayload
  | QueuedSupplementaryInvoiceOutboxPayload
  | QueuedModificationCreditNoteOutboxPayload
  | QueuedModificationAccountCreditNoteOutboxPayload
  | QueuedCreditNoteAllocationOutboxPayload
  | QueuedMembershipCancellationCreditNoteOutboxPayload
  | QueuedMembershipCancellationContactOutboxPayload;

export interface QueuedOutboxExpectedOperation {
  entityType: "INVOICE" | "CREDIT_NOTE" | "ALLOCATION" | "CONTACT";
  operationType: "CREATE" | "UPDATE" | "ALLOCATE";
  localModels: ReadonlyArray<
    | "Member"
    | "Payment"
    | "Booking"
    | "BookingModification"
    | "MemberSubscription"
    | "MembershipCancellationRequestParticipant"
  >;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  return value as Record<string, unknown>;
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

function readEntranceFeeCategory(value: unknown): EntranceFeeCategory | null {
  return value === "ADULT" ||
    value === "FAMILY" ||
    value === "YOUTH" ||
    value === "CHILD"
    ? value
    : null;
}

export function readQueueType(value: unknown): string | null {
  const payload = asRecord(value);
  if (!payload) {
    return null;
  }

  return readString(payload.queueType);
}

export function readQueuedOutboxPayload(
  value: unknown
): QueuedOutboxPayload | null {
  const payload = asRecord(value);
  if (!payload) {
    return null;
  }

  const queueType = readQueueType(value);
  if (!queueType) {
    return null;
  }

  if (queueType === XERO_OUTBOX_BOOKING_INVOICE_TYPE) {
    const bookingId = readString(payload.bookingId);
    if (!bookingId) {
      return null;
    }

    return {
      queueType,
      bookingId,
    };
  }

  if (queueType === XERO_OUTBOX_BOOKING_INVOICE_UPDATE_TYPE) {
    const bookingId = readString(payload.bookingId);
    if (!bookingId) {
      return null;
    }

    return {
      queueType,
      bookingId,
      xeroInvoiceId: readString(payload.xeroInvoiceId) ?? undefined,
    };
  }

  if (queueType === XERO_OUTBOX_REFUND_CREDIT_NOTE_TYPE) {
    const refundAmountCents = readNumber(payload.refundAmountCents);
    if (refundAmountCents === null) {
      return null;
    }

    return {
      queueType,
      refundAmountCents,
    };
  }

  if (queueType === XERO_OUTBOX_ACCOUNT_CREDIT_NOTE_TYPE) {
    const refundAmountCents = readNumber(payload.refundAmountCents);
    if (refundAmountCents === null) {
      return null;
    }

    return {
      queueType,
      refundAmountCents,
    };
  }

  if (queueType === XERO_OUTBOX_SUPPLEMENTARY_INVOICE_TYPE) {
    const bookingId = readString(payload.bookingId);
    const priceDiffCents = readNumber(payload.priceDiffCents);
    const changeFeeCents = readNumber(payload.changeFeeCents);

    if (!bookingId || priceDiffCents === null || changeFeeCents === null) {
      return null;
    }

    return {
      queueType,
      bookingId,
      priceDiffCents,
      changeFeeCents,
      bookingModificationId:
        readString(payload.bookingModificationId) ?? undefined,
      recordPayment:
        typeof payload.recordPayment === "boolean"
          ? payload.recordPayment
          : undefined,
      paymentIntentId: readString(payload.paymentIntentId) ?? undefined,
      waitForConfirmedAdditionalPayment:
        typeof payload.waitForConfirmedAdditionalPayment === "boolean"
          ? payload.waitForConfirmedAdditionalPayment
          : undefined,
    };
  }

  if (queueType === XERO_OUTBOX_MODIFICATION_CREDIT_NOTE_TYPE) {
    const bookingId = readString(payload.bookingId);
    const refundAmountCents = readNumber(payload.refundAmountCents);

    if (!bookingId || refundAmountCents === null) {
      return null;
    }

    return {
      queueType,
      bookingId,
      refundAmountCents,
      bookingModificationId:
        readString(payload.bookingModificationId) ?? undefined,
    };
  }

  if (queueType === XERO_OUTBOX_MODIFICATION_ACCOUNT_CREDIT_NOTE_TYPE) {
    const bookingId = readString(payload.bookingId);
    const paymentId = readString(payload.paymentId);
    const refundAmountCents = readNumber(payload.refundAmountCents);
    const bookingModificationId = readString(payload.bookingModificationId);

    if (!bookingId || !paymentId || refundAmountCents === null || !bookingModificationId) {
      return null;
    }

    return {
      queueType,
      bookingId,
      paymentId,
      refundAmountCents,
      bookingModificationId,
    };
  }

  if (queueType === XERO_OUTBOX_CREDIT_NOTE_ALLOCATION_TYPE) {
    const creditNoteId = readString(payload.creditNoteId);
    const invoiceId = readString(payload.invoiceId);
    const amountCents = readNumber(payload.amountCents);

    if (!creditNoteId || !invoiceId || amountCents === null) {
      return null;
    }

    return {
      queueType,
      creditNoteId,
      invoiceId,
      amountCents,
      role: readString(payload.role) ?? undefined,
    };
  }

  if (queueType === XERO_OUTBOX_MEMBERSHIP_CANCELLATION_CREDIT_NOTE_TYPE) {
    const subscriptionId = readString(payload.subscriptionId);
    const requestId = readString(payload.requestId);
    const participantId = readString(payload.participantId);

    if (!subscriptionId || !requestId || !participantId) {
      return null;
    }

    return {
      queueType,
      subscriptionId,
      requestId,
      participantId,
    };
  }

  if (queueType === XERO_OUTBOX_MEMBERSHIP_CANCELLATION_CONTACT_TYPE) {
    const memberId = readString(payload.memberId);
    const requestId = readString(payload.requestId);
    const participantId = readString(payload.participantId);

    if (!memberId || !requestId || !participantId) {
      return null;
    }

    return {
      queueType,
      memberId,
      requestId,
      participantId,
    };
  }

  if (queueType !== XERO_OUTBOX_ENTRANCE_FEE_TYPE) {
    return null;
  }

  const category = readEntranceFeeCategory(payload.category);
  const feeAmountCents = readNumber(payload.feeAmountCents);

  if (!category || feeAmountCents === null) {
    return null;
  }

  return {
    queueType,
    category,
    itemCode:
      payload.itemCode === null
        ? null
        : typeof payload.itemCode === "string"
          ? payload.itemCode
          : null,
    feeAmountCents,
    description: readString(payload.description) ?? null,
  };
}

export function getQueuedOutboxExpectedOperation(
  queueType: string | null
): QueuedOutboxExpectedOperation {
  if (queueType === XERO_OUTBOX_BOOKING_INVOICE_UPDATE_TYPE) {
    return {
      entityType: "INVOICE",
      operationType: "UPDATE",
      localModels: ["Payment"],
    };
  }

  if (queueType === XERO_OUTBOX_MEMBERSHIP_CANCELLATION_CONTACT_TYPE) {
    return {
      entityType: "CONTACT",
      operationType: "UPDATE",
      localModels: ["MembershipCancellationRequestParticipant"],
    };
  }

  if (queueType === XERO_OUTBOX_CREDIT_NOTE_ALLOCATION_TYPE) {
    return {
      entityType: "ALLOCATION",
      operationType: "ALLOCATE",
      localModels: ["Payment", "Booking", "BookingModification"],
    };
  }

  if (
    queueType === XERO_OUTBOX_REFUND_CREDIT_NOTE_TYPE ||
    queueType === XERO_OUTBOX_ACCOUNT_CREDIT_NOTE_TYPE ||
    queueType === XERO_OUTBOX_MODIFICATION_CREDIT_NOTE_TYPE ||
    queueType === XERO_OUTBOX_MODIFICATION_ACCOUNT_CREDIT_NOTE_TYPE ||
    queueType === XERO_OUTBOX_MEMBERSHIP_CANCELLATION_CREDIT_NOTE_TYPE
  ) {
    return {
      entityType: "CREDIT_NOTE",
      operationType: "CREATE",
      localModels:
        queueType === XERO_OUTBOX_MODIFICATION_CREDIT_NOTE_TYPE ||
        queueType === XERO_OUTBOX_MODIFICATION_ACCOUNT_CREDIT_NOTE_TYPE
          ? ["Booking", "BookingModification"]
          : queueType === XERO_OUTBOX_MEMBERSHIP_CANCELLATION_CREDIT_NOTE_TYPE
            ? ["MemberSubscription"]
            : ["Payment"],
    };
  }

  return {
    entityType: "INVOICE",
    operationType: "CREATE",
    localModels:
      queueType === XERO_OUTBOX_BOOKING_INVOICE_TYPE
        ? ["Payment"]
        : queueType === XERO_OUTBOX_SUPPLEMENTARY_INVOICE_TYPE
          ? ["Booking", "BookingModification"]
          : ["Member"],
  };
}
