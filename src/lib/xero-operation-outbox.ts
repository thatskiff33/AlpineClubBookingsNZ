import type { EntranceFeeCategory } from "@prisma/client";
import logger from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import { failXeroSyncOperation, startXeroSyncOperation } from "@/lib/xero-sync";
import {
  buildEntranceFeeInvoiceIdempotencyKey,
  createXeroEntranceFeeInvoice,
  getEntranceFeeContext,
  type EntranceFeeContext,
} from "@/lib/xero";

const XERO_OUTBOX_ENTRANCE_FEE_TYPE = "ENTRANCE_FEE_INVOICE";

interface QueuedOutboxPayload {
  queueType?: string;
  category?: EntranceFeeCategory;
  itemCode?: string | null;
  feeAmountCents?: number | null;
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
  return value === "ADULT" || value === "FAMILY" || value === "YOUTH" || value === "CHILD"
    ? value
    : null;
}

function readQueuedOutboxPayload(value: unknown): QueuedOutboxPayload | null {
  const payload = asRecord(value);
  if (!payload) {
    return null;
  }

  const queueType = readString(payload.queueType);
  const category = readEntranceFeeCategory(payload.category);
  const feeAmountCents = readNumber(payload.feeAmountCents);

  if (!queueType || !category || feeAmountCents === null) {
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

async function claimQueuedOutboxOperation(operationId: string) {
  const result = await prisma.xeroSyncOperation.updateMany({
    where: {
      id: operationId,
      status: "PENDING",
      direction: "OUTBOUND",
      entityType: "INVOICE",
      operationType: "CREATE",
      localModel: "Member",
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

export interface ProcessQueuedXeroOutboxOperationsResult {
  found: number;
  processed: number;
  succeeded: number;
  failed: number;
  skipped: number;
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
      localModel: "Member",
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
    const claimed = await claimQueuedOutboxOperation(queuedOperation.id);
    if (!claimed) {
      result.skipped += 1;
      continue;
    }

    result.processed += 1;

    const payload = readQueuedOutboxPayload(queuedOperation.requestPayload);
    const entranceFeeContext = payload
      ? buildPrecomputedEntranceFeeContext(payload)
      : null;

    if (!queuedOperation.localId || !entranceFeeContext) {
      await failXeroSyncOperation(
        queuedOperation.id,
        new Error("Queued Xero outbox payload is incomplete.")
      );
      result.failed += 1;
      continue;
    }

    try {
      await createXeroEntranceFeeInvoice(queuedOperation.localId, {
        createdByMemberId: queuedOperation.createdByMemberId ?? undefined,
        syncOperationId: queuedOperation.id,
        precomputedEntranceFee: entranceFeeContext,
      });
      result.succeeded += 1;
    } catch (error) {
      logger.error(
        {
          err: error,
          queueOperationId: queuedOperation.id,
          memberId: queuedOperation.localId,
        },
        "Failed queued Xero outbox operation"
      );
      result.failed += 1;
    }
  }

  return result;
}
