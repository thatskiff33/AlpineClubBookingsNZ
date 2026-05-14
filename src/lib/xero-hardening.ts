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
  | "xeroObjectType"
  | "xeroObjectId"
  | "xeroObjectNumber"
  | "xeroObjectUrl"
  | "startedAt"
  | "createdAt"
>;

type StaleOperationSummary = Pick<
  XeroSyncOperation,
  | "id"
  | "direction"
  | "correlationKey"
  | "entityType"
  | "operationType"
  | "localModel"
  | "localId"
  | "status"
  | "lastErrorMessage"
  | "xeroObjectType"
  | "xeroObjectId"
  | "xeroObjectNumber"
  | "xeroObjectUrl"
  | "startedAt"
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
  latestOperationStatus: string;
  latestOperationCreatedAt: Date;
  xeroObjectType: string | null;
  xeroObjectId: string | null;
  xeroObjectNumber: string | null;
  xeroObjectUrl: string | null;
}

export interface XeroUnsupportedPartialSummary {
  operationId: string;
  entityType: string;
  operationType: string;
  localModel: string | null;
  localId: string | null;
  localUrl: string | null;
  xeroObjectType: string | null;
  xeroObjectId: string | null;
  xeroObjectNumber: string | null;
  xeroObjectUrl: string | null;
  reason: string;
  createdAt: Date;
}

export type XeroReconciliationIssueSeverity = "critical" | "warning" | "info";

export interface XeroReconciliationIssueItem {
  label: string;
  localModel: string | null;
  localId: string | null;
  localUrl: string | null;
  xeroObjectType: string | null;
  xeroObjectId: string | null;
  xeroObjectNumber: string | null;
  xeroObjectUrl: string | null;
  operationId: string | null;
  operationStatus: string | null;
  operationType: string | null;
  correlationKey: string | null;
  detail: string | null;
  latestErrorMessage: string | null;
  createdAt: Date | null;
}

export interface XeroReconciliationIssueSection {
  id: string;
  title: string;
  severity: XeroReconciliationIssueSeverity;
  count: number;
  whatWentWrong: string;
  howToFix: string;
  items: XeroReconciliationIssueItem[];
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
  issueSections: XeroReconciliationIssueSection[];
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

function buildRecordLabel(localModel: string | null, localId: string | null) {
  if (!localModel || !localId) {
    return "Unscoped Xero operation";
  }

  return `${localModel} ${localId}`;
}

function buildReportXeroUrl(
  xeroObjectType: string | null,
  xeroObjectId: string | null,
  xeroObjectUrl?: string | null
) {
  return xeroObjectUrl ?? (
    xeroObjectType && xeroObjectId
      ? buildXeroObjectUrl(xeroObjectType, xeroObjectId)
      : null
  );
}

function buildCanonicalIssueItem(
  expectation: CanonicalLinkExpectation,
  detail: string
): XeroReconciliationIssueItem {
  return {
    label: buildRecordLabel(expectation.localModel, expectation.localId),
    localModel: expectation.localModel,
    localId: expectation.localId,
    localUrl: buildLocalAdminUrl(expectation.localModel, expectation.localId),
    xeroObjectType: expectation.xeroObjectType,
    xeroObjectId: expectation.xeroObjectId,
    xeroObjectNumber: null,
    xeroObjectUrl: buildReportXeroUrl(expectation.xeroObjectType, expectation.xeroObjectId),
    operationId: null,
    operationStatus: null,
    operationType: null,
    correlationKey: null,
    detail,
    latestErrorMessage: null,
    createdAt: null,
  };
}

function buildCanonicalLinkIssueItem(
  link: CanonicalLinkRecord,
  detail: string
): XeroReconciliationIssueItem {
  return {
    label: buildRecordLabel(link.localModel, link.localId),
    localModel: link.localModel,
    localId: link.localId,
    localUrl: buildLocalAdminUrl(link.localModel, link.localId),
    xeroObjectType: link.xeroObjectType,
    xeroObjectId: link.xeroObjectId,
    xeroObjectNumber: null,
    xeroObjectUrl: buildReportXeroUrl(link.xeroObjectType, link.xeroObjectId),
    operationId: null,
    operationStatus: null,
    operationType: null,
    correlationKey: null,
    detail,
    latestErrorMessage: null,
    createdAt: null,
  };
}

function buildOperationIssueItem(
  operation: FailureSummaryOperation | StaleOperationSummary,
  detail: string | null
): XeroReconciliationIssueItem {
  return {
    label: buildRecordLabel(operation.localModel, operation.localId),
    localModel: operation.localModel ?? null,
    localId: operation.localId ?? null,
    localUrl: buildLocalAdminUrl(operation.localModel, operation.localId),
    xeroObjectType: operation.xeroObjectType ?? null,
    xeroObjectId: operation.xeroObjectId ?? null,
    xeroObjectNumber: operation.xeroObjectNumber ?? null,
    xeroObjectUrl: buildReportXeroUrl(
      operation.xeroObjectType ?? null,
      operation.xeroObjectId ?? null,
      operation.xeroObjectUrl ?? null
    ),
    operationId: operation.id,
    operationStatus: operation.status,
    operationType: `${operation.entityType} ${operation.operationType}`,
    correlationKey: operation.correlationKey ?? null,
    detail,
    latestErrorMessage: operation.lastErrorMessage ?? null,
    createdAt: operation.createdAt,
  };
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
        latestOperationStatus: operation.status,
        latestOperationCreatedAt: operation.createdAt,
        xeroObjectType: operation.xeroObjectType ?? null,
        xeroObjectId: operation.xeroObjectId ?? null,
        xeroObjectNumber: operation.xeroObjectNumber ?? null,
        xeroObjectUrl: buildReportXeroUrl(
          operation.xeroObjectType ?? null,
          operation.xeroObjectId ?? null,
          operation.xeroObjectUrl ?? null
        ),
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
  const stalePendingWhere = {
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
  };

  const [
    members,
    payments,
    subscriptions,
    links,
    recentFailureOperations,
    stalePendingOperations,
    stalePendingOperationExamples,
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
        xeroObjectType: true,
        xeroObjectId: true,
        xeroObjectNumber: true,
        xeroObjectUrl: true,
        startedAt: true,
        createdAt: true,
      },
    }),
    prisma.xeroSyncOperation.count({
      where: stalePendingWhere,
    }),
    prisma.xeroSyncOperation.findMany({
      where: stalePendingWhere,
      orderBy: {
        createdAt: "asc",
      },
      take: topLimit,
      select: {
        id: true,
        direction: true,
        correlationKey: true,
        entityType: true,
        operationType: true,
        localModel: true,
        localId: true,
        status: true,
        lastErrorMessage: true,
        xeroObjectType: true,
        xeroObjectId: true,
        xeroObjectNumber: true,
        xeroObjectUrl: true,
        startedAt: true,
        createdAt: true,
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

  const missingCanonicalExpectations = canonicalExpectations.filter(
    (expectation) => !exactCanonicalLinkKeys.has(buildCanonicalMatchKey(expectation))
  );

  const missingMemberContactLinks = missingCanonicalExpectations.filter(
    (expectation) =>
      expectation.localModel === "Member" && expectation.role === "CONTACT"
  ).length;

  const missingPaymentInvoiceLinks = missingCanonicalExpectations.filter(
    (expectation) =>
      expectation.localModel === "Payment" && expectation.role === "PRIMARY_INVOICE"
  ).length;

  const missingPaymentRefundCreditNoteLinks = missingCanonicalExpectations.filter(
    (expectation) =>
      expectation.localModel === "Payment" && expectation.role === "REFUND_CREDIT_NOTE"
  ).length;

  const missingSubscriptionInvoiceLinks = missingCanonicalExpectations.filter(
    (expectation) =>
      expectation.localModel === "MemberSubscription" &&
      expectation.role === "SUBSCRIPTION_INVOICE"
  ).length;

  const mismatchedCanonicalExpectations = canonicalExpectations.filter((expectation) => {
    const scopeKey = buildCanonicalScopeKey(expectation);
    const scopedLinks = activeLinksByScope.get(scopeKey) ?? [];
    return (
      scopedLinks.length > 0 &&
      !exactCanonicalLinkKeys.has(buildCanonicalMatchKey(expectation))
    );
  });
  const mismatchedCanonicalLinks = mismatchedCanonicalExpectations.length;

  const staleCanonicalLinkRecords = links.filter((link) => {
    const expectation = canonicalExpectationByScope.get(buildCanonicalScopeKey(link));
    if (!expectation) {
      return true;
    }

    return (
      expectation.xeroObjectType !== link.xeroObjectType ||
      expectation.xeroObjectId !== link.xeroObjectId
    );
  });
  const staleCanonicalLinks = staleCanonicalLinkRecords.length;

  const duplicateCanonicalLinkGroups = Array.from(activeLinksByScope.values()).filter(
    (scopedLinks) => scopedLinks.length > 1
  );
  const duplicateActiveCanonicalLinks = duplicateCanonicalLinkGroups.length;

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
          xeroObjectType: operation.xeroObjectType ?? null,
          xeroObjectId: operation.xeroObjectId ?? null,
          xeroObjectNumber: operation.xeroObjectNumber ?? null,
          xeroObjectUrl: buildReportXeroUrl(
            operation.xeroObjectType ?? null,
            operation.xeroObjectId ?? null,
            operation.xeroObjectUrl ?? null
          ),
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

  const missingCanonicalItems = missingCanonicalExpectations.map((expectation) =>
    buildCanonicalIssueItem(
      expectation,
      `Expected an active ${expectation.role} link to ${expectation.xeroObjectType} ${expectation.xeroObjectId}, but the Xero ledger link is missing.`
    )
  );
  const mismatchedCanonicalItems = mismatchedCanonicalExpectations.map((expectation) => {
    const scopedLinks = activeLinksByScope.get(buildCanonicalScopeKey(expectation)) ?? [];
    const activeTargets = scopedLinks
      .map((link) => `${link.xeroObjectType} ${link.xeroObjectId}`)
      .join(", ");

    return buildCanonicalIssueItem(
      expectation,
      `Expected ${expectation.xeroObjectType} ${expectation.xeroObjectId}, but the active ledger link points to ${activeTargets || "another object"}.`
    );
  });
  const staleCanonicalItems = staleCanonicalLinkRecords.map((link) => {
    const expectation = canonicalExpectationByScope.get(buildCanonicalScopeKey(link));
    const detail = expectation
      ? `Active ${link.role} link points to ${link.xeroObjectType} ${link.xeroObjectId}, but the local record now expects ${expectation.xeroObjectType} ${expectation.xeroObjectId}.`
      : `Active ${link.role} link points to ${link.xeroObjectType} ${link.xeroObjectId}, but no local canonical field currently expects that link.`;

    return buildCanonicalLinkIssueItem(link, detail);
  });
  const duplicateCanonicalItems = duplicateCanonicalLinkGroups.map((scopedLinks) => {
    const firstLink = scopedLinks[0];
    return buildCanonicalLinkIssueItem(
      firstLink,
      `${scopedLinks.length} active ${firstLink.role} links exist for this record. Only one active canonical link should remain.`
    );
  });
  const canonicalDriftItems = [
    ...mismatchedCanonicalItems,
    ...duplicateCanonicalItems,
    ...staleCanonicalItems,
    ...missingCanonicalItems,
  ].slice(0, topLimit);

  const issueSections: XeroReconciliationIssueSection[] = [
    ...(unsupportedPartialOperations > 0
      ? [
          {
            id: "unsupported-partials",
            title: "Unsupported partial Xero repairs",
            severity: "critical" as const,
            count: unsupportedPartialOperations,
            whatWentWrong:
              "Xero accepted part of an operation, but TACBookings does not currently have enough supported repair logic for this partial state.",
            howToFix:
              "Open the linked record activity, review the stored request/response payloads, and repair the local/Xero state manually before adding or extending a retry handler.",
            items: unsupportedPartials.map((partial) => ({
              label: buildRecordLabel(partial.localModel, partial.localId),
              localModel: partial.localModel,
              localId: partial.localId,
              localUrl: partial.localUrl,
              xeroObjectType: partial.xeroObjectType,
              xeroObjectId: partial.xeroObjectId,
              xeroObjectNumber: partial.xeroObjectNumber,
              xeroObjectUrl: partial.xeroObjectUrl,
              operationId: partial.operationId,
              operationStatus: "PARTIAL",
              operationType: `${partial.entityType} ${partial.operationType}`,
              correlationKey: null,
              detail: partial.reason,
              latestErrorMessage: null,
              createdAt: partial.createdAt,
            })),
          },
        ]
      : []),
    ...(repeatedFailures.length > 0
      ? [
          {
            id: "repeated-failures",
            title: "Repeated Xero operation failures",
            severity: "critical" as const,
            count: repeatedFailures.length,
            whatWentWrong:
              "The same Xero correlation key has failed repeatedly inside the report window, so the normal background retry path is not clearing it.",
            howToFix:
              "Open the linked record activity, check the latest error and payload, then use the authenticated Retry in background control when the record data is correct.",
            items: repeatedFailures.map((failure) => ({
              label: buildRecordLabel(failure.localModel, failure.localId),
              localModel: failure.localModel,
              localId: failure.localId,
              localUrl: failure.localUrl,
              xeroObjectType: failure.xeroObjectType,
              xeroObjectId: failure.xeroObjectId,
              xeroObjectNumber: failure.xeroObjectNumber,
              xeroObjectUrl: failure.xeroObjectUrl,
              operationId: failure.latestOperationId,
              operationStatus: failure.latestOperationStatus,
              operationType: `${failure.entityType} ${failure.operationType}`,
              correlationKey: failure.correlationKey,
              detail: `${failure.failureCount} failures for this correlation key.`,
              latestErrorMessage: failure.latestErrorMessage,
              createdAt: failure.latestOperationCreatedAt,
            })),
          },
        ]
      : []),
    ...(stalePendingOperations > 0
      ? [
          {
            id: "stale-pending-operations",
            title: "Stale pending or running operations",
            severity: "warning" as const,
            count: stalePendingOperations,
            whatWentWrong:
              "Some Xero operations have stayed pending or running beyond the stale-operation threshold.",
            howToFix:
              "Open the linked record activity or the Xero operations list and confirm whether the worker is blocked, then retry or requeue only after checking the operation did not already complete in Xero.",
            items: stalePendingOperationExamples.map((operation) =>
              buildOperationIssueItem(
                operation,
                `Operation has been ${operation.status.toLowerCase()} since ${
                  (operation.startedAt ?? operation.createdAt).toISOString()
                }.`
              )
            ),
          },
        ]
      : []),
    ...(canonicalDriftItems.length > 0
      ? [
          {
            id: "canonical-link-drift",
            title: "Canonical Xero link drift",
            severity: "warning" as const,
            count:
              missingMemberContactLinks +
              missingPaymentInvoiceLinks +
              missingPaymentRefundCreditNoteLinks +
              missingSubscriptionInvoiceLinks +
              mismatchedCanonicalLinks +
              staleCanonicalLinks +
              duplicateActiveCanonicalLinks,
            whatWentWrong:
              "Local records and the durable Xero object-link ledger disagree about which Xero contact, invoice, credit note, or subscription invoice is canonical.",
            howToFix:
              "Open the linked record activity and compare the local record, active Xero links, and external Xero object. Missing links are usually repaired by the nightly backfill; mismatched or duplicate active links need admin review.",
            items: canonicalDriftItems,
          },
        ]
      : []),
    ...(recentFailureOperations.length > 0
      ? [
          {
            id: "recent-failed-partial-operations",
            title: "Recent failed or partial operations",
            severity: "info" as const,
            count: recentFailureOperations.length,
            whatWentWrong:
              "These are the latest failed or partial Xero operations inside the lookback window.",
            howToFix:
              "Use this as supporting context after reviewing the higher-priority sections above. Open the linked record activity to inspect payloads and retry support.",
            items: recentFailureOperations
              .slice(0, topLimit)
              .map((operation) =>
                buildOperationIssueItem(
                  operation,
                  `${operation.status} ${operation.entityType} ${operation.operationType}`
                )
              ),
          },
        ]
      : []),
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
    issueSections,
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
