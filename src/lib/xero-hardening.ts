import type { XeroSyncOperation } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import logger from "@/lib/logger";
import {
  sendAdminXeroReconciliationReportAlert,
  sendAdminXeroRepeatedFailureAlert,
} from "@/lib/email";
import { buildXeroObjectUrl } from "@/lib/xero-links";
import { buildLocalAdminUrl } from "@/lib/xero-record-links";
import { getXeroOperationRetryMeta } from "@/lib/xero-operation-retry";

const XERO_REQUEUE_OPERATION_TYPE = "REQUEUE";
const XERO_BACKFILL_OPERATION_TYPE = "BACKFILL_LINK";
const DEFAULT_REPEATED_FAILURE_THRESHOLD = 3;
const DEFAULT_REPEATED_FAILURE_WINDOW_HOURS = 24;
const DEFAULT_STALE_PENDING_MINUTES = 30;
const DEFAULT_REPORT_LOOKBACK_HOURS = 24;
const DEFAULT_REPEATED_FAILURE_TOP_LIMIT = 5;

type FailureAlertOperation = Pick<
  XeroSyncOperation,
  | "id"
  | "correlationKey"
  | "entityType"
  | "operationType"
  | "localModel"
  | "localId"
  | "lastErrorMessage"
  | "xeroObjectType"
  | "xeroObjectId"
  | "xeroObjectUrl"
>;

type FailureSummaryOperation = Pick<
  XeroSyncOperation,
  | "id"
  | "direction"
  | "correlationKey"
  | "entityType"
  | "operationType"
  | "localModel"
  | "localId"
  | "lastErrorMessage"
  | "replayable"
  | "requestPayload"
  | "responsePayload"
  | "status"
  | "xeroObjectId"
  | "createdAt"
>;

interface CanonicalLinkTarget {
  localModel: string;
  localId: string;
  xeroObjectType: string;
  xeroObjectId: string;
  xeroObjectNumber?: string | null;
  xeroObjectUrl?: string | null;
  role: string;
  metadata?: unknown;
  sourceField: string;
}

interface CanonicalLinkExpectation {
  localModel: string;
  localId: string;
  role: string;
  xeroObjectType: string;
  xeroObjectId: string;
}

type CanonicalLinkRecord = Pick<
  CanonicalLinkExpectation,
  "localModel" | "localId" | "role" | "xeroObjectType" | "xeroObjectId"
>;

export interface XeroRepeatedFailureSummary {
  correlationKey: string;
  failureCount: number;
  entityType: string;
  operationType: string;
  localModel: string | null;
  localId: string | null;
  localUrl: string | null;
  latestErrorMessage: string | null;
  latestOperationId: string;
}

export interface XeroUnsupportedPartialSummary {
  operationId: string;
  entityType: string;
  operationType: string;
  localModel: string | null;
  localId: string | null;
  localUrl: string | null;
  reason: string;
  createdAt: Date;
}

export interface XeroReconciliationReport {
  generatedAt: Date;
  lookbackHours: number;
  stalePendingMinutes: number;
  summary: {
    missingMemberContactLinks: number;
    missingPaymentInvoiceLinks: number;
    missingPaymentRefundCreditNoteLinks: number;
    missingSubscriptionInvoiceLinks: number;
    mismatchedCanonicalLinks: number;
    staleCanonicalLinks: number;
    duplicateActiveCanonicalLinks: number;
    stalePendingOperations: number;
    recentFailedOperations: number;
    recentPartialOperations: number;
    unsupportedPartialOperations: number;
    repeatedFailureCorrelations: number;
    issueCategoryCount: number;
    issueTotalCount: number;
  };
  repeatedFailures: XeroRepeatedFailureSummary[];
  unsupportedPartials: XeroUnsupportedPartialSummary[];
}

export interface XeroLinkBackfillCategoryResult {
  scanned: number;
  existingLinks: number;
  createdLinks: number;
  existingOperations: number;
  createdOperations: number;
}

export interface XeroHistoricalBackfillResult {
  completedAt: Date;
  members: XeroLinkBackfillCategoryResult;
  paymentInvoices: XeroLinkBackfillCategoryResult;
  paymentRefundCreditNotes: XeroLinkBackfillCategoryResult;
  subscriptionInvoices: XeroLinkBackfillCategoryResult;
  totals: {
    scanned: number;
    createdLinks: number;
    createdOperations: number;
  };
}

function getRepeatedFailureWindowStart(now: Date, windowHours: number) {
  return new Date(now.getTime() - windowHours * 60 * 60 * 1000);
}

function getStalePendingCutoff(now: Date, stalePendingMinutes: number) {
  return new Date(now.getTime() - stalePendingMinutes * 60 * 1000);
}

function getRepeatedFailureAlertSubject(correlationKey: string) {
  return `Repeated Xero Failure: ${correlationKey}`;
}

function buildBackfillCorrelationKey(target: CanonicalLinkTarget) {
  return [
    "xero-backfill",
    target.localModel,
    target.localId,
    target.role,
    target.xeroObjectType,
    target.xeroObjectId,
  ].join(":");
}

function buildLinkKey(target: {
  localModel: string;
  localId: string;
  xeroObjectType: string;
  xeroObjectId: string;
  role: string;
}) {
  return [
    target.localModel,
    target.localId,
    target.xeroObjectType,
    target.xeroObjectId,
    target.role,
  ].join(":");
}

function buildCanonicalScopeKey(target: {
  localModel: string;
  localId: string;
  role: string;
}) {
  return [target.localModel, target.localId, target.role].join(":");
}

function buildCanonicalMatchKey(target: CanonicalLinkRecord) {
  return [
    target.localModel,
    target.localId,
    target.role,
    target.xeroObjectType,
    target.xeroObjectId,
  ].join(":");
}

function buildBackfillOperationData(target: CanonicalLinkTarget, now: Date) {
  const correlationKey = buildBackfillCorrelationKey(target);

  return {
    direction: "OUTBOUND",
    entityType: target.xeroObjectType,
    operationType: XERO_BACKFILL_OPERATION_TYPE,
    localModel: target.localModel,
    localId: target.localId,
    status: "SUCCEEDED",
    idempotencyKey: correlationKey,
    correlationKey,
    attemptCount: 1,
    replayable: false,
    requestPayload: {
      source: "historical-canonical-xero-id-backfill",
      sourceField: target.sourceField,
      role: target.role,
    },
    responsePayload: {
      backfilled: true,
    },
    xeroObjectType: target.xeroObjectType,
    xeroObjectId: target.xeroObjectId,
    xeroObjectNumber: target.xeroObjectNumber ?? null,
    xeroObjectUrl:
      target.xeroObjectUrl ??
      buildXeroObjectUrl(target.xeroObjectType, target.xeroObjectId),
    createdByMemberId: null,
    startedAt: now,
    completedAt: now,
    createdAt: now,
    updatedAt: now,
  };
}

function groupRepeatedFailures(
  operations: FailureSummaryOperation[]
): XeroRepeatedFailureSummary[] {
  const grouped = new Map<string, XeroRepeatedFailureSummary>();

  for (const operation of operations) {
    if (!operation.correlationKey) {
      continue;
    }

    const existing = grouped.get(operation.correlationKey);
    if (!existing) {
      grouped.set(operation.correlationKey, {
        correlationKey: operation.correlationKey,
        failureCount: 1,
        entityType: operation.entityType,
        operationType: operation.operationType,
        localModel: operation.localModel ?? null,
        localId: operation.localId ?? null,
        localUrl: buildLocalAdminUrl(operation.localModel, operation.localId),
        latestErrorMessage: operation.lastErrorMessage ?? null,
        latestOperationId: operation.id,
      });
      continue;
    }

    existing.failureCount += 1;
  }

  return Array.from(grouped.values()).sort((left, right) => {
    if (right.failureCount !== left.failureCount) {
      return right.failureCount - left.failureCount;
    }

    return left.correlationKey.localeCompare(right.correlationKey);
  });
}

async function backfillCanonicalLinkTargets(
  targets: CanonicalLinkTarget[]
): Promise<XeroLinkBackfillCategoryResult> {
  if (targets.length === 0) {
    return {
      scanned: 0,
      existingLinks: 0,
      createdLinks: 0,
      existingOperations: 0,
      createdOperations: 0,
    };
  }

  const existingLinks = await prisma.xeroObjectLink.findMany({
    where: {
      OR: targets.map((target) => ({
        localModel: target.localModel,
        localId: target.localId,
        xeroObjectType: target.xeroObjectType,
        xeroObjectId: target.xeroObjectId,
        role: target.role,
      })),
    },
    select: {
      localModel: true,
      localId: true,
      xeroObjectType: true,
      xeroObjectId: true,
      role: true,
    },
  });
  const existingLinkKeys = new Set(existingLinks.map(buildLinkKey));
  const linksToCreate = targets.filter(
    (target) => !existingLinkKeys.has(buildLinkKey(target))
  );

  const backfillOperationKeys = targets.map(buildBackfillCorrelationKey);
  const existingOperations = await prisma.xeroSyncOperation.findMany({
    where: {
      operationType: XERO_BACKFILL_OPERATION_TYPE,
      correlationKey: { in: backfillOperationKeys },
    },
    select: {
      correlationKey: true,
    },
  });
  const existingOperationKeys = new Set(
    existingOperations
      .map((operation) => operation.correlationKey)
      .filter((value): value is string => Boolean(value))
  );
  const now = new Date();
  const operationsToCreate = targets
    .filter((target) => !existingOperationKeys.has(buildBackfillCorrelationKey(target)))
    .map((target) => buildBackfillOperationData(target, now));

  const createdLinks =
    linksToCreate.length > 0
      ? (
          await prisma.xeroObjectLink.createMany({
            data: linksToCreate.map((target) => ({
              localModel: target.localModel,
              localId: target.localId,
              xeroObjectType: target.xeroObjectType,
              xeroObjectId: target.xeroObjectId,
              xeroObjectNumber: target.xeroObjectNumber ?? null,
              xeroObjectUrl:
                target.xeroObjectUrl ??
                buildXeroObjectUrl(target.xeroObjectType, target.xeroObjectId),
              role: target.role,
              active: true,
              metadata: target.metadata ?? undefined,
            })),
            skipDuplicates: true,
          })
        ).count
      : 0;

  const createdOperations =
    operationsToCreate.length > 0
      ? (
          await prisma.xeroSyncOperation.createMany({
            data: operationsToCreate,
            skipDuplicates: true,
          })
        ).count
      : 0;

  return {
    scanned: targets.length,
    existingLinks: targets.length - linksToCreate.length,
    createdLinks,
    existingOperations: targets.length - operationsToCreate.length,
    createdOperations,
  };
}

export async function maybeNotifyXeroRepeatedFailure(
  operation: FailureAlertOperation,
  options?: {
    threshold?: number;
    windowHours?: number;
  }
): Promise<{ triggered: boolean; failureCount: number }> {
  if (!operation.correlationKey || operation.operationType === XERO_REQUEUE_OPERATION_TYPE) {
    return { triggered: false, failureCount: 0 };
  }

  const threshold = options?.threshold ?? DEFAULT_REPEATED_FAILURE_THRESHOLD;
  const windowHours = options?.windowHours ?? DEFAULT_REPEATED_FAILURE_WINDOW_HOURS;
  const now = new Date();
  const windowStart = getRepeatedFailureWindowStart(now, windowHours);

  const failureCount = await prisma.xeroSyncOperation.count({
    where: {
      correlationKey: operation.correlationKey,
      operationType: {
        not: XERO_REQUEUE_OPERATION_TYPE,
      },
      status: {
        in: ["FAILED", "PARTIAL"],
      },
      createdAt: {
        gte: windowStart,
      },
    },
  });

  if (failureCount < threshold) {
    return { triggered: false, failureCount };
  }

  const subject = getRepeatedFailureAlertSubject(operation.correlationKey);
  const recentAlert = await prisma.emailLog.findFirst({
    where: {
      templateName: "admin-xero-repeated-failure",
      subject,
      createdAt: {
        gte: windowStart,
      },
      status: {
        in: ["QUEUED", "SENT"],
      },
    },
  });

  if (recentAlert) {
    return { triggered: false, failureCount };
  }

  try {
    await sendAdminXeroRepeatedFailureAlert({
      subject,
      correlationKey: operation.correlationKey,
      failureCount,
      windowHours,
      entityType: operation.entityType,
      operationType: operation.operationType,
      localModel: operation.localModel ?? null,
      localId: operation.localId ?? null,
      localUrl: buildLocalAdminUrl(operation.localModel, operation.localId),
      xeroObjectUrl:
        operation.xeroObjectUrl ??
        (operation.xeroObjectType && operation.xeroObjectId
          ? buildXeroObjectUrl(operation.xeroObjectType, operation.xeroObjectId)
          : null),
      latestErrorMessage: operation.lastErrorMessage ?? null,
      timestamp: now,
    });
    return { triggered: true, failureCount };
  } catch (error) {
    logger.error(
      {
        err: error,
        correlationKey: operation.correlationKey,
        operationId: operation.id,
      },
      "Failed to send repeated Xero failure alert"
    );
    return { triggered: false, failureCount };
  }
}

export async function buildXeroReconciliationReport(options?: {
  lookbackHours?: number;
  stalePendingMinutes?: number;
  repeatedFailureThreshold?: number;
  topLimit?: number;
  now?: Date;
}): Promise<XeroReconciliationReport> {
  const now = options?.now ?? new Date();
  const lookbackHours = options?.lookbackHours ?? DEFAULT_REPORT_LOOKBACK_HOURS;
  const stalePendingMinutes =
    options?.stalePendingMinutes ?? DEFAULT_STALE_PENDING_MINUTES;
  const repeatedFailureThreshold =
    options?.repeatedFailureThreshold ?? DEFAULT_REPEATED_FAILURE_THRESHOLD;
  const topLimit = options?.topLimit ?? DEFAULT_REPEATED_FAILURE_TOP_LIMIT;
  const lookbackStart = getRepeatedFailureWindowStart(now, lookbackHours);
  const stalePendingCutoff = getStalePendingCutoff(now, stalePendingMinutes);

  const [
    members,
    payments,
    subscriptions,
    links,
    recentFailureOperations,
    stalePendingOperations,
  ] = await Promise.all([
    prisma.member.findMany({
      where: {
        xeroContactId: {
          not: null,
        },
      },
      select: {
        id: true,
        xeroContactId: true,
      },
    }),
    prisma.payment.findMany({
      where: {
        OR: [
          {
            xeroInvoiceId: {
              not: null,
            },
          },
          {
            xeroRefundCreditNoteId: {
              not: null,
            },
          },
        ],
      },
      select: {
        id: true,
        xeroInvoiceId: true,
        xeroRefundCreditNoteId: true,
      },
    }),
    prisma.memberSubscription.findMany({
      where: {
        xeroInvoiceId: {
          not: null,
        },
      },
      select: {
        id: true,
        xeroInvoiceId: true,
      },
    }),
    prisma.xeroObjectLink.findMany({
      where: {
        active: true,
        OR: [
          {
            localModel: "Member",
            role: "CONTACT",
          },
          {
            localModel: "Payment",
            role: {
              in: ["PRIMARY_INVOICE", "REFUND_CREDIT_NOTE"],
            },
          },
          {
            localModel: "MemberSubscription",
            role: "SUBSCRIPTION_INVOICE",
          },
        ],
      },
      select: {
        localModel: true,
        localId: true,
        xeroObjectType: true,
        xeroObjectId: true,
        role: true,
      },
    }),
    prisma.xeroSyncOperation.findMany({
      where: {
        createdAt: {
          gte: lookbackStart,
        },
        operationType: {
          not: XERO_REQUEUE_OPERATION_TYPE,
        },
        status: {
          in: ["FAILED", "PARTIAL"],
        },
      },
      orderBy: {
        createdAt: "desc",
      },
      select: {
        id: true,
        direction: true,
        correlationKey: true,
        entityType: true,
        operationType: true,
        localModel: true,
        localId: true,
        lastErrorMessage: true,
        replayable: true,
        requestPayload: true,
        responsePayload: true,
        status: true,
        xeroObjectId: true,
        createdAt: true,
      },
    }),
    prisma.xeroSyncOperation.count({
      where: {
        OR: [
          {
            status: "PENDING",
            createdAt: {
              lt: stalePendingCutoff,
            },
          },
          {
            status: "RUNNING",
            startedAt: {
              not: null,
              lt: stalePendingCutoff,
            },
          },
        ],
      },
    }),
  ]);

  const canonicalExpectations: CanonicalLinkExpectation[] = [
    ...members.flatMap((member) =>
      member.xeroContactId
        ? [
            {
              localModel: "Member",
              localId: member.id,
              role: "CONTACT",
              xeroObjectType: "CONTACT",
              xeroObjectId: member.xeroContactId,
            },
          ]
        : []
    ),
    ...payments.flatMap((payment) =>
      [
        payment.xeroInvoiceId
          ? {
              localModel: "Payment",
              localId: payment.id,
              role: "PRIMARY_INVOICE",
              xeroObjectType: "INVOICE",
              xeroObjectId: payment.xeroInvoiceId,
            }
          : null,
        payment.xeroRefundCreditNoteId
          ? {
              localModel: "Payment",
              localId: payment.id,
              role: "REFUND_CREDIT_NOTE",
              xeroObjectType: "CREDIT_NOTE",
              xeroObjectId: payment.xeroRefundCreditNoteId,
            }
          : null,
      ].filter((value): value is CanonicalLinkExpectation => value !== null)
    ),
    ...subscriptions.flatMap((subscription) =>
      subscription.xeroInvoiceId
        ? [
            {
              localModel: "MemberSubscription",
              localId: subscription.id,
              role: "SUBSCRIPTION_INVOICE",
              xeroObjectType: "SUBSCRIPTION",
              xeroObjectId: subscription.xeroInvoiceId,
            },
          ]
        : []
    ),
  ];

  const exactCanonicalLinkKeys = new Set(
    links.map((link) =>
      buildCanonicalMatchKey({
        localModel: link.localModel,
        localId: link.localId,
        role: link.role,
        xeroObjectType: link.xeroObjectType,
        xeroObjectId: link.xeroObjectId,
      })
    )
  );
  const canonicalExpectationByScope = new Map(
    canonicalExpectations.map((expectation) => [
      buildCanonicalScopeKey(expectation),
      expectation,
    ])
  );
  const activeLinksByScope = new Map<string, CanonicalLinkRecord[]>();

  for (const link of links) {
    const scopeKey = buildCanonicalScopeKey(link);
    const scopedLinks = activeLinksByScope.get(scopeKey) ?? [];
    scopedLinks.push(link);
    activeLinksByScope.set(scopeKey, scopedLinks);
  }

  const missingMemberContactLinks = members.filter(
    (member) =>
      member.xeroContactId &&
      !exactCanonicalLinkKeys.has(
        buildCanonicalMatchKey({
          localModel: "Member",
          localId: member.id,
          role: "CONTACT",
          xeroObjectType: "CONTACT",
          xeroObjectId: member.xeroContactId,
        })
      )
  ).length;

  const missingPaymentInvoiceLinks = payments.filter(
    (payment) =>
      payment.xeroInvoiceId &&
      !exactCanonicalLinkKeys.has(
        buildCanonicalMatchKey({
          localModel: "Payment",
          localId: payment.id,
          role: "PRIMARY_INVOICE",
          xeroObjectType: "INVOICE",
          xeroObjectId: payment.xeroInvoiceId,
        })
      )
  ).length;

  const missingPaymentRefundCreditNoteLinks = payments.filter(
    (payment) =>
      payment.xeroRefundCreditNoteId &&
      !exactCanonicalLinkKeys.has(
        buildCanonicalMatchKey({
          localModel: "Payment",
          localId: payment.id,
          role: "REFUND_CREDIT_NOTE",
          xeroObjectType: "CREDIT_NOTE",
          xeroObjectId: payment.xeroRefundCreditNoteId,
        })
      )
  ).length;

  const missingSubscriptionInvoiceLinks = subscriptions.filter(
    (subscription) =>
      subscription.xeroInvoiceId &&
      !exactCanonicalLinkKeys.has(
        buildCanonicalMatchKey({
          localModel: "MemberSubscription",
          localId: subscription.id,
          role: "SUBSCRIPTION_INVOICE",
          xeroObjectType: "SUBSCRIPTION",
          xeroObjectId: subscription.xeroInvoiceId,
        })
      )
  ).length;

  const mismatchedCanonicalLinks = canonicalExpectations.filter((expectation) => {
    const scopeKey = buildCanonicalScopeKey(expectation);
    const scopedLinks = activeLinksByScope.get(scopeKey) ?? [];
    return (
      scopedLinks.length > 0 &&
      !exactCanonicalLinkKeys.has(buildCanonicalMatchKey(expectation))
    );
  }).length;

  const staleCanonicalLinks = links.filter((link) => {
    const expectation = canonicalExpectationByScope.get(buildCanonicalScopeKey(link));
    if (!expectation) {
      return true;
    }

    return (
      expectation.xeroObjectType !== link.xeroObjectType ||
      expectation.xeroObjectId !== link.xeroObjectId
    );
  }).length;

  const duplicateActiveCanonicalLinks = Array.from(activeLinksByScope.values()).filter(
    (scopedLinks) => scopedLinks.length > 1
  ).length;

  const repeatedFailures = groupRepeatedFailures(recentFailureOperations)
    .filter((group) => group.failureCount >= repeatedFailureThreshold)
    .slice(0, topLimit);

  const recentFailedOperations = recentFailureOperations.filter(
    (operation) => operation.status === "FAILED"
  ).length;
  const recentPartialOperationsList = recentFailureOperations.filter(
    (operation) => operation.status === "PARTIAL"
  );
  const recentPartialOperations = recentPartialOperationsList.length;
  const unsupportedPartialOperationsList = recentPartialOperationsList
    .flatMap((operation) => {
      const retryMeta = getXeroOperationRetryMeta(operation);
      if (retryMeta.supported) {
        return [];
      }

      return [
        {
          operationId: operation.id,
          entityType: operation.entityType,
          operationType: operation.operationType,
          localModel: operation.localModel ?? null,
          localId: operation.localId ?? null,
          localUrl: buildLocalAdminUrl(operation.localModel, operation.localId),
          reason:
            retryMeta.reason ?? "This partial Xero operation does not have a repair handler yet.",
          createdAt: operation.createdAt,
        },
      ];
    });
  const unsupportedPartialOperations = unsupportedPartialOperationsList.length;
  const unsupportedPartials = unsupportedPartialOperationsList.slice(0, topLimit);

  const issueCounts = [
    missingMemberContactLinks,
    missingPaymentInvoiceLinks,
    missingPaymentRefundCreditNoteLinks,
    missingSubscriptionInvoiceLinks,
    mismatchedCanonicalLinks,
    staleCanonicalLinks,
    duplicateActiveCanonicalLinks,
    stalePendingOperations,
    recentFailedOperations,
    recentPartialOperations,
    unsupportedPartialOperations,
    repeatedFailures.length,
  ];

  return {
    generatedAt: now,
    lookbackHours,
    stalePendingMinutes,
    summary: {
      missingMemberContactLinks,
      missingPaymentInvoiceLinks,
      missingPaymentRefundCreditNoteLinks,
      missingSubscriptionInvoiceLinks,
      mismatchedCanonicalLinks,
      staleCanonicalLinks,
      duplicateActiveCanonicalLinks,
      stalePendingOperations,
      recentFailedOperations,
      recentPartialOperations,
      unsupportedPartialOperations,
      repeatedFailureCorrelations: repeatedFailures.length,
      issueCategoryCount: issueCounts.filter((count) => count > 0).length,
      issueTotalCount: issueCounts.reduce((sum, count) => sum + count, 0),
    },
    repeatedFailures,
    unsupportedPartials,
  };
}

export async function sendXeroReconciliationReport(options?: {
  lookbackHours?: number;
  stalePendingMinutes?: number;
  repeatedFailureThreshold?: number;
  topLimit?: number;
  now?: Date;
}) {
  const report = await buildXeroReconciliationReport(options);

  try {
    await sendAdminXeroReconciliationReportAlert(report);
    return {
      sent: true,
      report,
    };
  } catch (error) {
    logger.error({ err: error }, "Failed to send Xero reconciliation report");
    return {
      sent: false,
      report,
    };
  }
}

export async function backfillHistoricalXeroObjectLinks(): Promise<XeroHistoricalBackfillResult> {
  const [members, payments, subscriptions] = await Promise.all([
    prisma.member.findMany({
      where: {
        xeroContactId: {
          not: null,
        },
      },
      select: {
        id: true,
        xeroContactId: true,
      },
    }),
    prisma.payment.findMany({
      where: {
        OR: [
          {
            xeroInvoiceId: {
              not: null,
            },
          },
          {
            xeroRefundCreditNoteId: {
              not: null,
            },
          },
        ],
      },
      select: {
        id: true,
        xeroInvoiceId: true,
        xeroInvoiceNumber: true,
        xeroRefundCreditNoteId: true,
      },
    }),
    prisma.memberSubscription.findMany({
      where: {
        xeroInvoiceId: {
          not: null,
        },
      },
      select: {
        id: true,
        seasonYear: true,
        xeroInvoiceId: true,
        xeroInvoiceNumber: true,
        xeroOnlineInvoiceUrl: true,
      },
    }),
  ]);

  const memberResult = await backfillCanonicalLinkTargets(
    members.flatMap((member) =>
      member.xeroContactId
        ? [
            {
              localModel: "Member",
              localId: member.id,
              xeroObjectType: "CONTACT",
              xeroObjectId: member.xeroContactId,
              role: "CONTACT",
              sourceField: "Member.xeroContactId",
            },
          ]
        : []
    )
  );

  const paymentInvoiceResult = await backfillCanonicalLinkTargets(
    payments.flatMap((payment) =>
      payment.xeroInvoiceId
        ? [
            {
              localModel: "Payment",
              localId: payment.id,
              xeroObjectType: "INVOICE",
              xeroObjectId: payment.xeroInvoiceId,
              xeroObjectNumber: payment.xeroInvoiceNumber ?? null,
              role: "PRIMARY_INVOICE",
              sourceField: "Payment.xeroInvoiceId",
            },
          ]
        : []
    )
  );

  const paymentRefundResult = await backfillCanonicalLinkTargets(
    payments.flatMap((payment) =>
      payment.xeroRefundCreditNoteId
        ? [
            {
              localModel: "Payment",
              localId: payment.id,
              xeroObjectType: "CREDIT_NOTE",
              xeroObjectId: payment.xeroRefundCreditNoteId,
              role: "REFUND_CREDIT_NOTE",
              sourceField: "Payment.xeroRefundCreditNoteId",
            },
          ]
        : []
    )
  );

  const subscriptionResult = await backfillCanonicalLinkTargets(
    subscriptions.flatMap((subscription) =>
      subscription.xeroInvoiceId
        ? [
            {
              localModel: "MemberSubscription",
              localId: subscription.id,
              xeroObjectType: "SUBSCRIPTION",
              xeroObjectId: subscription.xeroInvoiceId,
              xeroObjectNumber: subscription.xeroInvoiceNumber ?? null,
              xeroObjectUrl:
                buildXeroObjectUrl("SUBSCRIPTION", subscription.xeroInvoiceId) ?? null,
              role: "SUBSCRIPTION_INVOICE",
              metadata: {
                seasonYear: subscription.seasonYear,
                onlineInvoiceUrl: subscription.xeroOnlineInvoiceUrl ?? null,
              },
              sourceField: "MemberSubscription.xeroInvoiceId",
            },
          ]
        : []
    )
  );

  return {
    completedAt: new Date(),
    members: memberResult,
    paymentInvoices: paymentInvoiceResult,
    paymentRefundCreditNotes: paymentRefundResult,
    subscriptionInvoices: subscriptionResult,
    totals: {
      scanned:
        memberResult.scanned +
        paymentInvoiceResult.scanned +
        paymentRefundResult.scanned +
        subscriptionResult.scanned,
      createdLinks:
        memberResult.createdLinks +
        paymentInvoiceResult.createdLinks +
        paymentRefundResult.createdLinks +
        subscriptionResult.createdLinks,
      createdOperations:
        memberResult.createdOperations +
        paymentInvoiceResult.createdOperations +
        paymentRefundResult.createdOperations +
        subscriptionResult.createdOperations,
    },
  };
}
