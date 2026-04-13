import type { XeroSyncOperation } from "@prisma/client";
import logger from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import {
  buildXeroIdempotencyKey,
  completeXeroSyncOperation,
  failXeroSyncOperation,
  startXeroSyncOperation,
} from "@/lib/xero-sync";
import {
  getXeroOperationRetryMeta,
  retryXeroSyncOperation,
  XeroOperationRetryError,
} from "@/lib/xero-operation-retry";

export const XERO_OPERATION_REQUEUE_TYPE = "REQUEUE";

interface QueuedRetryPayload {
  originalOperationId?: string;
  originalOperationType?: string;
  originalStatus?: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  return value as Record<string, unknown>;
}

function readQueuedRetryPayload(value: unknown): QueuedRetryPayload | null {
  const payload = asRecord(value);
  if (!payload) {
    return null;
  }

  return {
    originalOperationId:
      typeof payload.originalOperationId === "string" ? payload.originalOperationId : undefined,
    originalOperationType:
      typeof payload.originalOperationType === "string" ? payload.originalOperationType : undefined,
    originalStatus: typeof payload.originalStatus === "string" ? payload.originalStatus : undefined,
  };
}

export function buildXeroOperationRequeueCorrelationKey(operationId: string) {
  return buildXeroIdempotencyKey("xero-operation", "requeue", operationId);
}

async function claimQueuedRetryOperation(operationId: string) {
  const result = await prisma.xeroSyncOperation.updateMany({
    where: {
      id: operationId,
      status: "PENDING",
      operationType: XERO_OPERATION_REQUEUE_TYPE,
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

export async function enqueueXeroSyncOperationRetry(
  operationId: string,
  options?: { createdByMemberId?: string }
) {
  const operation = await prisma.xeroSyncOperation.findUnique({
    where: { id: operationId },
  });

  if (!operation) {
    throw new XeroOperationRetryError("Xero operation not found.", 404);
  }

  const retryMeta = getXeroOperationRetryMeta(operation);
  if (!retryMeta.supported) {
    throw new XeroOperationRetryError(
      retryMeta.reason ?? "This Xero operation cannot be queued for retry."
    );
  }

  const correlationKey = buildXeroOperationRequeueCorrelationKey(operationId);
  const existingQueuedRetry = await prisma.xeroSyncOperation.findFirst({
    where: {
      correlationKey,
      operationType: XERO_OPERATION_REQUEUE_TYPE,
      status: {
        in: ["PENDING", "RUNNING"],
      },
    },
    orderBy: {
      createdAt: "desc",
    },
  });

  if (existingQueuedRetry) {
    throw new XeroOperationRetryError(
      "A queued retry is already pending for this Xero operation.",
      409
    );
  }

  const queuedOperation = await startXeroSyncOperation({
    direction: operation.direction,
    entityType: operation.entityType,
    operationType: XERO_OPERATION_REQUEUE_TYPE,
    localModel: operation.localModel ?? undefined,
    localId: operation.localId ?? undefined,
    status: "PENDING",
    correlationKey,
    replayable: false,
    requestPayload: {
      originalOperationId: operation.id,
      originalOperationType: operation.operationType,
      originalStatus: operation.status,
    },
    createdByMemberId:
      options?.createdByMemberId ?? operation.createdByMemberId ?? undefined,
  });

  return {
    queueOperationId: queuedOperation.id,
    message: "Xero operation queued for background retry.",
  };
}

function getQueuedRetryOperationId(
  operation: Pick<XeroSyncOperation, "requestPayload">
) {
  return readQueuedRetryPayload(operation.requestPayload)?.originalOperationId ?? null;
}

export interface ProcessQueuedXeroOperationRetriesResult {
  found: number;
  processed: number;
  succeeded: number;
  failed: number;
  skipped: number;
}

export async function processQueuedXeroOperationRetries(options?: {
  limit?: number;
}): Promise<ProcessQueuedXeroOperationRetriesResult> {
  const limit = Math.min(Math.max(options?.limit ?? 10, 1), 50);
  const queuedOperations = await prisma.xeroSyncOperation.findMany({
    where: {
      status: "PENDING",
      operationType: XERO_OPERATION_REQUEUE_TYPE,
    },
    orderBy: {
      createdAt: "asc",
    },
    take: limit,
  });

  const result: ProcessQueuedXeroOperationRetriesResult = {
    found: queuedOperations.length,
    processed: 0,
    succeeded: 0,
    failed: 0,
    skipped: 0,
  };

  for (const queuedOperation of queuedOperations) {
    const claimed = await claimQueuedRetryOperation(queuedOperation.id);
    if (!claimed) {
      result.skipped += 1;
      continue;
    }

    result.processed += 1;

    const originalOperationId = getQueuedRetryOperationId(queuedOperation);
    if (!originalOperationId) {
      await failXeroSyncOperation(
        queuedOperation.id,
        new XeroOperationRetryError(
          "Queued retry payload is missing the original operation id."
        )
      );
      result.failed += 1;
      continue;
    }

    try {
      const replayResult = await retryXeroSyncOperation(originalOperationId, {
        createdByMemberId: queuedOperation.createdByMemberId ?? undefined,
      });

      await completeXeroSyncOperation(queuedOperation.id, {
        status: "SUCCEEDED",
        responsePayload: {
          originalOperationId,
          result: replayResult,
        },
      });

      result.succeeded += 1;
    } catch (error) {
      logger.error(
        {
          err: error,
          queueOperationId: queuedOperation.id,
          originalOperationId,
        },
        "Failed queued Xero operation retry"
      );
      await failXeroSyncOperation(queuedOperation.id, error);
      result.failed += 1;
    }
  }

  return result;
}
