import type { XeroSyncOperation } from "@prisma/client";
import { prisma } from "@/lib/prisma";

export type XeroFailureState = "ACTIVE" | "REPAIRED" | "SUPERSEDED";

export interface XeroFailureResolution {
  state: XeroFailureState;
  reason: string;
  rootKey: string;
  representativeOperationId: string;
}

export interface XeroFailedOperationOverview {
  totalFailedRows: number;
  activeFailedCount: number;
  legacyFailedCount: number;
  activeOperations: XeroSyncOperation[];
  resolutions: Map<string, XeroFailureResolution>;
}

type FailedOperation = Pick<
  XeroSyncOperation,
  | "id"
  | "status"
  | "entityType"
  | "operationType"
  | "localModel"
  | "localId"
  | "correlationKey"
  | "requestPayload"
  | "createdAt"
>;

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  return value as Record<string, unknown>;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function readOriginalOperationId(value: unknown): string | null {
  const payload = asRecord(value);
  if (!payload) {
    return null;
  }

  return readString(payload.originalOperationId);
}

function buildFallbackRootKey(operation: FailedOperation) {
  if (operation.correlationKey) {
    return `correlation:${operation.correlationKey}`;
  }

  if (operation.localModel && operation.localId) {
    return `local:${operation.localModel}:${operation.localId}:${operation.entityType}:${operation.operationType}`;
  }

  return `operation:${operation.id}`;
}

function buildRootKey(
  operation: FailedOperation,
  operationsById: Map<string, FailedOperation>,
  seen = new Set<string>()
): string {
  if (operation.operationType !== "REQUEUE") {
    return buildFallbackRootKey(operation);
  }

  const originalOperationId = readOriginalOperationId(operation.requestPayload);
  if (!originalOperationId || seen.has(originalOperationId)) {
    return buildFallbackRootKey(operation);
  }

  const originalOperation = operationsById.get(originalOperationId);
  if (!originalOperation) {
    return `requeue:${originalOperationId}`;
  }

  const nextSeen = new Set(seen);
  nextSeen.add(operation.id);
  return buildRootKey(originalOperation, operationsById, nextSeen);
}

function buildSupersededReason(representativeOperationId: string) {
  return representativeOperationId
    ? `A newer failed attempt now represents this same issue (${representativeOperationId.slice(0, 8)}).`
    : "A newer failed attempt now represents this same issue.";
}

function buildActiveReason(operation: FailedOperation) {
  if (operation.entityType === "CREDIT_NOTE" && operation.localModel === "Payment") {
    return "This payment still needs refund credit-note follow-up repair.";
  }

  if (operation.entityType === "CONTACT" && operation.operationType === "CREATE") {
    return "This member still needs a valid Xero contact link.";
  }

  return "This is the latest unresolved failure for this issue.";
}

export async function resolveFailedXeroOperationStates(
  failedOperations: XeroSyncOperation[]
): Promise<Map<string, XeroFailureResolution>> {
  if (failedOperations.length === 0) {
    return new Map();
  }

  const failedOperationIndex = new Map<string, FailedOperation>(
    failedOperations.map((operation) => [operation.id, operation])
  );

  const originalOperationIds = [...new Set(
    failedOperations
      .map((operation) => readOriginalOperationId(operation.requestPayload))
      .filter((operationId): operationId is string => Boolean(operationId))
  )];

  if (originalOperationIds.length > 0) {
    const originalOperations = await prisma.xeroSyncOperation.findMany({
      where: {
        id: {
          in: originalOperationIds,
        },
      },
      select: {
        id: true,
        status: true,
        entityType: true,
        operationType: true,
        localModel: true,
        localId: true,
        correlationKey: true,
        requestPayload: true,
        createdAt: true,
      },
    });

    for (const operation of originalOperations) {
      failedOperationIndex.set(operation.id, operation);
    }
  }

  const rootKeysByOperationId = new Map<string, string>();
  for (const operation of failedOperations) {
    rootKeysByOperationId.set(operation.id, buildRootKey(operation, failedOperationIndex));
  }

  const correlationKeys = [...new Set(
    [...failedOperationIndex.values()]
      .map((operation) => operation.correlationKey)
      .filter((correlationKey): correlationKey is string => Boolean(correlationKey))
  )];

  const [succeededOperations, members, payments, refundPaymentLinks, memberContactLinks] =
    await Promise.all([
      correlationKeys.length === 0
        ? Promise.resolve([])
        : prisma.xeroSyncOperation.findMany({
            where: {
              status: "SUCCEEDED",
              correlationKey: {
                in: correlationKeys,
              },
            },
            select: {
              id: true,
              correlationKey: true,
              createdAt: true,
            },
          }),
      prisma.member.findMany({
        where: {
          id: {
            in: [
              ...new Set(
                failedOperations
                  .filter(
                    (operation) =>
                      operation.entityType === "CONTACT"
                      && operation.localModel === "Member"
                      && Boolean(operation.localId)
                  )
                  .map((operation) => operation.localId as string)
              ),
            ],
          },
        },
        select: {
          id: true,
          xeroContactId: true,
        },
      }),
      prisma.payment.findMany({
        where: {
          id: {
            in: [
              ...new Set(
                failedOperations
                  .filter(
                    (operation) =>
                      operation.entityType === "CREDIT_NOTE"
                      && operation.localModel === "Payment"
                      && Boolean(operation.localId)
                  )
                  .map((operation) => operation.localId as string)
              ),
            ],
          },
        },
        select: {
          id: true,
          xeroRefundCreditNoteId: true,
        },
      }),
      prisma.xeroObjectLink.findMany({
        where: {
          localModel: "Payment",
          localId: {
            in: [
              ...new Set(
                failedOperations
                  .filter(
                    (operation) =>
                      operation.entityType === "CREDIT_NOTE"
                      && operation.localModel === "Payment"
                      && Boolean(operation.localId)
                  )
                  .map((operation) => operation.localId as string)
              ),
            ],
          },
          role: "REFUND_PAYMENT",
          active: true,
        },
        select: {
          localId: true,
        },
      }),
      prisma.xeroObjectLink.findMany({
        where: {
          localModel: "Member",
          localId: {
            in: [
              ...new Set(
                failedOperations
                  .filter(
                    (operation) =>
                      operation.entityType === "CONTACT"
                      && operation.localModel === "Member"
                      && Boolean(operation.localId)
                  )
                  .map((operation) => operation.localId as string)
              ),
            ],
          },
          xeroObjectType: "CONTACT",
          role: "CONTACT",
          active: true,
        },
        select: {
          localId: true,
        },
      }),
    ]);

  const succeededByCorrelation = new Set(
    succeededOperations
      .map((operation) => operation.correlationKey)
      .filter((correlationKey): correlationKey is string => Boolean(correlationKey))
  );
  const memberIdsWithContact = new Set(
    members
      .filter((member) => Boolean(member.xeroContactId))
      .map((member) => member.id)
  );
  for (const link of memberContactLinks) {
    memberIdsWithContact.add(link.localId);
  }

  const paymentIdsWithRefundRepair = new Set(
    payments
      .filter((payment) => Boolean(payment.xeroRefundCreditNoteId))
      .map((payment) => payment.id)
  );
  const paymentIdsWithRefundPaymentLink = new Set(
    refundPaymentLinks.map((link) => link.localId)
  );

  const groupedOperations = new Map<string, XeroSyncOperation[]>();
  for (const operation of failedOperations) {
    const rootKey = rootKeysByOperationId.get(operation.id) ?? `operation:${operation.id}`;
    const existing = groupedOperations.get(rootKey) ?? [];
    existing.push(operation);
    groupedOperations.set(rootKey, existing);
  }

  const resolutions = new Map<string, XeroFailureResolution>();

  for (const [rootKey, operations] of groupedOperations) {
    const ordered = [...operations].sort(
      (left, right) => right.createdAt.getTime() - left.createdAt.getTime()
    );
    const representative =
      ordered.find((operation) => operation.operationType !== "REQUEUE") ?? ordered[0];
    const groupCorrelationKey = rootKey.startsWith("correlation:")
      ? rootKey.slice("correlation:".length)
      : representative.correlationKey;

    let repairedReason: string | null = null;

    if (groupCorrelationKey && succeededByCorrelation.has(groupCorrelationKey)) {
      repairedReason = "A later successful run already repaired this issue.";
    } else if (
      representative.entityType === "CONTACT"
      && representative.localModel === "Member"
      && representative.localId
      && memberIdsWithContact.has(representative.localId)
    ) {
      repairedReason = "The member is already linked to a Xero contact.";
    } else if (
      representative.entityType === "CREDIT_NOTE"
      && representative.localModel === "Payment"
      && representative.localId
      && paymentIdsWithRefundRepair.has(representative.localId)
      && paymentIdsWithRefundPaymentLink.has(representative.localId)
    ) {
      repairedReason = "The payment already has a linked refund credit note and refund payment.";
    }

    if (repairedReason) {
      for (const operation of ordered) {
        resolutions.set(operation.id, {
          state: "REPAIRED",
          reason: repairedReason,
          rootKey,
          representativeOperationId: representative.id,
        });
      }
      continue;
    }

    for (const operation of ordered) {
      if (operation.id === representative.id) {
        resolutions.set(operation.id, {
          state: "ACTIVE",
          reason: buildActiveReason(operation),
          rootKey,
          representativeOperationId: representative.id,
        });
        continue;
      }

      resolutions.set(operation.id, {
        state: "SUPERSEDED",
        reason: buildSupersededReason(representative.id),
        rootKey,
        representativeOperationId: representative.id,
      });
    }
  }

  return resolutions;
}

export async function getFailedXeroOperationOverview(options?: {
  limit?: number;
}): Promise<XeroFailedOperationOverview> {
  const failedOperations = await prisma.xeroSyncOperation.findMany({
    where: {
      status: "FAILED",
    },
    orderBy: {
      createdAt: "desc",
    },
    take: Math.min(Math.max(options?.limit ?? 500, 1), 1000),
  });

  const resolutions = await resolveFailedXeroOperationStates(failedOperations);
  const activeOperations = failedOperations.filter(
    (operation) => resolutions.get(operation.id)?.state === "ACTIVE"
  );

  return {
    totalFailedRows: failedOperations.length,
    activeFailedCount: activeOperations.length,
    legacyFailedCount: Math.max(failedOperations.length - activeOperations.length, 0),
    activeOperations,
    resolutions,
  };
}
