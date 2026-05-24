import type { EntranceFeeCategory } from "@prisma/client";
import logger from "@/lib/logger";
import {
  createXeroMembershipCancellationCreditNote,
  syncXeroMembershipCancellationContact,
} from "@/lib/membership-cancellation-xero";
import { prisma } from "@/lib/prisma";
import { getSeasonYear } from "@/lib/utils";
import {
  buildXeroIdempotencyKey,
  completeXeroSyncOperation,
  failXeroSyncOperation,
  findCanonicalPaymentRefundCreditNote,
  startXeroSyncOperation,
  upsertXeroObjectLink,
} from "@/lib/xero-sync";
import {
  allocateCreditNoteToInvoice,
  buildEntranceFeeInvoiceIdempotencyKey,
  createXeroCreditNote,
  createXeroCreditNoteForModification,
  createXeroEntranceFeeInvoice,
  createXeroInvoiceForBooking,
  createXeroSupplementaryInvoice,
  createUnappliedXeroCreditNote,
  getEntranceFeeContext,
  isXeroConnected,
  updateXeroBookingInvoiceForBooking,
  type EntranceFeeContext,
} from "@/lib/xero";

const XERO_OUTBOX_ENTRANCE_FEE_TYPE = "ENTRANCE_FEE_INVOICE";
const XERO_OUTBOX_BOOKING_INVOICE_TYPE = "BOOKING_INVOICE";
const XERO_OUTBOX_BOOKING_INVOICE_UPDATE_TYPE = "BOOKING_INVOICE_UPDATE";
const XERO_OUTBOX_REFUND_CREDIT_NOTE_TYPE = "REFUND_CREDIT_NOTE";
const XERO_OUTBOX_ACCOUNT_CREDIT_NOTE_TYPE = "ACCOUNT_CREDIT_NOTE";
const XERO_OUTBOX_SUPPLEMENTARY_INVOICE_TYPE = "SUPPLEMENTARY_INVOICE";
const XERO_OUTBOX_MODIFICATION_CREDIT_NOTE_TYPE = "MODIFICATION_CREDIT_NOTE";
const XERO_OUTBOX_CREDIT_NOTE_ALLOCATION_TYPE = "CREDIT_NOTE_ALLOCATION";
const XERO_OUTBOX_MEMBERSHIP_CANCELLATION_CREDIT_NOTE_TYPE =
  "MEMBERSHIP_CANCELLATION_CREDIT_NOTE";
const XERO_OUTBOX_MEMBERSHIP_CANCELLATION_CONTACT_TYPE =
  "MEMBERSHIP_CANCELLATION_CONTACT";

interface QueuedEntranceFeeOutboxPayload {
  queueType: typeof XERO_OUTBOX_ENTRANCE_FEE_TYPE;
  category: EntranceFeeCategory;
  itemCode: string | null;
  feeAmountCents: number;
  description?: string | null;
}

interface QueuedBookingInvoiceOutboxPayload {
  queueType: typeof XERO_OUTBOX_BOOKING_INVOICE_TYPE;
  bookingId: string;
}

interface QueuedBookingInvoiceUpdateOutboxPayload {
  queueType: typeof XERO_OUTBOX_BOOKING_INVOICE_UPDATE_TYPE;
  bookingId: string;
  xeroInvoiceId?: string;
}

interface QueuedRefundCreditNoteOutboxPayload {
  queueType: typeof XERO_OUTBOX_REFUND_CREDIT_NOTE_TYPE;
  refundAmountCents: number;
}

interface QueuedAccountCreditNoteOutboxPayload {
  queueType: typeof XERO_OUTBOX_ACCOUNT_CREDIT_NOTE_TYPE;
  refundAmountCents: number;
}

interface QueuedSupplementaryInvoiceOutboxPayload {
  queueType: typeof XERO_OUTBOX_SUPPLEMENTARY_INVOICE_TYPE;
  bookingId: string;
  priceDiffCents: number;
  changeFeeCents: number;
  bookingModificationId?: string;
  recordPayment?: boolean;
  paymentIntentId?: string;
  waitForConfirmedAdditionalPayment?: boolean;
}

interface QueuedModificationCreditNoteOutboxPayload {
  queueType: typeof XERO_OUTBOX_MODIFICATION_CREDIT_NOTE_TYPE;
  bookingId: string;
  refundAmountCents: number;
  bookingModificationId?: string;
}

interface QueuedCreditNoteAllocationOutboxPayload {
  queueType: typeof XERO_OUTBOX_CREDIT_NOTE_ALLOCATION_TYPE;
  creditNoteId: string;
  invoiceId: string;
  amountCents: number;
  role?: string;
}

interface QueuedMembershipCancellationCreditNoteOutboxPayload {
  queueType: typeof XERO_OUTBOX_MEMBERSHIP_CANCELLATION_CREDIT_NOTE_TYPE;
  subscriptionId: string;
  requestId: string;
  participantId: string;
}

interface QueuedMembershipCancellationContactOutboxPayload {
  queueType: typeof XERO_OUTBOX_MEMBERSHIP_CANCELLATION_CONTACT_TYPE;
  memberId: string;
  requestId: string;
  participantId: string;
}

type QueuedOutboxPayload =
  | QueuedEntranceFeeOutboxPayload
  | QueuedBookingInvoiceOutboxPayload
  | QueuedBookingInvoiceUpdateOutboxPayload
  | QueuedRefundCreditNoteOutboxPayload
  | QueuedAccountCreditNoteOutboxPayload
  | QueuedSupplementaryInvoiceOutboxPayload
  | QueuedModificationCreditNoteOutboxPayload
  | QueuedCreditNoteAllocationOutboxPayload
  | QueuedMembershipCancellationCreditNoteOutboxPayload
  | QueuedMembershipCancellationContactOutboxPayload;

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
  return value === "ADULT" || value === "FAMILY" || value === "YOUTH" || value === "CHILD"
    ? value
    : null;
}

function readQueuedOutboxPayload(value: unknown): QueuedOutboxPayload | null {
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
      bookingModificationId: readString(payload.bookingModificationId) ?? undefined,
      recordPayment:
        typeof payload.recordPayment === "boolean" ? payload.recordPayment : undefined,
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
      bookingModificationId: readString(payload.bookingModificationId) ?? undefined,
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

function readQueueType(value: unknown): string | null {
  const payload = asRecord(value);
  if (!payload) {
    return null;
  }

  return readString(payload.queueType);
}

async function claimQueuedOutboxOperation(
  operationId: string,
  expectedOperation: {
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
) {
  const result = await prisma.xeroSyncOperation.updateMany({
    where: {
      id: operationId,
      status: "PENDING",
      direction: "OUTBOUND",
      entityType: expectedOperation.entityType,
      operationType: expectedOperation.operationType,
      localModel: {
        in: [...expectedOperation.localModels],
      },
    },
    data: {
      status: "RUNNING",
      startedAt: new Date(),
      completedAt: null,
      lastErrorCode: null,
      lastErrorMessage: null,
    },
  });

  return result.count === 1;
}

function buildPrecomputedEntranceFeeContext(
  payload: QueuedOutboxPayload
): EntranceFeeContext | null {
  if (
    payload.queueType !== XERO_OUTBOX_ENTRANCE_FEE_TYPE ||
    !payload.category ||
    payload.feeAmountCents === null ||
    payload.feeAmountCents === undefined
  ) {
    return null;
  }

  const entranceFeeContext: EntranceFeeContext = {
    category: payload.category,
    feeMapping: {
      itemCode: payload.itemCode ?? null,
      amountCents: payload.feeAmountCents,
    },
  };
  if (payload.description) {
    entranceFeeContext.description = payload.description;
  }

  return entranceFeeContext;
}

export async function enqueueXeroEntranceFeeInvoiceOperation(
  memberId: string,
  options?: {
    createdByMemberId?: string;
    amountCents?: number | null;
    description?: string | null;
  }
) {
  const existingLink = await prisma.xeroObjectLink.findFirst({
    where: {
      localModel: "Member",
      localId: memberId,
      xeroObjectType: "INVOICE",
      role: "ENTRANCE_FEE_INVOICE",
      active: true,
    },
    select: { id: true },
  });

  if (existingLink) {
    return {
      queueOperationId: null,
      message: "Xero entrance fee invoice already linked for this member.",
    };
  }

  const entranceFee = await getEntranceFeeContext(memberId);
  const feeAmountCents =
    options?.amountCents ?? entranceFee.feeMapping.amountCents;
  const description = options?.description?.trim() || null;

  if (!feeAmountCents || feeAmountCents <= 0) {
    return {
      queueOperationId: null,
      message: "No entrance fee is configured for this member category.",
    };
  }

  const correlationKey = buildEntranceFeeInvoiceIdempotencyKey(
    memberId,
    entranceFee.category,
    feeAmountCents
  );

  const existingQueuedOperation = await prisma.xeroSyncOperation.findFirst({
    where: {
      correlationKey,
      direction: "OUTBOUND",
      entityType: "INVOICE",
      operationType: "CREATE",
      localModel: "Member",
      localId: memberId,
      status: {
        in: ["PENDING", "RUNNING"],
      },
    },
    orderBy: {
      createdAt: "desc",
    },
  });

  if (existingQueuedOperation) {
    return {
      queueOperationId: existingQueuedOperation.id,
      message: "Xero entrance fee invoice is already queued for background processing.",
    };
  }

  const queuedOperation = await startXeroSyncOperation({
    direction: "OUTBOUND",
    entityType: "INVOICE",
    operationType: "CREATE",
    localModel: "Member",
    localId: memberId,
    status: "PENDING",
    idempotencyKey: correlationKey,
    correlationKey,
    requestPayload: {
      queueType: XERO_OUTBOX_ENTRANCE_FEE_TYPE,
      category: entranceFee.category,
      itemCode: entranceFee.feeMapping.itemCode,
      feeAmountCents,
      ...(description ? { description } : {}),
    },
    createdByMemberId: options?.createdByMemberId ?? null,
  });

  return {
    queueOperationId: queuedOperation.id,
    message: "Xero entrance fee invoice queued for background processing.",
  };
}

export async function enqueueXeroBookingInvoiceOperation(
  bookingId: string,
  options?: { createdByMemberId?: string }
) {
  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
    select: {
      id: true,
      payment: {
        select: {
          id: true,
          xeroInvoiceId: true,
        },
      },
    },
  });

  if (!booking) {
    throw new Error(`Booking not found: ${bookingId}`);
  }

  if (!booking.payment) {
    throw new Error(`No payment record for booking: ${bookingId}`);
  }

  if (booking.payment.xeroInvoiceId) {
    return {
      queueOperationId: null,
      message: "Xero booking invoice already linked for this booking.",
    };
  }

  const existingLink = await prisma.xeroObjectLink.findFirst({
    where: {
      localModel: "Payment",
      localId: booking.payment.id,
      xeroObjectType: "INVOICE",
      role: "PRIMARY_INVOICE",
      active: true,
    },
    select: { id: true },
  });

  if (existingLink) {
    return {
      queueOperationId: null,
      message: "Xero booking invoice already linked for this booking.",
    };
  }

  const correlationKey = buildXeroIdempotencyKey(
    "booking",
    bookingId,
    "invoice",
    "v1"
  );

  const existingQueuedOperation = await prisma.xeroSyncOperation.findFirst({
    where: {
      correlationKey,
      direction: "OUTBOUND",
      entityType: "INVOICE",
      operationType: "CREATE",
      localModel: "Payment",
      localId: booking.payment.id,
      status: {
        in: ["PENDING", "RUNNING"],
      },
    },
    orderBy: {
      createdAt: "desc",
    },
  });

  if (existingQueuedOperation) {
    return {
      queueOperationId: existingQueuedOperation.id,
      message: "Xero booking invoice is already queued for background processing.",
    };
  }

  const queuedOperation = await startXeroSyncOperation({
    direction: "OUTBOUND",
    entityType: "INVOICE",
    operationType: "CREATE",
    localModel: "Payment",
    localId: booking.payment.id,
    status: "PENDING",
    idempotencyKey: correlationKey,
    correlationKey,
    requestPayload: {
      queueType: XERO_OUTBOX_BOOKING_INVOICE_TYPE,
      bookingId,
    },
    createdByMemberId: options?.createdByMemberId ?? null,
  });

  return {
    queueOperationId: queuedOperation.id,
    message: "Xero booking invoice queued for background processing.",
  };
}

export async function enqueueXeroBookingInvoiceUpdateOperation(
  bookingId: string,
  options?: { createdByMemberId?: string }
) {
  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
    select: {
      id: true,
      checkIn: true,
      checkOut: true,
      payment: {
        select: {
          id: true,
          xeroInvoiceId: true,
        },
      },
    },
  });

  if (!booking) {
    throw new Error(`Booking not found: ${bookingId}`);
  }

  if (!booking.payment) {
    throw new Error(`No payment record for booking: ${bookingId}`);
  }

  if (!booking.payment.xeroInvoiceId) {
    return {
      queueOperationId: null,
      message: "No original Xero invoice exists for this booking.",
    };
  }

  const correlationKey = buildXeroIdempotencyKey(
    "booking",
    bookingId,
    "invoice-update",
    booking.payment.xeroInvoiceId,
    booking.checkIn.toISOString().slice(0, 10),
    booking.checkOut.toISOString().slice(0, 10),
    "v1"
  );

  const existingQueuedOperation = await prisma.xeroSyncOperation.findFirst({
    where: {
      correlationKey,
      direction: "OUTBOUND",
      entityType: "INVOICE",
      operationType: "UPDATE",
      localModel: "Payment",
      localId: booking.payment.id,
      status: {
        in: ["PENDING", "RUNNING"],
      },
    },
    orderBy: {
      createdAt: "desc",
    },
  });

  if (existingQueuedOperation) {
    return {
      queueOperationId: existingQueuedOperation.id,
      message: "Xero booking invoice update is already queued for background processing.",
    };
  }

  const queuedOperation = await startXeroSyncOperation({
    direction: "OUTBOUND",
    entityType: "INVOICE",
    operationType: "UPDATE",
    localModel: "Payment",
    localId: booking.payment.id,
    status: "PENDING",
    idempotencyKey: correlationKey,
    correlationKey,
    requestPayload: {
      queueType: XERO_OUTBOX_BOOKING_INVOICE_UPDATE_TYPE,
      bookingId,
      xeroInvoiceId: booking.payment.xeroInvoiceId,
    },
    createdByMemberId: options?.createdByMemberId ?? null,
  });

  return {
    queueOperationId: queuedOperation.id,
    message: "Xero booking invoice update queued for background processing.",
  };
}

export async function enqueueXeroRefundCreditNoteOperation(
  paymentId: string,
  refundAmountCents: number,
  options?: { createdByMemberId?: string }
) {
  const payment = await prisma.payment.findUnique({
    where: { id: paymentId },
    select: {
      id: true,
      xeroRefundCreditNoteId: true,
    },
  });

  if (!payment) {
    throw new Error(`Payment not found: ${paymentId}`);
  }

  if (refundAmountCents <= 0) {
    return {
      queueOperationId: null,
      message: "No additional Xero refund credit note is required for this payment.",
    };
  }

  const canonicalLink = await findCanonicalPaymentRefundCreditNote(paymentId);
  if (canonicalLink) {
    if (payment.xeroRefundCreditNoteId !== canonicalLink.xeroObjectId) {
      await prisma.payment.update({
        where: { id: paymentId },
        data: {
          xeroRefundCreditNoteId: canonicalLink.xeroObjectId,
        },
      });
    }
    await upsertXeroObjectLink({
      localModel: "Payment",
      localId: paymentId,
      xeroObjectType: "CREDIT_NOTE",
      xeroObjectId: canonicalLink.xeroObjectId,
      xeroObjectNumber: canonicalLink.xeroObjectNumber,
      role: "REFUND_CREDIT_NOTE",
    });

    return {
      queueOperationId: null,
      message: "Xero refund credit note already linked for this payment.",
    };
  }

  const correlationKey = buildXeroIdempotencyKey(
    "payment",
    paymentId,
    "refund-credit-note",
    refundAmountCents,
    "v1"
  );

  const existingQueuedOperation = await prisma.xeroSyncOperation.findFirst({
    where: {
      correlationKey,
      direction: "OUTBOUND",
      entityType: "CREDIT_NOTE",
      operationType: "CREATE",
      localModel: "Payment",
      localId: paymentId,
      status: {
        in: ["PENDING", "RUNNING"],
      },
    },
    orderBy: {
      createdAt: "desc",
    },
  });

  if (existingQueuedOperation) {
    return {
      queueOperationId: existingQueuedOperation.id,
      message: "Xero refund credit note is already queued for background processing.",
    };
  }

  const queuedOperation = await startXeroSyncOperation({
    direction: "OUTBOUND",
    entityType: "CREDIT_NOTE",
    operationType: "CREATE",
    localModel: "Payment",
    localId: paymentId,
    status: "PENDING",
    idempotencyKey: correlationKey,
    correlationKey,
    requestPayload: {
      queueType: XERO_OUTBOX_REFUND_CREDIT_NOTE_TYPE,
      refundAmountCents,
    },
    createdByMemberId: options?.createdByMemberId ?? null,
  });

  return {
    queueOperationId: queuedOperation.id,
    message: "Xero refund credit note queued for background processing.",
  };
}

export async function enqueueXeroAccountCreditNoteOperation(
  paymentId: string,
  refundAmountCents: number,
  options?: { createdByMemberId?: string }
) {
  if (refundAmountCents <= 0) {
    return {
      queueOperationId: null,
      message: "No account-credit note is required for this refund.",
    };
  }

  const payment = await prisma.payment.findUnique({
    where: { id: paymentId },
    select: {
      id: true,
    },
  });

  if (!payment) {
    throw new Error(`Payment not found: ${paymentId}`);
  }

  const existingLink = await prisma.xeroObjectLink.findFirst({
    where: {
      localModel: "Payment",
      localId: paymentId,
      xeroObjectType: "CREDIT_NOTE",
      role: "ACCOUNT_CREDIT_NOTE",
      active: true,
    },
    select: { id: true },
  });

  if (existingLink) {
    return {
      queueOperationId: null,
      message: "Xero account-credit note already linked for this payment.",
    };
  }

  const correlationKey = buildXeroIdempotencyKey(
    "payment",
    paymentId,
    "unapplied-credit-note",
    refundAmountCents,
    "v1"
  );

  const existingQueuedOperation = await prisma.xeroSyncOperation.findFirst({
    where: {
      correlationKey,
      direction: "OUTBOUND",
      entityType: "CREDIT_NOTE",
      operationType: "CREATE",
      localModel: "Payment",
      localId: paymentId,
      status: {
        in: ["PENDING", "RUNNING"],
      },
    },
    orderBy: {
      createdAt: "desc",
    },
  });

  if (existingQueuedOperation) {
    return {
      queueOperationId: existingQueuedOperation.id,
      message: "Xero account-credit note is already queued for background processing.",
    };
  }

  const queuedOperation = await startXeroSyncOperation({
    direction: "OUTBOUND",
    entityType: "CREDIT_NOTE",
    operationType: "CREATE",
    localModel: "Payment",
    localId: paymentId,
    status: "PENDING",
    idempotencyKey: correlationKey,
    correlationKey,
    requestPayload: {
      queueType: XERO_OUTBOX_ACCOUNT_CREDIT_NOTE_TYPE,
      refundAmountCents,
    },
    createdByMemberId: options?.createdByMemberId ?? null,
  });

  return {
    queueOperationId: queuedOperation.id,
    message: "Xero account-credit note queued for background processing.",
  };
}

export async function enqueueXeroSupplementaryInvoiceOperation(
  params: {
    bookingId: string;
    priceDiffCents: number;
    changeFeeCents: number;
    bookingModificationId?: string;
  },
  options?: {
    createdByMemberId?: string;
    paymentIntentId?: string | null;
    waitForConfirmedAdditionalPayment?: boolean;
    recordPayment?: boolean;
  }
) {
  const {
    bookingId,
    priceDiffCents,
    changeFeeCents,
    bookingModificationId,
  } = params;

  if (priceDiffCents <= 0 && changeFeeCents <= 0) {
    return {
      queueOperationId: null,
      message: "No supplementary invoice is required for this modification.",
    };
  }

  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
    select: {
      id: true,
      payment: {
        select: {
          xeroInvoiceId: true,
        },
      },
    },
  });

  if (!booking) {
    throw new Error(`Booking not found: ${bookingId}`);
  }

  if (!booking.payment?.xeroInvoiceId) {
    return {
      queueOperationId: null,
      message: "No original Xero invoice exists for this booking.",
    };
  }

  const localModel = bookingModificationId ? "BookingModification" : "Booking";
  const localId = bookingModificationId ?? bookingId;

  const existingLink = await prisma.xeroObjectLink.findFirst({
    where: {
      localModel,
      localId,
      xeroObjectType: "INVOICE",
      role: "SUPPLEMENTARY_INVOICE",
      active: true,
    },
    select: { id: true },
  });

  if (existingLink) {
    return {
      queueOperationId: null,
      message: "Xero supplementary invoice already linked for this modification.",
    };
  }

  const correlationKey = buildXeroIdempotencyKey(
    bookingModificationId ? "booking-mod" : "booking",
    localId,
    "supplementary-invoice",
    priceDiffCents,
    changeFeeCents,
    "v1"
  );

  const existingQueuedOperation = await prisma.xeroSyncOperation.findFirst({
    where: {
      correlationKey,
      direction: "OUTBOUND",
      entityType: "INVOICE",
      operationType: "CREATE",
      localModel,
      localId,
      status: {
        in: ["PENDING", "RUNNING", "WAITING_PAYMENT"],
      },
    },
    orderBy: {
      createdAt: "desc",
    },
  });

  if (existingQueuedOperation) {
    return {
      queueOperationId: existingQueuedOperation.id,
      message: "Xero supplementary invoice is already queued for background processing.",
    };
  }

  const queuedOperation = await startXeroSyncOperation({
    direction: "OUTBOUND",
    entityType: "INVOICE",
    operationType: "CREATE",
    localModel,
    localId,
    status: options?.waitForConfirmedAdditionalPayment ? "WAITING_PAYMENT" : "PENDING",
    idempotencyKey: correlationKey,
    correlationKey,
    requestPayload: {
      queueType: XERO_OUTBOX_SUPPLEMENTARY_INVOICE_TYPE,
      bookingId,
      priceDiffCents,
      changeFeeCents,
      bookingModificationId: bookingModificationId ?? null,
      recordPayment: options?.recordPayment ?? true,
      paymentIntentId: options?.paymentIntentId ?? null,
      waitForConfirmedAdditionalPayment:
        options?.waitForConfirmedAdditionalPayment ?? false,
    },
    createdByMemberId: options?.createdByMemberId ?? null,
  });

  return {
    queueOperationId: queuedOperation.id,
    message: options?.waitForConfirmedAdditionalPayment
      ? "Xero supplementary invoice is waiting for confirmed additional payment."
      : "Xero supplementary invoice queued for background processing.",
  };
}

export async function releaseXeroSupplementaryInvoiceOperationsForPaymentIntent(
  paymentIntentId: string
) {
  const waitingOperations = await prisma.xeroSyncOperation.findMany({
    where: {
      status: "WAITING_PAYMENT",
      direction: "OUTBOUND",
      entityType: "INVOICE",
      operationType: "CREATE",
      requestPayload: {
        path: ["paymentIntentId"],
        equals: paymentIntentId,
      },
    },
    select: { id: true },
  });

  if (waitingOperations.length === 0) {
    return {
      released: 0,
      queueOperationIds: [] as string[],
    };
  }

  const queueOperationIds = waitingOperations.map((operation) => operation.id);
  const updateResult = await prisma.xeroSyncOperation.updateMany({
    where: {
      id: {
        in: queueOperationIds,
      },
      status: "WAITING_PAYMENT",
    },
    data: {
      status: "PENDING",
      startedAt: null,
      lastErrorCode: null,
      lastErrorMessage: null,
    },
  });

  return {
    released: updateResult.count,
    queueOperationIds,
  };
}

const STALE_WAITING_PAYMENT_AGE_DAYS = 14;

export async function reapStaleWaitingPaymentXeroOutboxOperations(options?: {
  /** Override the staleness threshold in days. Defaults to 14. */
  ageInDays?: number;
}): Promise<{ reaped: number; queueOperationIds: string[] }> {
  const ageInDays =
    options?.ageInDays ?? STALE_WAITING_PAYMENT_AGE_DAYS;
  const ageThreshold = new Date(
    Date.now() - ageInDays * 24 * 60 * 60 * 1000,
  );

  const waitingOperations = await prisma.xeroSyncOperation.findMany({
    where: {
      status: "WAITING_PAYMENT",
      direction: "OUTBOUND",
    },
    select: {
      id: true,
      createdAt: true,
      requestPayload: true,
    },
  });

  if (waitingOperations.length === 0) {
    return { reaped: 0, queueOperationIds: [] };
  }

  const reapableIds: string[] = [];
  for (const operation of waitingOperations) {
    if (operation.createdAt <= ageThreshold) {
      reapableIds.push(operation.id);
      continue;
    }

    const payload = operation.requestPayload as
      | { paymentIntentId?: string | null }
      | null;
    const paymentIntentId = payload?.paymentIntentId ?? null;
    if (!paymentIntentId) continue;

    const failedTransaction = await prisma.paymentTransaction.findFirst({
      where: {
        stripePaymentIntentId: paymentIntentId,
        status: "FAILED",
      },
      select: { id: true },
    });
    if (failedTransaction) {
      reapableIds.push(operation.id);
    }
  }

  if (reapableIds.length === 0) {
    return { reaped: 0, queueOperationIds: [] };
  }

  const updateResult = await prisma.xeroSyncOperation.updateMany({
    where: {
      id: { in: reapableIds },
      status: "WAITING_PAYMENT",
    },
    data: {
      status: "CANCELLED",
      completedAt: new Date(),
      lastErrorCode: "STALE_WAITING_PAYMENT",
      lastErrorMessage:
        "Reaped: linked Stripe payment failed or did not confirm in time.",
    },
  });

  if (updateResult.count > 0) {
    logger.info(
      { reaped: updateResult.count, ageInDays },
      "Reaped stale WAITING_PAYMENT Xero outbox operations",
    );
  }

  return {
    reaped: updateResult.count,
    queueOperationIds: reapableIds,
  };
}

export async function recordSkippedXeroBookingInvoiceUpdateOperation(params: {
  bookingId: string;
  bookingModificationId: string;
  reason: string;
  createdByMemberId?: string;
}) {
  const booking = await prisma.booking.findUnique({
    where: { id: params.bookingId },
    select: {
      payment: {
        select: {
          id: true,
          xeroInvoiceId: true,
          xeroInvoiceNumber: true,
        },
      },
    },
  });

  const correlationKey = buildXeroIdempotencyKey(
    "booking-mod",
    params.bookingModificationId,
    "primary-invoice-update",
    "skipped",
    "v1"
  );
  const existingOperation = await prisma.xeroSyncOperation.findFirst({
    where: {
      correlationKey,
      direction: "OUTBOUND",
      entityType: "INVOICE",
      operationType: "UPDATE",
      localModel: "BookingModification",
      localId: params.bookingModificationId,
    },
    orderBy: {
      createdAt: "desc",
    },
    select: { id: true },
  });

  if (existingOperation) {
    return {
      queueOperationId: existingOperation.id,
      message: "Skipped Xero primary invoice update already recorded for this modification.",
    };
  }

  const operation = await startXeroSyncOperation({
    direction: "OUTBOUND",
    entityType: "INVOICE",
    operationType: "UPDATE",
    localModel: "BookingModification",
    localId: params.bookingModificationId,
    idempotencyKey: correlationKey,
    correlationKey,
    requestPayload: {
      queueType: XERO_OUTBOX_BOOKING_INVOICE_UPDATE_TYPE,
      bookingId: params.bookingId,
      xeroInvoiceId: booking?.payment?.xeroInvoiceId ?? null,
      skippedByPolicy: true,
      reason: params.reason,
    },
    createdByMemberId: params.createdByMemberId ?? null,
  });

  await completeXeroSyncOperation(operation.id, {
    responsePayload: {
      skipped: true,
      reason: params.reason,
      bookingId: params.bookingId,
      bookingModificationId: params.bookingModificationId,
      paymentId: booking?.payment?.id ?? null,
    },
    xeroObjectType: booking?.payment?.xeroInvoiceId ? "INVOICE" : null,
    xeroObjectId: booking?.payment?.xeroInvoiceId ?? null,
    xeroObjectNumber: booking?.payment?.xeroInvoiceNumber ?? null,
  });

  return {
    queueOperationId: operation.id,
    message: "Skipped Xero primary invoice update recorded for this modification.",
  };
}

export async function enqueueXeroModificationCreditNoteOperation(
  params: {
    bookingId: string;
    refundAmountCents: number;
    bookingModificationId?: string;
  },
  options?: { createdByMemberId?: string }
) {
  const {
    bookingId,
    refundAmountCents,
    bookingModificationId,
  } = params;

  if (refundAmountCents <= 0) {
    return {
      queueOperationId: null,
      message: "No modification credit note is required for this change.",
    };
  }

  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
    select: {
      id: true,
      payment: {
        select: {
          xeroInvoiceId: true,
        },
      },
    },
  });

  if (!booking) {
    throw new Error(`Booking not found: ${bookingId}`);
  }

  if (!booking.payment?.xeroInvoiceId) {
    return {
      queueOperationId: null,
      message: "No original Xero invoice exists for this booking.",
    };
  }

  const localModel = bookingModificationId ? "BookingModification" : "Booking";
  const localId = bookingModificationId ?? bookingId;

  const existingLink = await prisma.xeroObjectLink.findFirst({
    where: {
      localModel,
      localId,
      xeroObjectType: "CREDIT_NOTE",
      role: "MODIFICATION_CREDIT_NOTE",
      active: true,
    },
    select: { id: true },
  });

  if (existingLink) {
    return {
      queueOperationId: null,
      message: "Xero modification credit note already linked for this change.",
    };
  }

  const correlationKey = buildXeroIdempotencyKey(
    bookingModificationId ? "booking-mod" : "booking",
    localId,
    "mod-credit-note",
    refundAmountCents,
    "v1"
  );

  const existingQueuedOperation = await prisma.xeroSyncOperation.findFirst({
    where: {
      correlationKey,
      direction: "OUTBOUND",
      entityType: "CREDIT_NOTE",
      operationType: "CREATE",
      localModel,
      localId,
      status: {
        in: ["PENDING", "RUNNING"],
      },
    },
    orderBy: {
      createdAt: "desc",
    },
  });

  if (existingQueuedOperation) {
    return {
      queueOperationId: existingQueuedOperation.id,
      message: "Xero modification credit note is already queued for background processing.",
    };
  }

  const queuedOperation = await startXeroSyncOperation({
    direction: "OUTBOUND",
    entityType: "CREDIT_NOTE",
    operationType: "CREATE",
    localModel,
    localId,
    status: "PENDING",
    idempotencyKey: correlationKey,
    correlationKey,
    requestPayload: {
      queueType: XERO_OUTBOX_MODIFICATION_CREDIT_NOTE_TYPE,
      bookingId,
      refundAmountCents,
      bookingModificationId: bookingModificationId ?? null,
    },
    createdByMemberId: options?.createdByMemberId ?? null,
  });

  return {
    queueOperationId: queuedOperation.id,
    message: "Xero modification credit note queued for background processing.",
  };
}

export async function enqueueXeroCreditNoteAllocationOperation(
  params: {
    localModel: "Payment" | "Booking" | "BookingModification";
    localId: string;
    creditNoteId: string;
    invoiceId: string;
    amountCents: number;
    role?: string;
  },
  options?: { createdByMemberId?: string }
) {
  const {
    localModel,
    localId,
    creditNoteId,
    invoiceId,
    amountCents,
    role,
  } = params;

  if (amountCents <= 0) {
    return {
      queueOperationId: null,
      message: "No Xero credit-note allocation is required for this repair.",
    };
  }

  const existingLink = await prisma.xeroObjectLink.findFirst({
    where: {
      localModel,
      localId,
      xeroObjectType: "ALLOCATION",
      role: role ?? "CREDIT_NOTE_ALLOCATION",
      active: true,
    },
    select: { id: true },
  });

  if (existingLink) {
    return {
      queueOperationId: null,
      message: "Xero credit-note allocation already linked for this record.",
    };
  }

  const correlationKey = buildXeroIdempotencyKey(
    "credit-note",
    creditNoteId,
    "invoice",
    invoiceId,
    "allocation",
    amountCents,
    role ?? "CREDIT_NOTE_ALLOCATION",
    "v1"
  );

  const existingQueuedOperation = await prisma.xeroSyncOperation.findFirst({
    where: {
      correlationKey,
      direction: "OUTBOUND",
      entityType: "ALLOCATION",
      operationType: "ALLOCATE",
      localModel,
      localId,
      status: {
        in: ["PENDING", "RUNNING"],
      },
    },
    orderBy: {
      createdAt: "desc",
    },
  });

  if (existingQueuedOperation) {
    return {
      queueOperationId: existingQueuedOperation.id,
      message: "Xero credit-note allocation is already queued for background processing.",
    };
  }

  const queuedOperation = await startXeroSyncOperation({
    direction: "OUTBOUND",
    entityType: "ALLOCATION",
    operationType: "ALLOCATE",
    localModel,
    localId,
    status: "PENDING",
    idempotencyKey: correlationKey,
    correlationKey,
    requestPayload: {
      queueType: XERO_OUTBOX_CREDIT_NOTE_ALLOCATION_TYPE,
      creditNoteId,
      invoiceId,
      amountCents,
      role: role ?? null,
    },
    createdByMemberId: options?.createdByMemberId ?? null,
  });

  return {
    queueOperationId: queuedOperation.id,
    message: "Xero credit-note allocation queued for background processing.",
  };
}

export async function enqueueXeroMembershipCancellationCreditNoteOperation(
  params: {
    subscriptionId: string;
    requestId: string;
    participantId: string;
  },
  options?: { createdByMemberId?: string }
) {
  const subscription = await prisma.memberSubscription.findUnique({
    where: { id: params.subscriptionId },
    select: {
      id: true,
      status: true,
      xeroInvoiceId: true,
    },
  });

  if (!subscription) {
    return {
      queueOperationId: null,
      message: "Membership subscription was not found for cancellation Xero crediting.",
    };
  }

  if (
    subscription.status !== "UNPAID" &&
    subscription.status !== "OVERDUE"
  ) {
    return {
      queueOperationId: null,
      message: "No Xero membership cancellation credit note is required for this subscription status.",
    };
  }

  if (!subscription.xeroInvoiceId) {
    return {
      queueOperationId: null,
      message: "No Xero subscription invoice is linked for cancellation crediting.",
    };
  }

  const existingLink = await prisma.xeroObjectLink.findFirst({
    where: {
      localModel: "MemberSubscription",
      localId: params.subscriptionId,
      xeroObjectType: "CREDIT_NOTE",
      role: "MEMBERSHIP_CANCELLATION_CREDIT_NOTE",
      active: true,
    },
    select: { id: true },
  });

  if (existingLink) {
    return {
      queueOperationId: null,
      message: "Xero membership cancellation credit note already linked.",
    };
  }

  const correlationKey = buildXeroIdempotencyKey(
    "member-subscription",
    params.subscriptionId,
    "membership-cancellation-credit",
    params.participantId,
    "v1"
  );
  const existingQueuedOperation = await prisma.xeroSyncOperation.findFirst({
    where: {
      correlationKey,
      direction: "OUTBOUND",
      entityType: "CREDIT_NOTE",
      operationType: "CREATE",
      localModel: "MemberSubscription",
      localId: params.subscriptionId,
      status: {
        in: ["PENDING", "RUNNING"],
      },
    },
    orderBy: { createdAt: "desc" },
  });

  if (existingQueuedOperation) {
    return {
      queueOperationId: existingQueuedOperation.id,
      message: "Xero membership cancellation credit note is already queued for background processing.",
    };
  }

  const queuedOperation = await startXeroSyncOperation({
    direction: "OUTBOUND",
    entityType: "CREDIT_NOTE",
    operationType: "CREATE",
    localModel: "MemberSubscription",
    localId: params.subscriptionId,
    status: "PENDING",
    idempotencyKey: correlationKey,
    correlationKey,
    requestPayload: {
      queueType: XERO_OUTBOX_MEMBERSHIP_CANCELLATION_CREDIT_NOTE_TYPE,
      subscriptionId: params.subscriptionId,
      requestId: params.requestId,
      participantId: params.participantId,
    },
    createdByMemberId: options?.createdByMemberId ?? null,
  });

  return {
    queueOperationId: queuedOperation.id,
    message: "Xero membership cancellation credit note queued for background processing.",
  };
}

export async function enqueueXeroMembershipCancellationContactOperation(
  params: {
    memberId: string;
    requestId: string;
    participantId: string;
  },
  options?: { createdByMemberId?: string }
) {
  const member = await prisma.member.findUnique({
    where: { id: params.memberId },
    select: { id: true, xeroContactId: true },
  });

  if (!member?.xeroContactId) {
    return {
      queueOperationId: null,
      message: "No Xero contact is linked for membership cancellation contact cleanup.",
    };
  }

  const existingLink = await prisma.xeroObjectLink.findFirst({
    where: {
      localModel: "MembershipCancellationRequestParticipant",
      localId: params.participantId,
      xeroObjectType: "CONTACT",
      role: "MEMBERSHIP_CANCELLATION_CONTACT",
      active: true,
    },
    select: { id: true },
  });

  if (existingLink) {
    return {
      queueOperationId: null,
      message: "Xero membership cancellation contact cleanup already linked.",
    };
  }

  const correlationKey = buildXeroIdempotencyKey(
    "membership-cancellation",
    params.participantId,
    "contact",
    params.memberId,
    "v1"
  );
  const existingQueuedOperation = await prisma.xeroSyncOperation.findFirst({
    where: {
      correlationKey,
      direction: "OUTBOUND",
      entityType: "CONTACT",
      operationType: "UPDATE",
      localModel: "MembershipCancellationRequestParticipant",
      localId: params.participantId,
      status: {
        in: ["PENDING", "RUNNING"],
      },
    },
    orderBy: { createdAt: "desc" },
  });

  if (existingQueuedOperation) {
    return {
      queueOperationId: existingQueuedOperation.id,
      message: "Xero membership cancellation contact cleanup is already queued for background processing.",
    };
  }

  const queuedOperation = await startXeroSyncOperation({
    direction: "OUTBOUND",
    entityType: "CONTACT",
    operationType: "UPDATE",
    localModel: "MembershipCancellationRequestParticipant",
    localId: params.participantId,
    status: "PENDING",
    idempotencyKey: correlationKey,
    correlationKey,
    requestPayload: {
      queueType: XERO_OUTBOX_MEMBERSHIP_CANCELLATION_CONTACT_TYPE,
      memberId: params.memberId,
      requestId: params.requestId,
      participantId: params.participantId,
    },
    createdByMemberId: options?.createdByMemberId ?? null,
  });

  return {
    queueOperationId: queuedOperation.id,
    message: "Xero membership cancellation contact cleanup queued for background processing.",
  };
}

export async function queueApprovedMembershipCancellationXeroOperations(params: {
  memberId: string;
  requestId: string;
  participantId: string;
  createdByMemberId?: string;
}) {
  const seasonYear = getSeasonYear(new Date());
  const subscription = await prisma.memberSubscription.findUnique({
    where: {
      memberId_seasonYear: {
        memberId: params.memberId,
        seasonYear,
      },
    },
    select: { id: true },
  });
  const queuedResults: Array<{ queueOperationId: string | null; message: string }> = [];

  queuedResults.push(
    await enqueueXeroMembershipCancellationContactOperation(
      {
        memberId: params.memberId,
        requestId: params.requestId,
        participantId: params.participantId,
      },
      { createdByMemberId: params.createdByMemberId }
    )
  );

  if (subscription) {
    queuedResults.push(
      await enqueueXeroMembershipCancellationCreditNoteOperation(
        {
          subscriptionId: subscription.id,
          requestId: params.requestId,
          participantId: params.participantId,
        },
        { createdByMemberId: params.createdByMemberId }
      )
    );
  } else {
    queuedResults.push({
      queueOperationId: null,
      message: "No current-season membership subscription record exists for cancellation crediting.",
    });
  }

  if (queuedResults.some((result) => result.queueOperationId)) {
    void kickQueuedXeroOutboxOperationsIfConnected({ limit: queuedResults.length }).catch(
      (error) => {
        logger.error(
          { err: error, memberId: params.memberId, requestId: params.requestId },
          "Failed to kick queued Xero membership cancellation operations"
        );
      }
    );
  }

  return {
    seasonYear,
    results: queuedResults,
  };
}

export interface ProcessQueuedXeroOutboxOperationsResult {
  found: number;
  processed: number;
  succeeded: number;
  failed: number;
  skipped: number;
}

export async function kickQueuedXeroOutboxOperationsIfConnected(options?: {
  limit?: number;
}) {
  if (!(await isXeroConnected())) {
    return null;
  }

  return processQueuedXeroOutboxOperations(options);
}

export async function processQueuedXeroOutboxOperations(options?: {
  limit?: number;
}): Promise<ProcessQueuedXeroOutboxOperationsResult> {
  const limit = Math.min(Math.max(options?.limit ?? 10, 1), 50);
  const queuedOperations = await prisma.xeroSyncOperation.findMany({
    where: {
      status: "PENDING",
      direction: "OUTBOUND",
      OR: [
        {
          requestPayload: {
            path: ["queueType"],
            equals: XERO_OUTBOX_ENTRANCE_FEE_TYPE,
          },
        },
        {
          requestPayload: {
            path: ["queueType"],
            equals: XERO_OUTBOX_BOOKING_INVOICE_TYPE,
          },
        },
        {
          requestPayload: {
            path: ["queueType"],
            equals: XERO_OUTBOX_BOOKING_INVOICE_UPDATE_TYPE,
          },
        },
        {
          requestPayload: {
            path: ["queueType"],
            equals: XERO_OUTBOX_REFUND_CREDIT_NOTE_TYPE,
          },
        },
        {
          requestPayload: {
            path: ["queueType"],
            equals: XERO_OUTBOX_ACCOUNT_CREDIT_NOTE_TYPE,
          },
        },
        {
          requestPayload: {
            path: ["queueType"],
            equals: XERO_OUTBOX_SUPPLEMENTARY_INVOICE_TYPE,
          },
        },
        {
          requestPayload: {
            path: ["queueType"],
            equals: XERO_OUTBOX_MODIFICATION_CREDIT_NOTE_TYPE,
          },
        },
        {
          requestPayload: {
            path: ["queueType"],
            equals: XERO_OUTBOX_CREDIT_NOTE_ALLOCATION_TYPE,
          },
        },
        {
          requestPayload: {
            path: ["queueType"],
            equals: XERO_OUTBOX_MEMBERSHIP_CANCELLATION_CREDIT_NOTE_TYPE,
          },
        },
        {
          requestPayload: {
            path: ["queueType"],
            equals: XERO_OUTBOX_MEMBERSHIP_CANCELLATION_CONTACT_TYPE,
          },
        },
      ],
    },
    orderBy: {
      createdAt: "asc",
    },
    take: limit,
  });

  const result: ProcessQueuedXeroOutboxOperationsResult = {
    found: queuedOperations.length,
    processed: 0,
    succeeded: 0,
    failed: 0,
    skipped: 0,
  };

  for (const queuedOperation of queuedOperations) {
    const payload = readQueuedOutboxPayload(queuedOperation.requestPayload);
    const queueType = readQueueType(queuedOperation.requestPayload);
    const expectedOperation =
      queueType === XERO_OUTBOX_BOOKING_INVOICE_UPDATE_TYPE
        ? {
            entityType: "INVOICE" as const,
            operationType: "UPDATE" as const,
            localModels: ["Payment"] as const,
          }
        : queueType === XERO_OUTBOX_MEMBERSHIP_CANCELLATION_CONTACT_TYPE
        ? {
            entityType: "CONTACT" as const,
            operationType: "UPDATE" as const,
            localModels: ["MembershipCancellationRequestParticipant"] as const,
          }
        : queueType === XERO_OUTBOX_CREDIT_NOTE_ALLOCATION_TYPE
        ? {
            entityType: "ALLOCATION" as const,
            operationType: "ALLOCATE" as const,
            localModels: ["Payment", "Booking", "BookingModification"] as const,
          }
        : queueType === XERO_OUTBOX_REFUND_CREDIT_NOTE_TYPE
          || queueType === XERO_OUTBOX_ACCOUNT_CREDIT_NOTE_TYPE
          || queueType === XERO_OUTBOX_MODIFICATION_CREDIT_NOTE_TYPE
          || queueType === XERO_OUTBOX_MEMBERSHIP_CANCELLATION_CREDIT_NOTE_TYPE
        ? {
            entityType: "CREDIT_NOTE" as const,
            operationType: "CREATE" as const,
            localModels:
              queueType === XERO_OUTBOX_MODIFICATION_CREDIT_NOTE_TYPE
                ? (["Booking", "BookingModification"] as const)
                : queueType === XERO_OUTBOX_MEMBERSHIP_CANCELLATION_CREDIT_NOTE_TYPE
                  ? (["MemberSubscription"] as const)
                  : (["Payment"] as const),
          }
        : {
            entityType: "INVOICE" as const,
            operationType: "CREATE" as const,
            localModels:
              queueType === XERO_OUTBOX_BOOKING_INVOICE_TYPE
                ? (["Payment"] as const)
                : queueType === XERO_OUTBOX_SUPPLEMENTARY_INVOICE_TYPE
                  ? (["Booking", "BookingModification"] as const)
                  : (["Member"] as const),
          };
    const claimed = await claimQueuedOutboxOperation(queuedOperation.id, expectedOperation);
    if (!claimed) {
      result.skipped += 1;
      continue;
    }

    result.processed += 1;

    const entranceFeeContext = payload
      ? buildPrecomputedEntranceFeeContext(payload)
      : null;

    try {
      if (
        payload?.queueType === XERO_OUTBOX_ENTRANCE_FEE_TYPE &&
        queuedOperation.localId &&
        entranceFeeContext
      ) {
        await createXeroEntranceFeeInvoice(queuedOperation.localId, {
          createdByMemberId: queuedOperation.createdByMemberId ?? undefined,
          syncOperationId: queuedOperation.id,
          precomputedEntranceFee: entranceFeeContext,
        });
      } else if (payload?.queueType === XERO_OUTBOX_BOOKING_INVOICE_TYPE) {
        await createXeroInvoiceForBooking(payload.bookingId, {
          createdByMemberId: queuedOperation.createdByMemberId ?? undefined,
          syncOperationId: queuedOperation.id,
        });
      } else if (payload?.queueType === XERO_OUTBOX_BOOKING_INVOICE_UPDATE_TYPE) {
        await updateXeroBookingInvoiceForBooking(payload.bookingId, {
          createdByMemberId: queuedOperation.createdByMemberId ?? undefined,
          syncOperationId: queuedOperation.id,
        });
      } else if (
        payload?.queueType === XERO_OUTBOX_REFUND_CREDIT_NOTE_TYPE &&
        queuedOperation.localId
      ) {
        await createXeroCreditNote(
          queuedOperation.localId,
          payload.refundAmountCents,
          {
            createdByMemberId: queuedOperation.createdByMemberId ?? undefined,
            syncOperationId: queuedOperation.id,
          }
        );
      } else if (
        payload?.queueType === XERO_OUTBOX_ACCOUNT_CREDIT_NOTE_TYPE &&
        queuedOperation.localId
      ) {
        await createUnappliedXeroCreditNote(
          queuedOperation.localId,
          payload.refundAmountCents,
          {
            createdByMemberId: queuedOperation.createdByMemberId ?? undefined,
            syncOperationId: queuedOperation.id,
          }
        );
      } else if (payload?.queueType === XERO_OUTBOX_SUPPLEMENTARY_INVOICE_TYPE) {
        await createXeroSupplementaryInvoice({
          bookingId: payload.bookingId,
          priceDiffCents: payload.priceDiffCents,
          changeFeeCents: payload.changeFeeCents,
          bookingModificationId: payload.bookingModificationId,
          recordPayment: payload.recordPayment ?? true,
          createdByMemberId: queuedOperation.createdByMemberId ?? undefined,
          syncOperationId: queuedOperation.id,
        });
      } else if (payload?.queueType === XERO_OUTBOX_MODIFICATION_CREDIT_NOTE_TYPE) {
        await createXeroCreditNoteForModification({
          bookingId: payload.bookingId,
          refundAmountCents: payload.refundAmountCents,
          bookingModificationId: payload.bookingModificationId,
          createdByMemberId: queuedOperation.createdByMemberId ?? undefined,
          syncOperationId: queuedOperation.id,
        });
      } else if (
        payload?.queueType === XERO_OUTBOX_MEMBERSHIP_CANCELLATION_CREDIT_NOTE_TYPE
      ) {
        await createXeroMembershipCancellationCreditNote({
          subscriptionId: payload.subscriptionId,
          requestId: payload.requestId,
          participantId: payload.participantId,
          createdByMemberId: queuedOperation.createdByMemberId ?? undefined,
          syncOperationId: queuedOperation.id,
        });
      } else if (
        payload?.queueType === XERO_OUTBOX_MEMBERSHIP_CANCELLATION_CONTACT_TYPE
      ) {
        await syncXeroMembershipCancellationContact({
          memberId: payload.memberId,
          requestId: payload.requestId,
          participantId: payload.participantId,
          createdByMemberId: queuedOperation.createdByMemberId ?? undefined,
          syncOperationId: queuedOperation.id,
        });
      } else if (
        payload?.queueType === XERO_OUTBOX_CREDIT_NOTE_ALLOCATION_TYPE &&
        queuedOperation.localModel &&
        queuedOperation.localId
      ) {
        await allocateCreditNoteToInvoice(
          payload.creditNoteId,
          payload.invoiceId,
          payload.amountCents,
          {
            localModel: queuedOperation.localModel,
            localId: queuedOperation.localId,
            role: payload.role,
            createdByMemberId: queuedOperation.createdByMemberId ?? undefined,
            syncOperationId: queuedOperation.id,
          }
        );
      } else {
        throw new Error("Queued Xero outbox payload is incomplete.");
      }

      result.succeeded += 1;
    } catch (error) {
      if (
        error instanceof Error &&
        (
          error.message === "Queued Xero outbox payload is incomplete." ||
          payload?.queueType === XERO_OUTBOX_MEMBERSHIP_CANCELLATION_CREDIT_NOTE_TYPE ||
          payload?.queueType === XERO_OUTBOX_MEMBERSHIP_CANCELLATION_CONTACT_TYPE
        )
      ) {
        await failXeroSyncOperation(queuedOperation.id, error);
      }
      logger.error(
        {
          err: error,
          queueOperationId: queuedOperation.id,
          localId: queuedOperation.localId,
          queueType: payload?.queueType ?? null,
        },
        "Failed queued Xero outbox operation"
      );
      result.failed += 1;
    }
  }

  return result;
}
