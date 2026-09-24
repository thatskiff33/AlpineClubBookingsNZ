import { type Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import logger from "@/lib/logger";
import { buildXeroContactUrl, buildXeroInvoiceUrl } from "@/lib/xero-links";
import { completeXeroSyncOperation, failXeroSyncOperation, startXeroSyncOperation } from "@/lib/xero-sync";
import { redactSensitiveText } from "@/lib/redact-sensitive-json";
import { isStaleProcessingXeroInboundEvent } from "@/lib/xero-stale-operations";
import { type ProcessStoredXeroInboundEventsResult, type RunXeroInboundReconciliationCycleResult, type StoredXeroInboundEvent, XeroInboundReplayError } from "./types";
import { DEFAULT_XERO_INBOUND_BATCH_SIZE, DEFAULT_XERO_INBOUND_FAILED_RETRY_BACKOFF_MS, DEFAULT_XERO_INBOUND_MAX_BATCHES } from "./constants";
import { runIncrementalContactReconciliation, runIncrementalMembershipReconciliation } from "./incremental-reconciliation";
import { reconcileXeroContact } from "./contact";
import { reconcileXeroPayment } from "./payment";
import { reconcileXeroInvoice, runIncrementalInvoiceReconciliation } from "./invoice";
import { reconcileXeroCreditNote } from "./credit-note";
import type { ClubFormat } from "@/lib/club-format";
import { clubFormatValues } from "@/lib/club-format-server";

function isPrismaUniqueConstraintError(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "P2002"
  );
}

function getXeroInboundFailedRetryBackoffMs() {
  const configured = Number.parseInt(
    process.env.XERO_INBOUND_FAILED_RETRY_BACKOFF_MS ?? "",
    10
  );

  if (Number.isFinite(configured) && configured >= 0) {
    return configured;
  }

  return DEFAULT_XERO_INBOUND_FAILED_RETRY_BACKOFF_MS;
}

function buildProcessedWebhookEventType(event: Pick<StoredXeroInboundEvent, "eventCategory" | "eventType">) {
  return `${event.eventCategory ?? "UNKNOWN"}.${event.eventType}`;
}

function buildInboundXeroObjectType(eventCategory: string | null): string | null {
  if (!eventCategory) {
    return null;
  }

  const normalized = eventCategory.trim().toUpperCase();
  return normalized || null;
}

async function processXeroInboundEvent(
  event: StoredXeroInboundEvent,
  format: ClubFormat,
) {
  if (!event.resourceId) {
    return {
      handled: false,
      kind: event.eventCategory ?? "UNKNOWN",
      reason: "Event did not include a resourceId.",
    };
  }

  switch (event.eventCategory) {
    case "CONTACT":
      return reconcileXeroContact(event.resourceId);
    case "INVOICE":
      return reconcileXeroInvoice(event.resourceId, format);
    case "PAYMENT":
      return reconcileXeroPayment(event.resourceId);
    case "CREDIT_NOTE":
      return reconcileXeroCreditNote(event.resourceId);
    default:
      return {
        handled: false,
        kind: event.eventCategory ?? "UNKNOWN",
        resourceId: event.resourceId,
        reason: `No inbound reconciliation handler for ${event.eventCategory ?? "UNKNOWN"}.${event.eventType}.`,
      };
  }
}

async function claimStoredInboundEvent(eventId: string) {
  const result = await prisma.xeroInboundEvent.updateMany({
    where: {
      id: eventId,
      status: {
        in: ["RECEIVED", "FAILED"],
      },
    },
    data: {
      status: "PROCESSING",
      errorMessage: null,
      processedAt: null,
    },
  });

  return result.count === 1;
}

async function markStoredInboundEventProcessed(eventId: string) {
  await prisma.xeroInboundEvent.update({
    where: {
      id: eventId,
    },
    data: {
      status: "PROCESSED",
      errorMessage: null,
      processedAt: new Date(),
    },
  });
}

async function markStoredInboundEventFailed(eventId: string, error: unknown) {
  const rawErrorMessage = error instanceof Error ? error.message : String(error);
  await prisma.xeroInboundEvent.update({
    where: {
      id: eventId,
    },
    data: {
      status: "FAILED",
      errorMessage: redactSensitiveText(rawErrorMessage),
      processedAt: null,
    },
  });
}

async function claimProcessedWebhookEvent(event: StoredXeroInboundEvent) {
  try {
    await prisma.processedWebhookEvent.create({
      data: {
        eventId: event.correlationKey,
        source: "xero",
        eventType: buildProcessedWebhookEventType(event),
      },
    });
    return true;
  } catch (error) {
    if (isPrismaUniqueConstraintError(error)) {
      return false;
    }

    throw error;
  }
}

async function releaseProcessedWebhookEventClaim(event: StoredXeroInboundEvent) {
  await prisma.processedWebhookEvent.deleteMany({
    where: {
      eventId: event.correlationKey,
      source: "xero",
    },
  });
}

// test seam
export async function processStoredXeroInboundEvents(options?: {
  limit?: number;
  eventIds?: string[];
}): Promise<ProcessStoredXeroInboundEventsResult> {
  // The club's format (#3565), resolved once, before any transaction or
  // lock below — never per amount and never inside a transaction.
  const format = await clubFormatValues();
  const limit = Math.min(Math.max(options?.limit ?? 10, 1), 50);
  const eventIds =
    options?.eventIds?.filter((value): value is string => typeof value === "string" && value.trim().length > 0) ?? [];
  const retryThreshold = new Date(
    Date.now() - getXeroInboundFailedRetryBackoffMs()
  );
  const statusWhere: Prisma.XeroInboundEventWhereInput =
    eventIds.length > 0
      ? {
          status: {
            in: ["RECEIVED", "FAILED"],
          },
        }
      : {
          OR: [
            { status: "RECEIVED" },
            {
              status: "FAILED",
              updatedAt: {
                lte: retryThreshold,
              },
            },
          ],
        };

  const events = await prisma.xeroInboundEvent.findMany({
    where: {
      ...statusWhere,
      ...(eventIds.length > 0
        ? {
            id: {
              in: eventIds,
            },
          }
        : {}),
    },
    orderBy: {
      createdAt: "asc",
    },
    take: limit,
  });

  const result: ProcessStoredXeroInboundEventsResult = {
    found: events.length,
    processed: 0,
    succeeded: 0,
    failed: 0,
    skipped: 0,
  };

  for (const event of events as StoredXeroInboundEvent[]) {
    const claimed = await claimStoredInboundEvent(event.id);
    if (!claimed) {
      result.skipped += 1;
      continue;
    }

    result.processed += 1;

    const deduped = await claimProcessedWebhookEvent(event);
    if (!deduped) {
      await markStoredInboundEventProcessed(event.id);
      result.skipped += 1;
      continue;
    }

    let operationId: string | null = null;

    try {
      const operation = await startXeroSyncOperation({
        direction: "INBOUND",
        entityType: event.eventCategory ?? "UNKNOWN",
        operationType: "WEBHOOK_RECONCILE",
        correlationKey: event.correlationKey,
        replayable: true,
        requestPayload: event.payload,
      });
      operationId = operation.id;

      const reconcileResult = await processXeroInboundEvent(event, format);
      await completeXeroSyncOperation(operationId, {
        responsePayload: reconcileResult,
        xeroObjectType: buildInboundXeroObjectType(event.eventCategory),
        xeroObjectId: event.resourceId,
        xeroObjectUrl:
          event.eventCategory === "CONTACT" && event.resourceId
            ? buildXeroContactUrl(event.resourceId)
            : event.eventCategory === "INVOICE" && event.resourceId
              ? buildXeroInvoiceUrl(event.resourceId)
              : null,
      });
      await markStoredInboundEventProcessed(event.id);
      result.succeeded += 1;
    } catch (error) {
      const retryAfterMs = getXeroInboundFailedRetryBackoffMs();
      const retryEligibleAt = new Date(Date.now() + retryAfterMs);
      logger.error(
        {
          err: error,
          inboundEventId: event.id,
          correlationKey: event.correlationKey,
          resourceId: event.resourceId,
          retryBackoffMs: retryAfterMs,
          retryEligibleAt: retryEligibleAt.toISOString(),
        },
        "Failed to process stored Xero inbound event; automatic retry is deferred"
      );

      if (operationId) {
        await failXeroSyncOperation(operationId, error);
      }
      await markStoredInboundEventFailed(event.id, error);
      await releaseProcessedWebhookEventClaim(event);
      result.failed += 1;
    }
  }

  return result;
}

export async function runXeroInboundReconciliationCycle(options?: {
  batchSize?: number;
  maxBatches?: number;
  seasonYear?: number;
  contactMinimumIntervalMs?: number;
  membershipMinimumIntervalMs?: number;
  includeContactReconciliation?: boolean;
  includeMembershipReconciliation?: boolean;
  includeInvoiceReconciliation?: boolean;
}): Promise<RunXeroInboundReconciliationCycleResult> {
  const batchSize = Math.min(
    Math.max(options?.batchSize ?? DEFAULT_XERO_INBOUND_BATCH_SIZE, 1),
    50
  );
  const maxBatches = Math.max(options?.maxBatches ?? DEFAULT_XERO_INBOUND_MAX_BATCHES, 1);
  const totals: RunXeroInboundReconciliationCycleResult["inbound"] = {
    batches: 0,
    found: 0,
    processed: 0,
    succeeded: 0,
    failed: 0,
    skipped: 0,
  };

  for (let batch = 0; batch < maxBatches; batch += 1) {
    const result = await processStoredXeroInboundEvents({ limit: batchSize });
    totals.batches += 1;
    totals.found += result.found;
    totals.processed += result.processed;
    totals.succeeded += result.succeeded;
    totals.failed += result.failed;
    totals.skipped += result.skipped;

    if (result.found < batchSize || result.processed === 0) {
      break;
    }
  }

  const contactReconciliation =
    options?.includeContactReconciliation === false
      ? null
      : await runIncrementalContactReconciliation({
          minimumIntervalMs: options?.contactMinimumIntervalMs,
        });
  const membershipReconciliation =
    options?.includeMembershipReconciliation === false
      ? null
      : await runIncrementalMembershipReconciliation({
          seasonYear: options?.seasonYear,
          minimumIntervalMs: options?.membershipMinimumIntervalMs,
        });
  const invoiceReconciliation =
    options?.includeInvoiceReconciliation === false
      ? null
      : await runIncrementalInvoiceReconciliation({
          membershipReconciliation,
        });

  return {
    inbound: totals,
    contactReconciliation,
    membershipReconciliation,
    invoiceReconciliation,
  };
}

export async function replayStoredXeroInboundEvent(eventId: string) {
  const event = await prisma.xeroInboundEvent.findUnique({
    where: {
      id: eventId,
    },
    select: {
      id: true,
      correlationKey: true,
      status: true,
      errorMessage: true,
      processedAt: true,
      updatedAt: true,
    },
  });

  if (!event) {
    throw new XeroInboundReplayError("Xero inbound event not found.", 404);
  }

  // A row claimed as PROCESSING is normally genuinely in flight, so replay is
  // refused. But if the worker died after claiming it the row would stay
  // PROCESSING forever with no sweep to reset it (issue #819/#815). Once the
  // claim is older than the staleness threshold, allow an operator to take it
  // over and replay it; the replay path below resets it to RECEIVED and
  // reprocesses idempotently.
  if (
    event.status === "PROCESSING" &&
    !isStaleProcessingXeroInboundEvent(event.updatedAt)
  ) {
    throw new XeroInboundReplayError(
      "This inbound event is already being processed.",
      409
    );
  }

  await prisma.$transaction(async (tx) => {
    await tx.processedWebhookEvent.deleteMany({
      where: {
        eventId: event.correlationKey,
        source: "xero",
      },
    });

    await tx.xeroInboundEvent.update({
      where: {
        id: event.id,
      },
      data: {
        status: "RECEIVED",
        errorMessage: null,
        processedAt: null,
      },
    });
  });

  const result = await processStoredXeroInboundEvents({
    limit: 1,
    eventIds: [event.id],
  });

  const replayedEvent = await prisma.xeroInboundEvent.findUnique({
    where: {
      id: event.id,
    },
    select: {
      id: true,
      status: true,
      errorMessage: true,
      processedAt: true,
    },
  });

  if (!replayedEvent) {
    throw new XeroInboundReplayError(
      "Xero inbound event disappeared during replay.",
      500
    );
  }

  if (replayedEvent.status === "FAILED") {
    throw new XeroInboundReplayError(
      replayedEvent.errorMessage ?? "Xero inbound event replay failed.",
      409
    );
  }

  return {
    result,
    event: replayedEvent,
  };
}
