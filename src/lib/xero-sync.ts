import { Prisma } from "@prisma/client";
import { createHash } from "crypto";
import { prisma } from "./prisma";
import { getXeroErrorStatusCode } from "./xero-error-shape";
import { buildXeroObjectUrl } from "./xero-links";

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

function jsonReplacer(_key: string, value: unknown): unknown {
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

  return value;
}

export function sanitizeForJson(value: unknown): Prisma.InputJsonValue | undefined {
  if (value === undefined) {
    return undefined;
  }

  return JSON.parse(JSON.stringify(value, jsonReplacer)) as Prisma.InputJsonValue;
}

export function buildXeroPayloadHash(payload: unknown): string {
  const json = JSON.stringify(sanitizeForJson(payload) ?? null);
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

async function upsertXeroObjectLinkWithClient(
  client: Prisma.TransactionClient,
  link: XeroObjectLinkInput
) {
  const xeroObjectUrl =
    link.xeroObjectUrl ??
    buildXeroObjectUrl(link.xeroObjectType, link.xeroObjectId);

  return client.xeroObjectLink.upsert({
    where: {
      localModel_localId_xeroObjectType_xeroObjectId_role: {
        localModel: link.localModel,
        localId: link.localId,
        xeroObjectType: link.xeroObjectType,
        xeroObjectId: link.xeroObjectId,
        role: link.role,
      },
    },
    create: {
      localModel: link.localModel,
      localId: link.localId,
      xeroObjectType: link.xeroObjectType,
      xeroObjectId: link.xeroObjectId,
      xeroObjectNumber: link.xeroObjectNumber ?? null,
      xeroObjectUrl,
      role: link.role,
      active: link.active ?? true,
      metadata: sanitizeForJson(link.metadata),
    },
    update: {
      xeroObjectNumber: link.xeroObjectNumber ?? null,
      xeroObjectUrl,
      active: link.active ?? true,
      metadata: sanitizeForJson(link.metadata),
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

  return prisma.$transaction(async (tx) => {
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
}

export async function failXeroSyncOperation(
  operationId: string,
  error: unknown,
  responsePayload?: unknown
) {
  const statusCode = getXeroErrorStatusCode(error);
  const message =
    error instanceof Error ? error.message : typeof error === "string" ? error : "Unknown Xero sync failure";

  return prisma.xeroSyncOperation.update({
    where: { id: operationId },
    data: {
      status: "FAILED",
      lastErrorCode: statusCode ? String(statusCode) : null,
      lastErrorMessage: message,
      responsePayload: sanitizeForJson(responsePayload ?? error),
      completedAt: new Date(),
    },
  });
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

  return prisma.xeroInboundEvent.upsert({
    where: {
      correlationKey: input.correlationKey,
    },
    create: {
      source: input.source ?? "webhook",
      eventCategory: input.eventCategory ?? null,
      eventType: input.eventType,
      resourceId: input.resourceId ?? null,
      eventCreatedAt: input.eventCreatedAt ?? null,
      correlationKey: input.correlationKey,
      payload,
      status: input.status ?? "RECEIVED",
      errorMessage: input.errorMessage ?? null,
      processedAt: input.processedAt ?? null,
    },
    update: {
      source: input.source ?? "webhook",
      eventCategory: input.eventCategory ?? null,
      eventType: input.eventType,
      resourceId: input.resourceId ?? null,
      eventCreatedAt: input.eventCreatedAt ?? null,
      payload,
      status: input.status ?? "RECEIVED",
      errorMessage: input.errorMessage ?? null,
      processedAt: input.processedAt ?? null,
    },
  });
}
