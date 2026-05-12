import { Prisma } from "@prisma/client";
import { createHash } from "crypto";
import { prisma } from "./prisma";
import { getXeroErrorStatusCode } from "./xero-error-shape";
import { buildXeroObjectUrl } from "./xero-links";
import {
  redactSensitiveJson,
  redactSensitiveText,
} from "./redact-sensitive-json";
import logger from "@/lib/logger";

export interface XeroSyncOperationInput {
  direction: string;
  entityType: string;
  operationType: string;
  localModel?: string;
  localId?: string;
  status?: string;
  idempotencyKey?: string | null;
  correlationKey?: string | null;
  replayable?: boolean;
  requestPayload?: unknown;
  createdByMemberId?: string | null;
}

export interface XeroObjectLinkInput {
  localModel: string;
  localId: string;
  xeroObjectType: string;
  xeroObjectId: string;
  xeroObjectNumber?: string | null;
  xeroObjectUrl?: string | null;
  role: string;
  active?: boolean;
  metadata?: unknown;
}

export interface XeroSyncOperationCompletion {
  status?: string;
  responsePayload?: unknown;
  xeroObjectType?: string | null;
  xeroObjectId?: string | null;
  xeroObjectNumber?: string | null;
  xeroObjectUrl?: string | null;
  extraLinks?: XeroObjectLinkInput[];
}

export interface CanonicalPaymentRefundCreditNoteLink {
  xeroObjectId: string;
  xeroObjectNumber: string | null;
  source: "payment" | "refund_payment" | "operation" | "link";
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

export function sanitizeForJson(value: unknown): Prisma.InputJsonValue | undefined {
  if (value === undefined) {
    return undefined;
  }

  return JSON.parse(
    JSON.stringify(redactSensitiveJson(value))
  ) as Prisma.InputJsonValue;
}

function normalizePayloadHashValue(value: unknown): unknown {
  if (value === undefined) {
    return undefined;
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (typeof value === "bigint") {
    return value.toString();
  }

  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack,
    };
  }

  if (Array.isArray(value)) {
    return value.map((entry) => normalizePayloadHashValue(entry));
  }

  if (!value || typeof value !== "object") {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value)
      .map(([key, entryValue]) => [key, normalizePayloadHashValue(entryValue)] as const)
      .filter(([, entryValue]) => entryValue !== undefined)
  );
}

export function buildXeroPayloadHash(payload: unknown): string {
  // Idempotency keys must change when the outbound request changes, including
  // fields that are redacted before storage such as email addresses and phone numbers.
  const json = JSON.stringify(normalizePayloadHashValue(payload) ?? null);
  return createHash("sha256").update(json).digest("hex").slice(0, 12);
}

export function buildXeroIdempotencyKey(
  ...parts: Array<string | number | boolean | null | undefined>
): string {
  const base = parts
    .filter((part): part is string | number | boolean => part !== null && part !== undefined && part !== "")
    .map((part) => String(part))
    .join(":");

  if (!base) {
    throw new Error("Cannot build a Xero idempotency key from empty parts");
  }

  if (base.length <= 120) {
    return base;
  }

  const digest = createHash("sha256").update(base).digest("hex").slice(0, 12);
  return `${base.slice(0, 107)}:${digest}`;
}

export async function findCanonicalPaymentRefundCreditNote(
  paymentId: string
): Promise<CanonicalPaymentRefundCreditNoteLink | null> {
  const [payment, refundCreditNoteLinks, refundPaymentLinks, succeededOperation] =
    await Promise.all([
      prisma.payment.findUnique({
        where: { id: paymentId },
        select: {
          xeroRefundCreditNoteId: true,
        },
      }),
      prisma.xeroObjectLink.findMany({
        where: {
          localModel: "Payment",
          localId: paymentId,
          xeroObjectType: "CREDIT_NOTE",
          role: "REFUND_CREDIT_NOTE",
          active: true,
        },
        orderBy: [
          { updatedAt: "desc" },
          { createdAt: "desc" },
        ],
        select: {
          xeroObjectId: true,
          xeroObjectNumber: true,
        },
      }),
      prisma.xeroObjectLink.findMany({
        where: {
          localModel: "Payment",
          localId: paymentId,
          xeroObjectType: "PAYMENT",
          role: "REFUND_PAYMENT",
          active: true,
        },
        orderBy: [
          { updatedAt: "desc" },
          { createdAt: "desc" },
        ],
        select: {
          metadata: true,
        },
      }),
      prisma.xeroSyncOperation.findFirst({
        where: {
          status: "SUCCEEDED",
          entityType: "CREDIT_NOTE",
          operationType: "CREATE",
          localModel: "Payment",
          localId: paymentId,
          xeroObjectId: { not: null },
        },
        orderBy: [
          { completedAt: "desc" },
          { createdAt: "desc" },
        ],
        select: {
          xeroObjectId: true,
          xeroObjectNumber: true,
        },
      }),
    ]);

  const xeroObjectNumberById = new Map<string, string | null>();
  for (const link of refundCreditNoteLinks) {
    xeroObjectNumberById.set(link.xeroObjectId, link.xeroObjectNumber ?? null);
  }

  if (succeededOperation?.xeroObjectId && !xeroObjectNumberById.has(succeededOperation.xeroObjectId)) {
    xeroObjectNumberById.set(
      succeededOperation.xeroObjectId,
      succeededOperation.xeroObjectNumber ?? null
    );
  }

  if (payment?.xeroRefundCreditNoteId) {
    return {
      xeroObjectId: payment.xeroRefundCreditNoteId,
      xeroObjectNumber:
        xeroObjectNumberById.get(payment.xeroRefundCreditNoteId) ?? null,
      source: "payment",
    };
  }

  for (const link of refundPaymentLinks) {
    const metadata = asRecord(link.metadata);
    const linkedCreditNoteId = readString(metadata?.creditNoteId);
    if (linkedCreditNoteId) {
      return {
        xeroObjectId: linkedCreditNoteId,
        xeroObjectNumber: xeroObjectNumberById.get(linkedCreditNoteId) ?? null,
        source: "refund_payment",
      };
    }
  }

  if (succeededOperation?.xeroObjectId) {
    return {
      xeroObjectId: succeededOperation.xeroObjectId,
      xeroObjectNumber: succeededOperation.xeroObjectNumber ?? null,
      source: "operation",
    };
  }

  const latestActiveLink = refundCreditNoteLinks[0];
  if (!latestActiveLink) {
    return null;
  }

  return {
    xeroObjectId: latestActiveLink.xeroObjectId,
    xeroObjectNumber: latestActiveLink.xeroObjectNumber ?? null,
    source: "link",
  };
}

function getAttemptWhere(
  input: Pick<XeroSyncOperationInput, "correlationKey" | "idempotencyKey">
): Prisma.XeroSyncOperationWhereInput | undefined {
  const or: Prisma.XeroSyncOperationWhereInput[] = [];

  if (input.correlationKey) {
    or.push({ correlationKey: input.correlationKey });
  }

  if (input.idempotencyKey) {
    or.push({ idempotencyKey: input.idempotencyKey });
  }

  if (or.length === 0) {
    return undefined;
  }

  return { OR: or };
}

export async function startXeroSyncOperation(input: XeroSyncOperationInput) {
  const attemptWhere = getAttemptWhere(input);
  const attemptCount = attemptWhere
    ? (await prisma.xeroSyncOperation.count({ where: attemptWhere })) + 1
    : 1;

  return prisma.xeroSyncOperation.create({
    data: {
      direction: input.direction,
      entityType: input.entityType,
      operationType: input.operationType,
      localModel: input.localModel ?? null,
      localId: input.localId ?? null,
      status: input.status ?? "RUNNING",
      idempotencyKey: input.idempotencyKey ?? null,
      correlationKey: input.correlationKey ?? null,
      attemptCount,
      replayable: input.replayable ?? true,
      requestPayload: sanitizeForJson(input.requestPayload),
      createdByMemberId: input.createdByMemberId ?? null,
      startedAt: input.status === "PENDING" ? null : new Date(),
    },
  });
}

async function normalizePaymentRefundLinkWithClient(
  client: Prisma.TransactionClient,
  link: XeroObjectLinkInput
): Promise<XeroObjectLinkInput> {
  if (link.localModel !== "Payment") {
    return link;
  }

  if (link.role === "REFUND_CREDIT_NOTE" && link.xeroObjectType === "CREDIT_NOTE") {
    const payment = await client.payment.findUnique({
      where: { id: link.localId },
      select: {
        xeroRefundCreditNoteId: true,
      },
    });
    const canonicalCreditNoteId = payment?.xeroRefundCreditNoteId ?? link.xeroObjectId;
    const shouldBeActive = (link.active ?? true) && canonicalCreditNoteId === link.xeroObjectId;

    if (canonicalCreditNoteId === link.xeroObjectId) {
      await client.xeroObjectLink.updateMany({
        where: {
          localModel: "Payment",
          localId: link.localId,
          xeroObjectType: "CREDIT_NOTE",
          role: "REFUND_CREDIT_NOTE",
          active: true,
          xeroObjectId: {
            not: canonicalCreditNoteId,
          },
        },
        data: {
          active: false,
        },
      });
    }

    return {
      ...link,
      active: shouldBeActive,
    };
  }

  if (link.role === "REFUND_PAYMENT" && link.xeroObjectType === "PAYMENT") {
    const payment = await client.payment.findUnique({
      where: { id: link.localId },
      select: {
        xeroRefundCreditNoteId: true,
      },
    });
    const metadata = asRecord(link.metadata);
    const linkedCreditNoteId = readString(metadata?.creditNoteId);
    const canonicalCreditNoteId = payment?.xeroRefundCreditNoteId ?? linkedCreditNoteId;
    const shouldBeActive =
      (link.active ?? true)
      && (!canonicalCreditNoteId || linkedCreditNoteId === canonicalCreditNoteId);

    if (shouldBeActive) {
      await client.xeroObjectLink.updateMany({
        where: {
          localModel: "Payment",
          localId: link.localId,
          xeroObjectType: "PAYMENT",
          role: "REFUND_PAYMENT",
          active: true,
          xeroObjectId: {
            not: link.xeroObjectId,
          },
        },
        data: {
          active: false,
        },
      });
    }

    return {
      ...link,
      active: shouldBeActive,
    };
  }

  return link;
}

async function upsertXeroObjectLinkWithClient(
  client: Prisma.TransactionClient,
  link: XeroObjectLinkInput
) {
  const normalizedLink = await normalizePaymentRefundLinkWithClient(client, link);
  const xeroObjectUrl =
    normalizedLink.xeroObjectUrl ??
    buildXeroObjectUrl(normalizedLink.xeroObjectType, normalizedLink.xeroObjectId);

  return client.xeroObjectLink.upsert({
    where: {
      localModel_localId_xeroObjectType_xeroObjectId_role: {
        localModel: normalizedLink.localModel,
        localId: normalizedLink.localId,
        xeroObjectType: normalizedLink.xeroObjectType,
        xeroObjectId: normalizedLink.xeroObjectId,
        role: normalizedLink.role,
      },
    },
    create: {
      localModel: normalizedLink.localModel,
      localId: normalizedLink.localId,
      xeroObjectType: normalizedLink.xeroObjectType,
      xeroObjectId: normalizedLink.xeroObjectId,
      xeroObjectNumber: normalizedLink.xeroObjectNumber ?? null,
      xeroObjectUrl,
      role: normalizedLink.role,
      active: normalizedLink.active ?? true,
      metadata: sanitizeForJson(normalizedLink.metadata),
    },
    update: {
      xeroObjectNumber: normalizedLink.xeroObjectNumber ?? null,
      xeroObjectUrl,
      active: normalizedLink.active ?? true,
      metadata: sanitizeForJson(normalizedLink.metadata),
    },
  });
}

export async function upsertXeroObjectLink(link: XeroObjectLinkInput) {
  return prisma.$transaction((tx) => upsertXeroObjectLinkWithClient(tx, link));
}

export async function deactivateXeroObjectLinks(params: {
  localModel: string;
  localId: string;
  role?: string;
  xeroObjectType?: string;
  xeroObjectId?: string;
}) {
  return prisma.xeroObjectLink.updateMany({
    where: {
      localModel: params.localModel,
      localId: params.localId,
      role: params.role,
      xeroObjectType: params.xeroObjectType,
      xeroObjectId: params.xeroObjectId,
      active: true,
    },
    data: {
      active: false,
    },
  });
}

export async function completeXeroSyncOperation(
  operationId: string,
  completion: XeroSyncOperationCompletion
) {
  const xeroObjectUrl =
    completion.xeroObjectUrl ??
    (completion.xeroObjectType && completion.xeroObjectId
      ? buildXeroObjectUrl(completion.xeroObjectType, completion.xeroObjectId)
      : null);

  const operation = await prisma.$transaction(async (tx) => {
    const operation = await tx.xeroSyncOperation.update({
      where: { id: operationId },
      data: {
        status: completion.status ?? "SUCCEEDED",
        responsePayload: sanitizeForJson(completion.responsePayload),
        xeroObjectType: completion.xeroObjectType ?? null,
        xeroObjectId: completion.xeroObjectId ?? null,
        xeroObjectNumber: completion.xeroObjectNumber ?? null,
        xeroObjectUrl,
        completedAt: new Date(),
      },
    });

    for (const link of completion.extraLinks ?? []) {
      await upsertXeroObjectLinkWithClient(tx, link);
    }

    return operation;
  });

  if (operation.status === "PARTIAL") {
    try {
      const { maybeNotifyXeroRepeatedFailure } = await import("./xero-hardening");
      await maybeNotifyXeroRepeatedFailure(operation);
    } catch (error) {
      logger.error(
        {
          err: error,
          operationId,
        },
        "Failed to process repeated Xero failure alert for partial operation"
      );
    }
  }

  return operation;
}

export async function failXeroSyncOperation(
  operationId: string,
  error: unknown,
  responsePayload?: unknown
) {
  const statusCode = getXeroErrorStatusCode(error);
  const rawMessage =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "Unknown Xero sync failure";
  const message = redactSensitiveText(rawMessage);

  const operation = await prisma.xeroSyncOperation.update({
    where: { id: operationId },
    data: {
      status: "FAILED",
      lastErrorCode: statusCode ? String(statusCode) : null,
      lastErrorMessage: message,
      responsePayload: sanitizeForJson(responsePayload ?? error),
      completedAt: new Date(),
    },
  });

  try {
    const { maybeNotifyXeroRepeatedFailure } = await import("./xero-hardening");
    await maybeNotifyXeroRepeatedFailure(operation);
  } catch (alertError) {
    logger.error(
      {
        err: alertError,
        operationId,
      },
      "Failed to process repeated Xero failure alert for failed operation"
    );
  }

  return operation;
}

export async function recordXeroInboundEvent(input: {
  source?: string;
  eventCategory?: string | null;
  eventType: string;
  resourceId?: string | null;
  eventCreatedAt?: Date | null;
  correlationKey: string;
  payload: unknown;
  status?: string;
  errorMessage?: string | null;
  processedAt?: Date | null;
}) {
  const payload = sanitizeForJson(input.payload) ?? Prisma.JsonNull;
  const requestedStatus = input.status ?? "RECEIVED";
  const existing = await prisma.xeroInboundEvent.findUnique({
    where: {
      correlationKey: input.correlationKey,
    },
    select: {
      id: true,
      status: true,
      processedAt: true,
    },
  });

  const shouldPreserveTerminalState =
    requestedStatus === "RECEIVED" &&
    (existing?.status === "PROCESSING" || existing?.status === "PROCESSED");
  const nextStatus = shouldPreserveTerminalState ? existing.status : requestedStatus;
  const nextProcessedAt =
    nextStatus === "PROCESSED"
      ? existing?.processedAt ?? input.processedAt ?? new Date()
      : shouldPreserveTerminalState
        ? existing?.processedAt ?? null
        : input.processedAt ?? null;
  const data = {
    source: input.source ?? "webhook",
    eventCategory: input.eventCategory ?? null,
    eventType: input.eventType,
    resourceId: input.resourceId ?? null,
    eventCreatedAt: input.eventCreatedAt ?? null,
    correlationKey: input.correlationKey,
    payload,
    status: nextStatus,
    errorMessage: input.errorMessage ?? null,
    processedAt: nextProcessedAt,
  };

  if (!existing) {
    return prisma.xeroInboundEvent.create({ data });
  }

  return prisma.xeroInboundEvent.update({
    where: {
      id: existing.id,
    },
    data,
  });
}
