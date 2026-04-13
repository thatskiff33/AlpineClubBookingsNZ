import type { EntranceFeeCategory } from "@prisma/client";
import logger from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import {
  buildXeroIdempotencyKey,
  failXeroSyncOperation,
  startXeroSyncOperation,
} from "@/lib/xero-sync";
import {
  buildEntranceFeeInvoiceIdempotencyKey,
  createXeroEntranceFeeInvoice,
  createXeroInvoiceForBooking,
  getEntranceFeeContext,
  isXeroConnected,
  type EntranceFeeContext,
} from "@/lib/xero";

const XERO_OUTBOX_ENTRANCE_FEE_TYPE = "ENTRANCE_FEE_INVOICE";
const XERO_OUTBOX_BOOKING_INVOICE_TYPE = "BOOKING_INVOICE";

interface QueuedEntranceFeeOutboxPayload {
  queueType: typeof XERO_OUTBOX_ENTRANCE_FEE_TYPE;
  category: EntranceFeeCategory;
  itemCode: string | null;
  feeAmountCents: number;
}

interface QueuedBookingInvoiceOutboxPayload {
  queueType: typeof XERO_OUTBOX_BOOKING_INVOICE_TYPE;
  bookingId: string;
}

type QueuedOutboxPayload =
  | QueuedEntranceFeeOutboxPayload
  | QueuedBookingInvoiceOutboxPayload;

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
  localModel: "Member" | "Payment"
) {
  const result = await prisma.xeroSyncOperation.updateMany({
    where: {
      id: operationId,
      status: "PENDING",
      direction: "OUTBOUND",
      entityType: "INVOICE",
      operationType: "CREATE",
      localModel,
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

  return {
    category: payload.category,
    feeMapping: {
      itemCode: payload.itemCode ?? null,
      amountCents: payload.feeAmountCents,
    },
  };
}

export async function enqueueXeroEntranceFeeInvoiceOperation(
  memberId: string,
  options?: { createdByMemberId?: string }
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
  const feeAmountCents = entranceFee.feeMapping.amountCents;

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
      entityType: "INVOICE",
      operationType: "CREATE",
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
    const expectedLocalModel =
      queueType === XERO_OUTBOX_BOOKING_INVOICE_TYPE
        ? "Payment"
        : "Member";
    const claimed = await claimQueuedOutboxOperation(
      queuedOperation.id,
      expectedLocalModel
    );
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
      } else {
        throw new Error("Queued Xero outbox payload is incomplete.");
      }

      result.succeeded += 1;
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === "Queued Xero outbox payload is incomplete."
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
