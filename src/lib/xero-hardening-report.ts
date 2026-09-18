// Xero reconciliation report: builds the admin reconciliation report (canonical
// link drift, stale/failed/partial operations, repeated failures, and the
// #1196 persistently-failing inbound-events section) and sends it under the
// admin system-email delivery policy. Extracted verbatim from xero-hardening.ts
// (#1208 item 5); buildXeroReconciliationReport is kept whole (~610 lines) as
// the single largest function, so this module runs over the ~700-line target by
// design. Import xero source modules directly, never the @/lib/xero facade
// (#1208).
import type { XeroInboundEvent, XeroSyncOperation } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import logger from "@/lib/logger";
import { sendAdminXeroReconciliationReportAlert } from "@/lib/email";
import { shouldSendAdminSystemEmail } from "@/lib/notification-delivery-policies";
import { redactSensitiveText } from "@/lib/redact-sensitive-json";
import { buildXeroObjectUrl } from "@/lib/xero-links";
import { buildLocalAdminUrl } from "@/lib/xero-record-links";
import { getXeroOperationRetryMeta } from "@/lib/xero-operation-retry";
import type {
  CanonicalLinkExpectation,
  CanonicalLinkRecord,
  XeroReconciliationIssueItem,
  XeroReconciliationIssueSection,
  XeroReconciliationReport,
  XeroRepeatedFailureSummary,
} from "./xero-hardening-types";
import {
  DEFAULT_REPEATED_FAILURE_THRESHOLD,
  XERO_REQUEUE_OPERATION_TYPE,
  buildCanonicalScopeKey,
  getRepeatedFailureWindowStart,
} from "./xero-hardening-shared";
import {
  findStripeSourcePaymentIds,
  isStripePerDeltaRefundCreditNoteLink,
} from "./xero-hardening-canonical-links";
import { resolveStripeCashRefundEvidence } from "@/lib/stripe-cash-refund-evidence";
import { isRefundCreditNoteLinkCancelledInXero } from "@/lib/xero-refund-note-status";
import { sumCoveredRefundCreditNoteCents } from "@/lib/xero-sync";

const DEFAULT_STALE_PENDING_MINUTES = 30;

const DEFAULT_REPORT_LOOKBACK_HOURS = 24;

const DEFAULT_REPEATED_FAILURE_TOP_LIMIT = 5;

// Age (not attempt count — the model has no attempt column) that a FAILED
// inbound webhook event must have persisted for before it is treated as
// stuck-forever rather than a transient failure the retry loop will clear.
const DEFAULT_FAILED_INBOUND_MIN_AGE_MINUTES = 60;

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

type FailedInboundEventSummary = Pick<
  XeroInboundEvent,
  | "id"
  | "correlationKey"
  | "eventCategory"
  | "eventType"
  | "resourceId"
  | "errorMessage"
  | "createdAt"
>;

function getStalePendingCutoff(now: Date, stalePendingMinutes: number) {
  return new Date(now.getTime() - stalePendingMinutes * 60 * 1000);
}

function getFailedInboundCutoff(now: Date, minAgeMinutes: number) {
  return new Date(now.getTime() - minAgeMinutes * 60 * 1000);
}

function describeAgeSince(now: Date, createdAt: Date) {
  const totalMinutes = Math.max(
    0,
    Math.round((now.getTime() - createdAt.getTime()) / (60 * 1000))
  );
  if (totalMinutes < 60) {
    return `${totalMinutes} minute${totalMinutes === 1 ? "" : "s"}`;
  }

  const hours = Math.floor(totalMinutes / 60);
  return `${hours} hour${hours === 1 ? "" : "s"}`;
}

function buildInboundEventIssueItem(
  event: FailedInboundEventSummary,
  now: Date
): XeroReconciliationIssueItem {
  const age = describeAgeSince(now, event.createdAt);
  const eventLabel = event.eventCategory
    ? `${event.eventCategory} ${event.eventType}`
    : event.eventType;
  const resourceSuffix = event.resourceId ? ` for resource ${event.resourceId}` : "";

  return {
    label: eventLabel,
    localModel: null,
    localId: null,
    localUrl: null,
    xeroObjectType: null,
    xeroObjectId: null,
    xeroObjectNumber: null,
    xeroObjectUrl: null,
    operationId: event.id,
    operationStatus: "FAILED",
    operationType: eventLabel,
    correlationKey: event.correlationKey,
    detail: `Inbound event has been FAILED for ${age} (since ${event.createdAt.toISOString()})${resourceSuffix}.`,
    latestErrorMessage: event.errorMessage
      ? redactSensitiveText(event.errorMessage)
      : null,
    createdAt: event.createdAt,
  };
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

export async function buildXeroReconciliationReport(options?: {
  lookbackHours?: number;
  stalePendingMinutes?: number;
  repeatedFailureThreshold?: number;
  failedInboundMinAgeMinutes?: number;
  topLimit?: number;
  now?: Date;
}): Promise<XeroReconciliationReport> {
  const now = options?.now ?? new Date();
  const lookbackHours = options?.lookbackHours ?? DEFAULT_REPORT_LOOKBACK_HOURS;
  const stalePendingMinutes =
    options?.stalePendingMinutes ?? DEFAULT_STALE_PENDING_MINUTES;
  const repeatedFailureThreshold =
    options?.repeatedFailureThreshold ?? DEFAULT_REPEATED_FAILURE_THRESHOLD;
  const failedInboundMinAgeMinutes =
    options?.failedInboundMinAgeMinutes ?? DEFAULT_FAILED_INBOUND_MIN_AGE_MINUTES;
  const topLimit = options?.topLimit ?? DEFAULT_REPEATED_FAILURE_TOP_LIMIT;
  const lookbackStart = getRepeatedFailureWindowStart(now, lookbackHours);
  const stalePendingCutoff = getStalePendingCutoff(now, stalePendingMinutes);
  const failedInboundCutoff = getFailedInboundCutoff(now, failedInboundMinAgeMinutes);
  const failedInboundWhere = {
    status: "FAILED",
    createdAt: {
      lt: failedInboundCutoff,
    },
  };
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
    failedInboundEvents,
    failedInboundEventExamples,
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
        // #2901 fix round: the merged inbound status decides whether a Stripe
        // per-delta link mirrors a LIVE note — a VOIDED/DELETED note's mirror
        // is stale drift, never exempt coverage.
        metadata: true,
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
    prisma.xeroInboundEvent.count({
      where: failedInboundWhere,
    }),
    prisma.xeroInboundEvent.findMany({
      where: failedInboundWhere,
      orderBy: {
        createdAt: "asc",
      },
      take: topLimit,
      select: {
        id: true,
        correlationKey: true,
        eventCategory: true,
        eventType: true,
        resourceId: true,
        errorMessage: true,
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

  // #2901: `source: STRIPE` payments hold one active REFUND_CREDIT_NOTE link
  // per refund delta (INV-ADDPAY-020), so for those payments the scalar
  // pointer names the LATEST note, not the ONLY note. The mismatch, stale and
  // duplicate classifications below all assume single-canonical and would
  // report every legitimate per-delta sibling as drift, so they are made
  // source-aware exactly like `cleanupStaleCanonicalXeroObjectLinks`. The
  // "missing" classification is deliberately kept: the scalar-pointed note
  // should always carry an active link, whatever the source.
  const stripePaymentIds = await findStripeSourcePaymentIds(
    Array.from(
      new Set(
        links
          .filter(
            (link) =>
              link.localModel === "Payment" && link.role === "REFUND_CREDIT_NOTE"
          )
          .map((link) => link.localId)
      )
    )
  );

  const mismatchedCanonicalExpectations = canonicalExpectations.filter((expectation) => {
    if (
      isStripePerDeltaRefundCreditNoteLink(expectation, stripePaymentIds)
    ) {
      // Active sibling notes beside the scalar-pointed one are the multi-delta
      // contract, not a mismatch; an absent scalar link is already counted as
      // missing above.
      return false;
    }
    const scopeKey = buildCanonicalScopeKey(expectation);
    const scopedLinks = activeLinksByScope.get(scopeKey) ?? [];
    return (
      scopedLinks.length > 0 &&
      !exactCanonicalLinkKeys.has(buildCanonicalMatchKey(expectation))
    );
  });
  const mismatchedCanonicalLinks = mismatchedCanonicalExpectations.length;

  const staleCanonicalLinkRecords = links.filter((link) => {
    if (isStripePerDeltaRefundCreditNoteLink(link, stripePaymentIds)) {
      // Exempt only LIVE per-delta coverage: the still-active mirror of a
      // note VOIDED/DELETED in Xero is exactly the drift the nightly cleanup
      // deactivates (#2901 fix round), so the digest must show it too.
      return isRefundCreditNoteLinkCancelledInXero(link.metadata);
    }
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

  // Several active per-delta refund notes on one Stripe payment are the
  // contract (#2901), never duplicates — but the exemption is judged per LINK
  // through the shared predicate, not per group (#2901 fix round): a scope
  // group is keyed on localModel:localId:role only, so a malformed (wrong
  // xeroObjectType) sibling can share a group with legitimate per-delta links
  // and must still count as a duplicate, exactly as the cleanup treats it.
  // A duplicate group is a first link plus at least one more; carrying the
  // pair means the item builder below reads the representative it was filtered
  // on rather than re-indexing the group (#2800).
  const duplicateCanonicalLinkGroups = Array.from(activeLinksByScope.values())
    .map((scopedLinks) =>
      scopedLinks.filter(
        (link) => !isStripePerDeltaRefundCreditNoteLink(link, stripePaymentIds)
      )
    )
    .flatMap((nonExemptLinks) => {
      const [firstLink, ...extraLinks] = nonExemptLinks;
      if (firstLink === undefined || extraLinks.length === 0) return [];
      return [{ firstLink, count: nonExemptLinks.length }];
    });
  const duplicateActiveCanonicalLinks = duplicateCanonicalLinkGroups.length;

  // #2901 fix round: OVER-coverage needs its own drift class. The health
  // snapshot (`getRefundsMissingXeroCreditNotes`) reports only UNDER-coverage,
  // cleanup and the classes above deliberately exempt live Stripe per-delta
  // links, and the outbox enqueue/executor silently cap an over-covered
  // payment's next refund note at zero — so without this count a payment whose
  // active, non-cancelled notes exceed the cash refund-note target
  // over-credits the member in Xero indefinitely with no signal anywhere.
  // Coverage is summed through the same status-aware seam every other
  // valuation uses, and the target is the provider-backed cash evidence
  // (#2902, INV-PAY-050), never the refundedAmountCents mirror — an
  // account-credit-only cancellation whose fictitious note exactly equals the
  // mirror is over-covered against a cash target of ZERO and must show here.
  const stripeRefundPaymentRows =
    stripePaymentIds.size > 0
      ? await prisma.payment.findMany({
          where: { id: { in: Array.from(stripePaymentIds) } },
          select: { id: true, bookingId: true, refundedAmountCents: true },
        })
      : [];
  const overCoveredStripeRefundItems: XeroReconciliationIssueItem[] = [];
  for (const payment of stripeRefundPaymentRows) {
    const coveredCents = await sumCoveredRefundCreditNoteCents(payment.id);
    const evidence = await resolveStripeCashRefundEvidence(payment);
    if (coveredCents > evidence.cashRefundCents) {
      overCoveredStripeRefundItems.push({
        label: `Payment ${payment.id}`,
        localModel: "Payment",
        localId: payment.id,
        localUrl: buildLocalAdminUrl("Payment", payment.id),
        xeroObjectType: null,
        xeroObjectId: null,
        xeroObjectNumber: null,
        xeroObjectUrl: null,
        operationId: null,
        operationStatus: null,
        operationType: null,
        correlationKey: null,
        detail: `Active refund credit-note coverage is ${coveredCents} cents against a provider-backed cash refund target of ${evidence.cashRefundCents} cents (${evidence.source}; refunded mirror ${payment.refundedAmountCents} cents), so Xero over-credits this member and any further refund on this payment gets no credit note.`,
        latestErrorMessage: null,
        createdAt: null,
      });
    }
  }
  const overCoveredStripeRefundPayments = overCoveredStripeRefundItems.length;

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
    overCoveredStripeRefundPayments,
    stalePendingOperations,
    recentFailedOperations,
    recentPartialOperations,
    unsupportedPartialOperations,
    repeatedFailures.length,
    failedInboundEvents,
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
    if (
      isStripePerDeltaRefundCreditNoteLink(link, stripePaymentIds) &&
      isRefundCreditNoteLinkCancelledInXero(link.metadata)
    ) {
      return buildCanonicalLinkIssueItem(
        link,
        `The Xero credit note ${link.xeroObjectId} is VOIDED/DELETED in Xero but its local link is still active. The nightly link-cleanup deactivates it so the refund self-heal can reissue the uncovered delta.`
      );
    }
    const expectation = canonicalExpectationByScope.get(buildCanonicalScopeKey(link));
    const detail = expectation
      ? `Active ${link.role} link points to ${link.xeroObjectType} ${link.xeroObjectId}, but the local record now expects ${expectation.xeroObjectType} ${expectation.xeroObjectId}.`
      : `Active ${link.role} link points to ${link.xeroObjectType} ${link.xeroObjectId}, but no local canonical field currently expects that link.`;

    return buildCanonicalLinkIssueItem(link, detail);
  });
  const duplicateCanonicalItems = duplicateCanonicalLinkGroups.map(
    ({ firstLink, count }) =>
      buildCanonicalLinkIssueItem(
        firstLink,
        `${count} active ${firstLink.role} links exist for this record. Only one active canonical link should remain.`
      )
  );
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
              "Xero accepted part of an operation, but the booking system does not currently have enough supported repair logic for this partial state.",
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
    ...(failedInboundEvents > 0
      ? [
          {
            id: "failed-inbound-events",
            title: "Persistently failing inbound Xero events",
            severity: "critical" as const,
            count: failedInboundEvents,
            whatWentWrong:
              "Inbound Xero webhook events have stayed in the FAILED state past the persistence threshold, so the background retry loop is not clearing them and they would otherwise only be visible in the inbound-events drilldown.",
            howToFix:
              "Open the Xero inbound events admin area, inspect the failing event's payload and error, and fix the underlying payload-shape or handler gap. These events keep retrying until they succeed or are resolved.",
            items: failedInboundEventExamples.map((event) =>
              buildInboundEventIssueItem(event, now)
            ),
          },
        ]
      : []),
    ...(overCoveredStripeRefundPayments > 0
      ? [
          {
            id: "stripe-refund-over-coverage",
            title: "Stripe refund coverage above the refunded total",
            severity: "critical" as const,
            count: overCoveredStripeRefundPayments,
            whatWentWrong:
              "A Stripe payment's active refund credit-note links total MORE than the money actually refunded, so Xero over-credits the member — and every later refund on that payment is silently capped to no credit note at all.",
            howToFix:
              'Verify the notes in Xero and void the surplus duplicates THERE (nothing is ever voided automatically, and deleting local rows fixes nothing). Inbound reconciliation and the nightly link-cleanup then deactivate the voided mirrors and coverage returns to the refunded total. Runbook: docs/xero/ARCHITECTURE.md, "Repairing Stripe refund-note links (#2901)".',
            items: overCoveredStripeRefundItems.slice(0, topLimit),
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
              'Open the linked record activity and compare the local record, active Xero links, and external Xero object. A missing link with NO row at all is repaired by the nightly backfill, but the backfill never reactivates an existing INACTIVE row — for a Stripe refund note that stays "missing" run the #2901 repair script (docs/xero/ARCHITECTURE.md, "Repairing Stripe refund-note links"). Mismatched or duplicate active links need admin review.',
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
      overCoveredStripeRefundPayments,
      stalePendingOperations,
      recentFailedOperations,
      recentPartialOperations,
      unsupportedPartialOperations,
      repeatedFailureCorrelations: repeatedFailures.length,
      failedInboundEvents,
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
  failedInboundMinAgeMinutes?: number;
  topLimit?: number;
  now?: Date;
}) {
  const report = await buildXeroReconciliationReport(options);
  const delivery = await shouldSendAdminSystemEmail({
    templateName: "admin-xero-reconciliation-report",
    hasContent: report.summary.issueTotalCount > 0,
  });

  if (!delivery.send) {
    logger.info(
      {
        deliveryMode: delivery.mode,
        reason: delivery.reason,
        issueCategories: report.summary.issueCategoryCount,
        issueTotal: report.summary.issueTotalCount,
      },
      "Skipped Xero reconciliation report email by delivery policy"
    );
    return {
      sent: false,
      deliveryMode: delivery.mode,
      skippedReason: delivery.reason,
      report,
    };
  }

  try {
    await sendAdminXeroReconciliationReportAlert(report);
    return {
      sent: true,
      deliveryMode: delivery.mode,
      report,
    };
  } catch (error) {
    logger.error({ err: error }, "Failed to send Xero reconciliation report");
    return {
      sent: false,
      deliveryMode: delivery.mode,
      report,
    };
  }
}
