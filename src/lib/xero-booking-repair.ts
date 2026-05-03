import { CreditType, Prisma } from "@prisma/client";
import {
  cancelPaymentIntentIfCancellable,
  getPaymentIntent,
  processRefund,
} from "@/lib/stripe";
import {
  enqueueXeroAccountCreditNoteOperation,
  enqueueXeroBookingInvoiceOperation,
  enqueueXeroCreditNoteAllocationOperation,
  enqueueXeroModificationCreditNoteOperation,
  enqueueXeroRefundCreditNoteOperation,
  enqueueXeroSupplementaryInvoiceOperation,
  processQueuedXeroOutboxOperations,
} from "@/lib/xero-operation-outbox";
import {
  enqueueXeroSyncOperationRetry,
  processQueuedXeroOperationRetries,
} from "@/lib/xero-operation-queue";
import {
  getXeroOperationRetryMeta,
  type XeroOperationRetryMeta,
} from "@/lib/xero-operation-retry";
import { buildXeroInvoiceUrl } from "@/lib/xero-links";
import logger from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import { upsertXeroObjectLink } from "@/lib/xero-sync";
import { isXeroConnected } from "@/lib/xero";

const STUCK_OPERATION_MS = 30 * 60 * 1000;
const MAX_APPLY_PASSES = 3;

export const XERO_BOOKING_REPAIR_FINDING_CODES = [
  "MISSING_PRIMARY_INVOICE",
  "CANCELLED_BOOKING_OPEN_INVOICE",
  "MISSING_SUPPLEMENTARY_INVOICE",
  "MISSING_MODIFICATION_CREDIT_NOTE",
  "MISSING_CREDIT_NOTE_ALLOCATION",
  "MISSING_ACCOUNT_CREDIT_NOTE",
  "CANCELLED_IN_FLIGHT_PAYMENT",
  "LATE_CAPTURE_AFTER_CANCELLATION",
  "BLOCKED_BY_XERO_OPERATION",
  "XERO_LINK_MISMATCH",
  "MANUAL_REVIEW_REQUIRED",
] as const;

export type XeroBookingRepairFindingCode =
  (typeof XERO_BOOKING_REPAIR_FINDING_CODES)[number];

export const XERO_BOOKING_REPAIR_ACTION_TYPES = [
  "QUEUE_PRIMARY_INVOICE",
  "QUEUE_SUPPLEMENTARY_INVOICE",
  "QUEUE_MODIFICATION_CREDIT_NOTE",
  "QUEUE_ACCOUNT_CREDIT_NOTE",
  "QUEUE_REFUND_CREDIT_NOTE",
  "QUEUE_CREDIT_NOTE_ALLOCATION",
  "REQUEUE_XERO_OPERATION",
  "SYNC_PAYMENT_PRIMARY_INVOICE_FIELD",
  "SYNC_PAYMENT_PRIMARY_INVOICE_LINK",
  "SYNC_PAYMENT_REFUND_CREDIT_NOTE_FIELD",
  "SYNC_BOOKING_SCOPED_LINK",
  "REPAIR_CANCELLED_IN_FLIGHT_PAYMENT",
  "AUTO_REFUND_LATE_CAPTURED_PAYMENT",
  "MARK_MANUAL_REVIEW",
] as const;

export type XeroBookingRepairActionType =
  (typeof XERO_BOOKING_REPAIR_ACTION_TYPES)[number];

export type XeroBookingRepairSeverity =
  | "critical"
  | "warning"
  | "info"
  | "manual_review";

export type XeroBookingRepairActionStatus =
  | "planned"
  | "applied"
  | "queued"
  | "processed"
  | "skipped"
  | "failed"
  | "manual_review";

export interface BookingXeroRepairScope {
  bookingId?: string;
  from?: Date;
  to?: Date;
  all?: boolean;
}

export interface BookingXeroRepairAction {
  key: string;
  bookingId: string;
  type: XeroBookingRepairActionType;
  description: string;
  safeToAutoApply: boolean;
  payload: Record<string, unknown>;
  status: XeroBookingRepairActionStatus;
  resultMessage: string | null;
}

export interface BookingXeroRepairFinding {
  code: XeroBookingRepairFindingCode;
  severity: XeroBookingRepairSeverity;
  summary: string;
  safeToAutoApply: boolean;
  details: Record<string, unknown>;
  actions: BookingXeroRepairAction[];
}

export interface BookingXeroRepairBookingSummary {
  bookingId: string;
  bookingStatus: string;
  paymentId: string | null;
  paymentStatus: string | null;
  memberId: string;
  memberName: string;
  memberEmail: string;
  checkIn: string;
  checkOut: string;
  findings: BookingXeroRepairFinding[];
  actions: BookingXeroRepairAction[];
}

export interface BookingXeroRepairPassReport {
  pass: number;
  bookingsScanned: number;
  bookingsWithFindings: number;
  findingsByCode: Record<string, number>;
  actionsByType: Record<string, number>;
  actionStatuses: Record<string, number>;
  bookings: BookingXeroRepairBookingSummary[];
}

export interface BookingXeroRepairRunSummary {
  bookingsScanned: number;
  bookingsWithFindings: number;
  findingsByCode: Record<string, number>;
  actionsByType: Record<string, number>;
  actionStatuses: Record<string, number>;
  manualReviewBookings: string[];
  xeroConnectionAvailable: boolean;
}

export interface BookingXeroRepairRunReport {
  mode: "dry-run" | "apply";
  scope: {
    bookingId: string | null;
    from: string | null;
    to: string | null;
    all: boolean;
  };
  startedAt: string;
  completedAt: string;
  passes: BookingXeroRepairPassReport[];
  summary: BookingXeroRepairRunSummary;
}

const bookingRepairSelect = Prisma.validator<Prisma.BookingSelect>()({
  id: true,
  memberId: true,
  status: true,
  checkIn: true,
  checkOut: true,
  totalPriceCents: true,
  discountCents: true,
  finalPriceCents: true,
  createdAt: true,
  updatedAt: true,
  member: {
    select: {
      id: true,
      firstName: true,
      lastName: true,
      email: true,
    },
  },
  payment: {
    select: {
      id: true,
      amountCents: true,
      stripePaymentIntentId: true,
      stripePaymentMethodId: true,
      stripeCustomerId: true,
      xeroInvoiceId: true,
      xeroInvoiceNumber: true,
      status: true,
      refundedAmountCents: true,
      changeFeeCents: true,
      additionalPaymentIntentId: true,
      additionalAmountCents: true,
      additionalPaymentStatus: true,
      xeroRefundCreditNoteId: true,
      creditAppliedCents: true,
      createdAt: true,
      updatedAt: true,
    },
  },
  modifications: {
    orderBy: {
      createdAt: "asc",
    },
    select: {
      id: true,
      bookingId: true,
      modificationType: true,
      priceDiffCents: true,
      changeFeeCents: true,
      createdAt: true,
    },
  },
  creditsFromCancellation: {
    orderBy: {
      createdAt: "asc",
    },
    select: {
      id: true,
      amountCents: true,
      type: true,
      description: true,
      xeroCreditNoteId: true,
      createdAt: true,
    },
  },
});

type BookingRepairRecord = Prisma.BookingGetPayload<{
  select: typeof bookingRepairSelect;
}>;

type BookingModificationRecord = BookingRepairRecord["modifications"][number];

const xeroObjectLinkSelect = Prisma.validator<Prisma.XeroObjectLinkSelect>()({
  id: true,
  localModel: true,
  localId: true,
  xeroObjectType: true,
  xeroObjectId: true,
  xeroObjectNumber: true,
  xeroObjectUrl: true,
  role: true,
  active: true,
  metadata: true,
  createdAt: true,
  updatedAt: true,
});

type XeroObjectLinkRecord = Prisma.XeroObjectLinkGetPayload<{
  select: typeof xeroObjectLinkSelect;
}>;

const xeroOperationSelect = Prisma.validator<Prisma.XeroSyncOperationSelect>()({
  id: true,
  direction: true,
  entityType: true,
  operationType: true,
  localModel: true,
  localId: true,
  status: true,
  idempotencyKey: true,
  correlationKey: true,
  lastErrorCode: true,
  lastErrorMessage: true,
  requestPayload: true,
  responsePayload: true,
  xeroObjectType: true,
  xeroObjectId: true,
  xeroObjectNumber: true,
  xeroObjectUrl: true,
  createdByMemberId: true,
  startedAt: true,
  completedAt: true,
  createdAt: true,
  updatedAt: true,
  replayable: true,
});

type XeroOperationRecord = Prisma.XeroSyncOperationGetPayload<{
  select: typeof xeroOperationSelect;
}>;

type RepairDependencies = {
  prisma: typeof prisma;
  enqueueXeroBookingInvoiceOperation: typeof enqueueXeroBookingInvoiceOperation;
  enqueueXeroSupplementaryInvoiceOperation: typeof enqueueXeroSupplementaryInvoiceOperation;
  enqueueXeroModificationCreditNoteOperation: typeof enqueueXeroModificationCreditNoteOperation;
  enqueueXeroAccountCreditNoteOperation: typeof enqueueXeroAccountCreditNoteOperation;
  enqueueXeroRefundCreditNoteOperation: typeof enqueueXeroRefundCreditNoteOperation;
  enqueueXeroCreditNoteAllocationOperation: typeof enqueueXeroCreditNoteAllocationOperation;
  enqueueXeroSyncOperationRetry: typeof enqueueXeroSyncOperationRetry;
  processQueuedXeroOutboxOperations: typeof processQueuedXeroOutboxOperations;
  processQueuedXeroOperationRetries: typeof processQueuedXeroOperationRetries;
  upsertXeroObjectLink: typeof upsertXeroObjectLink;
  isXeroConnected: typeof isXeroConnected;
  cancelPaymentIntentIfCancellable: typeof cancelPaymentIntentIfCancellable;
  getPaymentIntent: typeof getPaymentIntent;
  processRefund: typeof processRefund;
};

const defaultDependencies: RepairDependencies = {
  prisma,
  enqueueXeroBookingInvoiceOperation,
  enqueueXeroSupplementaryInvoiceOperation,
  enqueueXeroModificationCreditNoteOperation,
  enqueueXeroAccountCreditNoteOperation,
  enqueueXeroRefundCreditNoteOperation,
  enqueueXeroCreditNoteAllocationOperation,
  enqueueXeroSyncOperationRetry,
  processQueuedXeroOutboxOperations,
  processQueuedXeroOperationRetries,
  upsertXeroObjectLink,
  isXeroConnected,
  cancelPaymentIntentIfCancellable,
  getPaymentIntent,
  processRefund,
};

interface ResolvedLocalObject {
  objectId: string;
  objectNumber: string | null;
  objectUrl: string | null;
  source: "field" | "link" | "operation";
  link: XeroObjectLinkRecord | null;
  operation: XeroOperationRecord | null;
  conflicts: string[];
}

interface BlockingOperationMatch {
  operation: XeroOperationRecord;
  retryMeta: XeroOperationRetryMeta;
}

interface BookingClassificationContext {
  booking: BookingRepairRecord;
  paymentLinks: XeroObjectLinkRecord[];
  bookingLinks: XeroObjectLinkRecord[];
  modificationLinksById: Map<string, XeroObjectLinkRecord[]>;
  paymentOperations: XeroOperationRecord[];
  bookingOperations: XeroOperationRecord[];
  modificationOperationsById: Map<string, XeroOperationRecord[]>;
}

interface MutableFinding {
  code: XeroBookingRepairFindingCode;
  severity: XeroBookingRepairSeverity;
  summary: string;
  safeToAutoApply: boolean;
  details: Record<string, unknown>;
  actionKeys: string[];
}

function getDependencies(overrides?: Partial<RepairDependencies>): RepairDependencies {
  return {
    ...defaultDependencies,
    ...overrides,
  };
}

function makeLocalKey(localModel: string, localId: string) {
  return `${localModel}:${localId}`;
}

function toIsoDate(value: Date) {
  return value.toISOString();
}

function toDateOnly(value: Date) {
  return value.toISOString().slice(0, 10);
}

function startOfDay(value: Date) {
  const next = new Date(value);
  next.setHours(0, 0, 0, 0);
  return next;
}

function addDays(value: Date, days: number) {
  const next = new Date(value);
  next.setDate(next.getDate() + days);
  return next;
}

function buildScopeWhere(scope: BookingXeroRepairScope): Prisma.BookingWhereInput {
  const and: Prisma.BookingWhereInput[] = [];

  if (scope.bookingId) {
    and.push({ id: scope.bookingId });
  }

  if (scope.from || scope.to) {
    const from = scope.from ? startOfDay(scope.from) : undefined;
    const toExclusive = scope.to ? addDays(startOfDay(scope.to), 1) : undefined;
    const range = {
      ...(from ? { gte: from } : {}),
      ...(toExclusive ? { lt: toExclusive } : {}),
    };

    and.push({
      OR: [
        { createdAt: range },
        { updatedAt: range },
        { checkIn: range },
        {
          modifications: {
            some: {
              createdAt: range,
            },
          },
        },
      ],
    });
  }

  if (scope.all || and.length === 0) {
    return and.length > 0 ? { AND: and } : {};
  }

  return { AND: and };
}

function createCountMap(items: string[]): Record<string, number> {
  const counts = new Map<string, number>();
  for (const item of items) {
    counts.set(item, (counts.get(item) ?? 0) + 1);
  }
  return Object.fromEntries(
    Array.from(counts.entries()).sort(([left], [right]) => left.localeCompare(right))
  );
}

async function loadAuditData(
  scope: BookingXeroRepairScope,
  deps: RepairDependencies
) {
  const bookings = await deps.prisma.booking.findMany({
    where: buildScopeWhere(scope),
    select: bookingRepairSelect,
    orderBy: [
      { createdAt: "asc" },
      { id: "asc" },
    ],
  });

  const paymentIds = bookings
    .map((booking) => booking.payment?.id)
    .filter((value): value is string => Boolean(value));
  const bookingIds = bookings.map((booking) => booking.id);
  const modificationIds = bookings.flatMap((booking) =>
    booking.modifications.map((modification) => modification.id)
  );

  const linkScopes: Prisma.XeroObjectLinkWhereInput[] = [];
  if (paymentIds.length > 0) {
    linkScopes.push({ localModel: "Payment", localId: { in: paymentIds } });
  }
  if (bookingIds.length > 0) {
    linkScopes.push({ localModel: "Booking", localId: { in: bookingIds } });
  }
  if (modificationIds.length > 0) {
    linkScopes.push({
      localModel: "BookingModification",
      localId: { in: modificationIds },
    });
  }

  const operationScopes: Prisma.XeroSyncOperationWhereInput[] = [];
  if (paymentIds.length > 0) {
    operationScopes.push({ localModel: "Payment", localId: { in: paymentIds } });
  }
  if (bookingIds.length > 0) {
    operationScopes.push({ localModel: "Booking", localId: { in: bookingIds } });
  }
  if (modificationIds.length > 0) {
    operationScopes.push({
      localModel: "BookingModification",
      localId: { in: modificationIds },
    });
  }

  const [links, operations] = await Promise.all([
    linkScopes.length > 0
      ? deps.prisma.xeroObjectLink.findMany({
          where: {
            active: true,
            OR: linkScopes,
          },
          select: xeroObjectLinkSelect,
          orderBy: [
            { updatedAt: "desc" },
            { createdAt: "desc" },
          ],
        })
      : Promise.resolve([] as XeroObjectLinkRecord[]),
    operationScopes.length > 0
      ? deps.prisma.xeroSyncOperation.findMany({
          where: {
            OR: operationScopes,
          },
          select: xeroOperationSelect,
          orderBy: [
            { updatedAt: "desc" },
            { createdAt: "desc" },
          ],
        })
      : Promise.resolve([] as XeroOperationRecord[]),
  ]);

  const linksByLocalKey = new Map<string, XeroObjectLinkRecord[]>();
  for (const link of links) {
    const key = makeLocalKey(link.localModel, link.localId);
    const list = linksByLocalKey.get(key) ?? [];
    list.push(link);
    linksByLocalKey.set(key, list);
  }

  const operationsByLocalKey = new Map<string, XeroOperationRecord[]>();
  for (const operation of operations) {
    if (!operation.localModel || !operation.localId) {
      continue;
    }
    const key = makeLocalKey(operation.localModel, operation.localId);
    const list = operationsByLocalKey.get(key) ?? [];
    list.push(operation);
    operationsByLocalKey.set(key, list);
  }

  return bookings.map<BookingClassificationContext>((booking) => ({
    booking,
    paymentLinks: booking.payment
      ? linksByLocalKey.get(makeLocalKey("Payment", booking.payment.id)) ?? []
      : [],
    bookingLinks: linksByLocalKey.get(makeLocalKey("Booking", booking.id)) ?? [],
    modificationLinksById: new Map(
      booking.modifications.map((modification) => [
        modification.id,
        linksByLocalKey.get(makeLocalKey("BookingModification", modification.id)) ?? [],
      ])
    ),
    paymentOperations: booking.payment
      ? operationsByLocalKey.get(makeLocalKey("Payment", booking.payment.id)) ?? []
      : [],
    bookingOperations: operationsByLocalKey.get(makeLocalKey("Booking", booking.id)) ?? [],
    modificationOperationsById: new Map(
      booking.modifications.map((modification) => [
        modification.id,
        operationsByLocalKey.get(makeLocalKey("BookingModification", modification.id)) ?? [],
      ])
    ),
  }));
}

function buildObjectUrl(
  xeroObjectType: string,
  objectId: string,
  fallbackUrl: string | null
) {
  if (fallbackUrl) {
    return fallbackUrl;
  }

  if (xeroObjectType === "INVOICE" || xeroObjectType === "ALLOCATION") {
    return buildXeroInvoiceUrl(objectId);
  }

  return null;
}

function resolveObjectFromCandidates(params: {
  fieldObjectId?: string | null;
  fieldObjectNumber?: string | null;
  fieldObjectUrl?: string | null;
  links: XeroObjectLinkRecord[];
  operations: XeroOperationRecord[];
  xeroObjectType: string;
  role?: string;
  entityType?: string;
  operationType?: string;
}): ResolvedLocalObject | null {
  const candidates: ResolvedLocalObject[] = [];

  if (params.fieldObjectId) {
    candidates.push({
      objectId: params.fieldObjectId,
      objectNumber: params.fieldObjectNumber ?? null,
      objectUrl: params.fieldObjectUrl ?? buildObjectUrl(
        params.xeroObjectType,
        params.fieldObjectId,
        null
      ),
      source: "field",
      link: null,
      operation: null,
      conflicts: [],
    });
  }

  for (const link of params.links) {
    if (link.xeroObjectType !== params.xeroObjectType) {
      continue;
    }
    if (params.role && link.role !== params.role) {
      continue;
    }

    candidates.push({
      objectId: link.xeroObjectId,
      objectNumber: link.xeroObjectNumber ?? null,
      objectUrl: buildObjectUrl(params.xeroObjectType, link.xeroObjectId, link.xeroObjectUrl),
      source: "link",
      link,
      operation: null,
      conflicts: [],
    });
  }

  for (const operation of params.operations) {
    if (params.entityType && operation.entityType !== params.entityType) {
      continue;
    }
    if (params.operationType && operation.operationType !== params.operationType) {
      continue;
    }
    if (!["SUCCEEDED", "PARTIAL"].includes(operation.status)) {
      continue;
    }
    if (operation.xeroObjectType && operation.xeroObjectType !== params.xeroObjectType) {
      continue;
    }
    if (!operation.xeroObjectId) {
      continue;
    }

    candidates.push({
      objectId: operation.xeroObjectId,
      objectNumber: operation.xeroObjectNumber ?? null,
      objectUrl: buildObjectUrl(
        params.xeroObjectType,
        operation.xeroObjectId,
        operation.xeroObjectUrl ?? null
      ),
      source: "operation",
      link: null,
      operation,
      conflicts: [],
    });
  }

  if (candidates.length === 0) {
    return null;
  }

  const uniqueIds = [...new Set(candidates.map((candidate) => candidate.objectId))];
  const priority = { field: 0, link: 1, operation: 2 } satisfies Record<ResolvedLocalObject["source"], number>;
  const chosen = [...candidates].sort(
    (left, right) => priority[left.source] - priority[right.source]
  )[0];

  return {
    ...chosen,
    conflicts: uniqueIds.filter((objectId) => objectId !== chosen.objectId),
  };
}

function getBlockingOperation(
  operations: XeroOperationRecord[],
  entityType: string,
  operationType: string
): BlockingOperationMatch | null {
  const relevant = operations.filter(
    (operation) =>
      operation.entityType === entityType &&
      operation.operationType === operationType &&
      ["FAILED", "PARTIAL", "PENDING", "RUNNING"].includes(operation.status)
  );

  if (relevant.length === 0) {
    return null;
  }

  const failedOrPartial = relevant.find((operation) =>
    ["FAILED", "PARTIAL"].includes(operation.status)
  );
  if (failedOrPartial) {
    return {
      operation: failedOrPartial,
      retryMeta: getXeroOperationRetryMeta(failedOrPartial),
    };
  }

  const pendingOrRunning = relevant[0];
  return {
    operation: pendingOrRunning,
    retryMeta: getXeroOperationRetryMeta(pendingOrRunning),
  };
}

function isStuckOperation(operation: XeroOperationRecord) {
  if (!["PENDING", "RUNNING"].includes(operation.status)) {
    return false;
  }

  return Date.now() - operation.createdAt.getTime() >= STUCK_OPERATION_MS;
}

function buildMemberName(booking: BookingRepairRecord) {
  return `${booking.member.firstName} ${booking.member.lastName}`.trim();
}

function getCancellationCreditEntries(booking: BookingRepairRecord) {
  const bookingLabel = booking.id.slice(0, 8);
  return booking.creditsFromCancellation.filter(
    (credit) =>
      credit.type === CreditType.CANCELLATION_REFUND &&
      credit.description === `Cancellation refund for booking ${bookingLabel}`
  );
}

function getCancellationCreditAmountCents(booking: BookingRepairRecord) {
  return getCancellationCreditEntries(booking).reduce(
    (sum, credit) => sum + credit.amountCents,
    0
  );
}

function getModificationNetAmountCents(modification: BookingModificationRecord) {
  return modification.priceDiffCents + modification.changeFeeCents;
}

function getKnownModificationRefundTotalCents(booking: BookingRepairRecord) {
  return booking.modifications.reduce((sum, modification) => {
    const netAmount = getModificationNetAmountCents(modification);
    return netAmount < 0 ? sum + Math.abs(netAmount) : sum;
  }, 0);
}

function getUnpaidCancellationClearingAmountCents(booking: BookingRepairRecord) {
  if (!booking.payment?.xeroInvoiceId) {
    return 0;
  }

  return Math.max(
    booking.payment.amountCents - booking.payment.refundedAmountCents,
    booking.finalPriceCents + booking.payment.changeFeeCents
  );
}

function getCashCancellationRefundCandidateCents(booking: BookingRepairRecord) {
  if (!booking.payment) {
    return null;
  }

  if (getCancellationCreditAmountCents(booking) > 0) {
    return null;
  }

  const knownModificationRefundCents = getKnownModificationRefundTotalCents(booking);
  const candidate = booking.payment.refundedAmountCents - knownModificationRefundCents;
  if (candidate <= 0) {
    return 0;
  }

  if (knownModificationRefundCents > 0) {
    return null;
  }

  return candidate;
}

function addAction(
  actionMap: Map<string, BookingXeroRepairAction>,
  action: Omit<BookingXeroRepairAction, "status" | "resultMessage">
) {
  const existing = actionMap.get(action.key);
  if (existing) {
    return existing;
  }

  const nextAction: BookingXeroRepairAction = {
    ...action,
    status: action.type === "MARK_MANUAL_REVIEW" ? "manual_review" : "planned",
    resultMessage: null,
  };
  actionMap.set(action.key, nextAction);
  return nextAction;
}

function addFinding(
  findings: MutableFinding[],
  input: MutableFinding
) {
  findings.push(input);
}

function buildRetryAction(
  bookingId: string,
  operation: XeroOperationRecord,
  retryMeta: XeroOperationRetryMeta
) {
  return {
    key: `retry:${operation.id}`,
    bookingId,
    type: "REQUEUE_XERO_OPERATION" as const,
    description: `Requeue Xero operation ${operation.id} (${operation.entityType}/${operation.operationType}).`,
    safeToAutoApply: retryMeta.supported,
    payload: {
      operationId: operation.id,
    },
  };
}

function buildManualReviewAction(bookingId: string, reason: string) {
  return {
    key: `manual:${bookingId}:${reason}`,
    bookingId,
    type: "MARK_MANUAL_REVIEW" as const,
    description: reason,
    safeToAutoApply: false,
    payload: {
      reason,
    },
  };
}

function buildLinkRepairAction(params: {
  bookingId: string;
  localModel: "Payment" | "Booking" | "BookingModification";
  localId: string;
  xeroObjectType: string;
  xeroObjectId: string;
  xeroObjectNumber?: string | null;
  xeroObjectUrl?: string | null;
  role: string;
  description: string;
}): Omit<BookingXeroRepairAction, "status" | "resultMessage"> {
  return {
    key: `link:${params.localModel}:${params.localId}:${params.xeroObjectType}:${params.role}:${params.xeroObjectId}`,
    bookingId: params.bookingId,
    type: "SYNC_BOOKING_SCOPED_LINK",
    description: params.description,
    safeToAutoApply: true,
    payload: {
      localModel: params.localModel,
      localId: params.localId,
      xeroObjectType: params.xeroObjectType,
      xeroObjectId: params.xeroObjectId,
      xeroObjectNumber: params.xeroObjectNumber ?? null,
      xeroObjectUrl: params.xeroObjectUrl ?? null,
      role: params.role,
    },
  };
}

function buildBookingSummary(
  context: BookingClassificationContext,
  findings: MutableFinding[],
  actionMap: Map<string, BookingXeroRepairAction>
): BookingXeroRepairBookingSummary {
  const actions = [...actionMap.values()];
  return {
    bookingId: context.booking.id,
    bookingStatus: context.booking.status,
    paymentId: context.booking.payment?.id ?? null,
    paymentStatus: context.booking.payment?.status ?? null,
    memberId: context.booking.memberId,
    memberName: buildMemberName(context.booking),
    memberEmail: context.booking.member.email,
    checkIn: toIsoDate(context.booking.checkIn),
    checkOut: toIsoDate(context.booking.checkOut),
    findings: findings.map((finding) => ({
      code: finding.code,
      severity: finding.severity,
      summary: finding.summary,
      safeToAutoApply: finding.safeToAutoApply,
      details: finding.details,
      actions: finding.actionKeys
        .map((actionKey) => actionMap.get(actionKey))
        .filter((action): action is BookingXeroRepairAction => Boolean(action)),
    })),
    actions,
  };
}

function classifyBookingContext(
  context: BookingClassificationContext
): BookingXeroRepairBookingSummary {
  const { booking } = context;
  const findings: MutableFinding[] = [];
  const actionMap = new Map<string, BookingXeroRepairAction>();
  const payment = booking.payment;
  const paymentLinks = context.paymentLinks;
  const paymentOperations = context.paymentOperations;
  const bookingLinks = context.bookingLinks;
  const bookingOperations = context.bookingOperations;
  const primaryInvoice = payment
    ? resolveObjectFromCandidates({
        fieldObjectId: payment.xeroInvoiceId,
        fieldObjectNumber: payment.xeroInvoiceNumber,
        fieldObjectUrl: payment.xeroInvoiceId
          ? buildXeroInvoiceUrl(payment.xeroInvoiceId)
          : null,
        links: paymentLinks,
        operations: paymentOperations,
        xeroObjectType: "INVOICE",
        role: "PRIMARY_INVOICE",
        entityType: "INVOICE",
        operationType: "CREATE",
      })
    : null;

  if (payment && primaryInvoice?.conflicts.length) {
    const action = addAction(
      actionMap,
      buildManualReviewAction(
        booking.id,
        `Primary invoice references disagree for payment ${payment.id}.`
      )
    );
    addFinding(findings, {
      code: "MANUAL_REVIEW_REQUIRED",
      severity: "manual_review",
      summary: "Primary invoice references conflict across local fields, links, or past operations.",
      safeToAutoApply: false,
      details: {
        paymentId: payment.id,
        primaryInvoiceId: primaryInvoice.objectId,
        conflictingInvoiceIds: primaryInvoice.conflicts,
      },
      actionKeys: [action.key],
    });
  }

  if (payment && primaryInvoice && !payment.xeroInvoiceId) {
    const action = addAction(actionMap, {
      key: `payment-field:primary-invoice:${payment.id}:${primaryInvoice.objectId}`,
      bookingId: booking.id,
      type: "SYNC_PAYMENT_PRIMARY_INVOICE_FIELD",
      description: "Backfill payment.xeroInvoiceId from an existing Xero invoice link or completed operation.",
      safeToAutoApply: true,
      payload: {
        paymentId: payment.id,
        xeroInvoiceId: primaryInvoice.objectId,
        xeroInvoiceNumber: primaryInvoice.objectNumber,
      },
    });
    addFinding(findings, {
      code: "XERO_LINK_MISMATCH",
      severity: "warning",
      summary: "The primary Xero invoice exists, but the payment record is missing its invoice id.",
      safeToAutoApply: true,
      details: {
        paymentId: payment.id,
        xeroInvoiceId: primaryInvoice.objectId,
        source: primaryInvoice.source,
      },
      actionKeys: [action.key],
    });
  }

  if (
    payment &&
    payment.xeroInvoiceId &&
    (!primaryInvoice?.link || primaryInvoice.objectId === payment.xeroInvoiceId)
  ) {
    const hasPrimaryInvoiceLink = paymentLinks.some(
      (link) =>
        link.xeroObjectType === "INVOICE" &&
        link.role === "PRIMARY_INVOICE" &&
        link.xeroObjectId === payment.xeroInvoiceId
    );
    if (!hasPrimaryInvoiceLink) {
      const action = addAction(actionMap, {
        key: `payment-link:primary-invoice:${payment.id}:${payment.xeroInvoiceId}`,
        bookingId: booking.id,
        type: "SYNC_PAYMENT_PRIMARY_INVOICE_LINK",
        description: "Backfill the missing PRIMARY_INVOICE Xero link from the payment record.",
        safeToAutoApply: true,
        payload: {
          paymentId: payment.id,
          xeroInvoiceId: payment.xeroInvoiceId,
          xeroInvoiceNumber: payment.xeroInvoiceNumber,
        },
      });
      addFinding(findings, {
        code: "XERO_LINK_MISMATCH",
        severity: "warning",
        summary: "The payment record points at a Xero invoice, but the PRIMARY_INVOICE link is missing.",
        safeToAutoApply: true,
        details: {
          paymentId: payment.id,
          xeroInvoiceId: payment.xeroInvoiceId,
        },
        actionKeys: [action.key],
      });
    }
  }

  if (booking.status === "CONFIRMED" || booking.status === "PAID") {
    if (payment && !primaryInvoice) {
      const blockingOperation = getBlockingOperation(
        paymentOperations,
        "INVOICE",
        "CREATE"
      );
      if (blockingOperation && blockingOperation.retryMeta.supported) {
        const action = addAction(
          actionMap,
          buildRetryAction(booking.id, blockingOperation.operation, blockingOperation.retryMeta)
        );
        addFinding(findings, {
          code: "BLOCKED_BY_XERO_OPERATION",
          severity: "warning",
          summary: "A failed or partial Xero booking invoice operation is blocking the primary invoice.",
          safeToAutoApply: true,
          details: {
            operationId: blockingOperation.operation.id,
            operationStatus: blockingOperation.operation.status,
            lastErrorCode: blockingOperation.operation.lastErrorCode,
            lastErrorMessage: blockingOperation.operation.lastErrorMessage,
          },
          actionKeys: [action.key],
        });
      } else if (blockingOperation) {
        const summary = isStuckOperation(blockingOperation.operation)
          ? "A pending or running Xero booking invoice operation looks stuck."
          : "A Xero booking invoice operation is already pending or running.";
        addFinding(findings, {
          code: "BLOCKED_BY_XERO_OPERATION",
          severity: "warning",
          summary,
          safeToAutoApply: false,
          details: {
            operationId: blockingOperation.operation.id,
            operationStatus: blockingOperation.operation.status,
          },
          actionKeys: [],
        });
      } else {
        const action = addAction(actionMap, {
          key: `queue:primary-invoice:${booking.id}`,
          bookingId: booking.id,
          type: "QUEUE_PRIMARY_INVOICE",
          description: "Queue a missing primary Xero invoice for this confirmed or paid booking.",
          safeToAutoApply: true,
          payload: {
            bookingId: booking.id,
          },
        });
        addFinding(findings, {
          code: "MISSING_PRIMARY_INVOICE",
          severity: "critical",
          summary: "The booking is confirmed or paid locally, but no primary Xero invoice can be resolved.",
          safeToAutoApply: true,
          details: {
            paymentId: payment.id,
          },
          actionKeys: [action.key],
        });
      }
    }
  }

  for (const modification of booking.modifications) {
    const modificationLinks = context.modificationLinksById.get(modification.id) ?? [];
    const modificationOperations =
      context.modificationOperationsById.get(modification.id) ?? [];
    const netAmountCents = getModificationNetAmountCents(modification);

    if (netAmountCents > 0 && primaryInvoice) {
      const supplementaryInvoice = resolveObjectFromCandidates({
        links: modificationLinks,
        operations: modificationOperations,
        xeroObjectType: "INVOICE",
        role: "SUPPLEMENTARY_INVOICE",
        entityType: "INVOICE",
        operationType: "CREATE",
      });

      if (!supplementaryInvoice) {
        const blockingOperation = getBlockingOperation(
          modificationOperations,
          "INVOICE",
          "CREATE"
        );
        if (blockingOperation && blockingOperation.retryMeta.supported) {
          const action = addAction(
            actionMap,
            buildRetryAction(booking.id, blockingOperation.operation, blockingOperation.retryMeta)
          );
          addFinding(findings, {
            code: "BLOCKED_BY_XERO_OPERATION",
            severity: "warning",
            summary: `A failed or partial Xero supplementary invoice operation is blocking modification ${modification.id}.`,
            safeToAutoApply: true,
            details: {
              modificationId: modification.id,
              operationId: blockingOperation.operation.id,
              operationStatus: blockingOperation.operation.status,
            },
            actionKeys: [action.key],
          });
        } else if (!blockingOperation) {
          const action = addAction(actionMap, {
            key: `queue:supplementary-invoice:${modification.id}`,
            bookingId: booking.id,
            type: "QUEUE_SUPPLEMENTARY_INVOICE",
            description: "Queue the missing Xero supplementary invoice for a price-increase booking modification.",
            safeToAutoApply: true,
            payload: {
              bookingId: booking.id,
              bookingModificationId: modification.id,
              priceDiffCents: Math.max(modification.priceDiffCents, 0),
              changeFeeCents: modification.changeFeeCents,
            },
          });
          addFinding(findings, {
            code: "MISSING_SUPPLEMENTARY_INVOICE",
            severity: "critical",
            summary: "A booking modification increased the amount owing, but no supplementary Xero invoice exists.",
            safeToAutoApply: true,
            details: {
              modificationId: modification.id,
              netAmountCents,
              priceDiffCents: modification.priceDiffCents,
              changeFeeCents: modification.changeFeeCents,
            },
            actionKeys: [action.key],
          });
        }
      } else if (!supplementaryInvoice.link && supplementaryInvoice.operation) {
        const action = addAction(
          actionMap,
          buildLinkRepairAction({
            bookingId: booking.id,
            localModel: "BookingModification",
            localId: modification.id,
            xeroObjectType: "INVOICE",
            xeroObjectId: supplementaryInvoice.objectId,
            xeroObjectNumber: supplementaryInvoice.objectNumber,
            xeroObjectUrl: supplementaryInvoice.objectUrl,
            role: "SUPPLEMENTARY_INVOICE",
            description:
              "Backfill the SUPPLEMENTARY_INVOICE link from a completed Xero operation.",
          })
        );
        addFinding(findings, {
          code: "XERO_LINK_MISMATCH",
          severity: "warning",
          summary: "A supplementary invoice exists in operation history, but its booking-modification link is missing.",
          safeToAutoApply: true,
          details: {
            modificationId: modification.id,
            xeroInvoiceId: supplementaryInvoice.objectId,
          },
          actionKeys: [action.key],
        });
      }
    }

    if (netAmountCents < 0 && primaryInvoice) {
      const modificationCreditNote = resolveObjectFromCandidates({
        links: modificationLinks,
        operations: modificationOperations,
        xeroObjectType: "CREDIT_NOTE",
        role: "MODIFICATION_CREDIT_NOTE",
        entityType: "CREDIT_NOTE",
        operationType: "CREATE",
      });

      if (!modificationCreditNote) {
        const blockingOperation = getBlockingOperation(
          modificationOperations,
          "CREDIT_NOTE",
          "CREATE"
        );
        if (blockingOperation && blockingOperation.retryMeta.supported) {
          const action = addAction(
            actionMap,
            buildRetryAction(booking.id, blockingOperation.operation, blockingOperation.retryMeta)
          );
          addFinding(findings, {
            code: "BLOCKED_BY_XERO_OPERATION",
            severity: "warning",
            summary: `A failed or partial Xero modification credit note operation is blocking modification ${modification.id}.`,
            safeToAutoApply: true,
            details: {
              modificationId: modification.id,
              operationId: blockingOperation.operation.id,
              operationStatus: blockingOperation.operation.status,
            },
            actionKeys: [action.key],
          });
        } else if (!blockingOperation) {
          const action = addAction(actionMap, {
            key: `queue:mod-credit-note:${modification.id}`,
            bookingId: booking.id,
            type: "QUEUE_MODIFICATION_CREDIT_NOTE",
            description:
              "Queue the missing Xero modification credit note for a price-decrease booking modification.",
            safeToAutoApply: true,
            payload: {
              bookingId: booking.id,
              bookingModificationId: modification.id,
              refundAmountCents: Math.abs(netAmountCents),
            },
          });
          addFinding(findings, {
            code: "MISSING_MODIFICATION_CREDIT_NOTE",
            severity: "critical",
            summary: "A booking modification reduced the amount owing, but no modification Xero credit note exists.",
            safeToAutoApply: true,
            details: {
              modificationId: modification.id,
              refundAmountCents: Math.abs(netAmountCents),
              priceDiffCents: modification.priceDiffCents,
              changeFeeCents: modification.changeFeeCents,
            },
            actionKeys: [action.key],
          });
        }
      } else {
        if (!modificationCreditNote.link && modificationCreditNote.operation) {
          const action = addAction(
            actionMap,
            buildLinkRepairAction({
              bookingId: booking.id,
              localModel: "BookingModification",
              localId: modification.id,
              xeroObjectType: "CREDIT_NOTE",
              xeroObjectId: modificationCreditNote.objectId,
              xeroObjectNumber: modificationCreditNote.objectNumber,
              xeroObjectUrl: modificationCreditNote.objectUrl,
              role: "MODIFICATION_CREDIT_NOTE",
              description:
                "Backfill the MODIFICATION_CREDIT_NOTE link from a completed Xero operation.",
            })
          );
          addFinding(findings, {
            code: "XERO_LINK_MISMATCH",
            severity: "warning",
            summary:
              "A modification credit note exists in operation history, but its booking-modification link is missing.",
            safeToAutoApply: true,
            details: {
              modificationId: modification.id,
              xeroCreditNoteId: modificationCreditNote.objectId,
            },
            actionKeys: [action.key],
          });
        }

        const allocation = resolveObjectFromCandidates({
          links: modificationLinks,
          operations: modificationOperations,
          xeroObjectType: "ALLOCATION",
          role: "MODIFICATION_CREDIT_NOTE_ALLOCATION",
          entityType: "ALLOCATION",
          operationType: "ALLOCATE",
        });

        if (!allocation) {
          const blockingOperation = getBlockingOperation(
            modificationOperations,
            "ALLOCATION",
            "ALLOCATE"
          );
          if (blockingOperation && blockingOperation.retryMeta.supported) {
            const action = addAction(
              actionMap,
              buildRetryAction(booking.id, blockingOperation.operation, blockingOperation.retryMeta)
            );
            addFinding(findings, {
              code: "BLOCKED_BY_XERO_OPERATION",
              severity: "warning",
              summary:
                "A failed or partial Xero allocation operation is blocking a modification credit note allocation.",
              safeToAutoApply: true,
              details: {
                modificationId: modification.id,
                operationId: blockingOperation.operation.id,
                operationStatus: blockingOperation.operation.status,
              },
              actionKeys: [action.key],
            });
          } else {
            const action = addAction(actionMap, {
              key: `queue:allocation:${modification.id}:${modificationCreditNote.objectId}`,
              bookingId: booking.id,
              type: "QUEUE_CREDIT_NOTE_ALLOCATION",
              description:
                "Queue the missing Xero allocation linking the modification credit note back to the primary invoice.",
              safeToAutoApply: true,
              payload: {
                localModel: "BookingModification",
                localId: modification.id,
                creditNoteId: modificationCreditNote.objectId,
                invoiceId: primaryInvoice.objectId,
                amountCents: Math.abs(netAmountCents),
                role: "MODIFICATION_CREDIT_NOTE_ALLOCATION",
              },
            });
            addFinding(findings, {
              code: "MISSING_CREDIT_NOTE_ALLOCATION",
              severity: "critical",
              summary: "A modification credit note exists, but it is not allocated back to the original invoice.",
              safeToAutoApply: true,
              details: {
                modificationId: modification.id,
                creditNoteId: modificationCreditNote.objectId,
                invoiceId: primaryInvoice.objectId,
                amountCents: Math.abs(netAmountCents),
              },
              actionKeys: [action.key],
            });
          }
        } else if (!allocation.link && allocation.operation) {
          const action = addAction(
            actionMap,
            buildLinkRepairAction({
              bookingId: booking.id,
              localModel: "BookingModification",
              localId: modification.id,
              xeroObjectType: "ALLOCATION",
              xeroObjectId: allocation.objectId,
              xeroObjectNumber: allocation.objectNumber,
              xeroObjectUrl: allocation.objectUrl,
              role: "MODIFICATION_CREDIT_NOTE_ALLOCATION",
              description:
                "Backfill the missing MODIFICATION_CREDIT_NOTE_ALLOCATION link from a completed Xero allocation operation.",
            })
          );
          addFinding(findings, {
            code: "XERO_LINK_MISMATCH",
            severity: "warning",
            summary: "A modification credit-note allocation exists in operation history, but its link is missing.",
            safeToAutoApply: true,
            details: {
              modificationId: modification.id,
              allocationId: allocation.objectId,
            },
            actionKeys: [action.key],
          });
        }
      }
    }
  }

  const refundCreditNote = payment
    ? resolveObjectFromCandidates({
        fieldObjectId: payment.xeroRefundCreditNoteId,
        links: paymentLinks,
        operations: paymentOperations,
        xeroObjectType: "CREDIT_NOTE",
        role: "REFUND_CREDIT_NOTE",
        entityType: "CREDIT_NOTE",
        operationType: "CREATE",
      })
    : null;

  if (payment && refundCreditNote?.conflicts.length) {
    const action = addAction(
      actionMap,
      buildManualReviewAction(
        booking.id,
        `Refund credit note references disagree for payment ${payment.id}.`
      )
    );
    addFinding(findings, {
      code: "MANUAL_REVIEW_REQUIRED",
      severity: "manual_review",
      summary: "Refund credit note references conflict across local fields, links, or past operations.",
      safeToAutoApply: false,
      details: {
        paymentId: payment.id,
        creditNoteId: refundCreditNote.objectId,
        conflictingCreditNoteIds: refundCreditNote.conflicts,
      },
      actionKeys: [action.key],
    });
  }

  if (payment && refundCreditNote && !payment.xeroRefundCreditNoteId) {
    const action = addAction(actionMap, {
      key: `payment-field:refund-credit-note:${payment.id}:${refundCreditNote.objectId}`,
      bookingId: booking.id,
      type: "SYNC_PAYMENT_REFUND_CREDIT_NOTE_FIELD",
      description:
        "Backfill payment.xeroRefundCreditNoteId from an existing refund credit note link or completed operation.",
      safeToAutoApply: true,
      payload: {
        paymentId: payment.id,
        xeroRefundCreditNoteId: refundCreditNote.objectId,
      },
    });
    addFinding(findings, {
      code: "XERO_LINK_MISMATCH",
      severity: "warning",
      summary: "A refund credit note exists, but the payment record is missing its xeroRefundCreditNoteId.",
      safeToAutoApply: true,
      details: {
        paymentId: payment.id,
        creditNoteId: refundCreditNote.objectId,
      },
      actionKeys: [action.key],
    });
  }

  if (booking.status === "CANCELLED" && payment?.status !== "SUCCEEDED" && primaryInvoice) {
    const clearingAmountCents = getUnpaidCancellationClearingAmountCents(booking);
    if (clearingAmountCents > 0) {
      const cancellationCreditNote = resolveObjectFromCandidates({
        links: bookingLinks,
        operations: bookingOperations,
        xeroObjectType: "CREDIT_NOTE",
        role: "MODIFICATION_CREDIT_NOTE",
        entityType: "CREDIT_NOTE",
        operationType: "CREATE",
      });

      if (!cancellationCreditNote) {
        const blockingOperation = getBlockingOperation(
          bookingOperations,
          "CREDIT_NOTE",
          "CREATE"
        );
        if (blockingOperation && blockingOperation.retryMeta.supported) {
          const action = addAction(
            actionMap,
            buildRetryAction(booking.id, blockingOperation.operation, blockingOperation.retryMeta)
          );
          addFinding(findings, {
            code: "BLOCKED_BY_XERO_OPERATION",
            severity: "warning",
            summary:
              "A failed or partial Xero cancellation credit note operation is blocking an unpaid cancelled booking from clearing its invoice.",
            safeToAutoApply: true,
            details: {
              operationId: blockingOperation.operation.id,
              operationStatus: blockingOperation.operation.status,
            },
            actionKeys: [action.key],
          });
        } else if (!blockingOperation) {
          const action = addAction(actionMap, {
            key: `queue:cancelled-open-invoice:${booking.id}`,
            bookingId: booking.id,
            type: "QUEUE_MODIFICATION_CREDIT_NOTE",
            description:
              "Queue the missing Xero credit note needed to clear the original invoice for a cancelled unpaid booking.",
            safeToAutoApply: true,
            payload: {
              bookingId: booking.id,
              refundAmountCents: clearingAmountCents,
            },
          });
          addFinding(findings, {
            code: "CANCELLED_BOOKING_OPEN_INVOICE",
            severity: "critical",
            summary:
              "The booking was cancelled before payment succeeded, but the original Xero invoice still needs a clearing credit note.",
            safeToAutoApply: true,
            details: {
              paymentId: payment.id,
              invoiceId: primaryInvoice.objectId,
              clearingAmountCents,
            },
            actionKeys: [action.key],
          });
        }
      } else {
        const allocation = resolveObjectFromCandidates({
          links: bookingLinks,
          operations: bookingOperations,
          xeroObjectType: "ALLOCATION",
          role: "MODIFICATION_CREDIT_NOTE_ALLOCATION",
          entityType: "ALLOCATION",
          operationType: "ALLOCATE",
        });
        if (!allocation) {
          const blockingOperation = getBlockingOperation(
            bookingOperations,
            "ALLOCATION",
            "ALLOCATE"
          );
          if (blockingOperation && blockingOperation.retryMeta.supported) {
            const action = addAction(
              actionMap,
              buildRetryAction(booking.id, blockingOperation.operation, blockingOperation.retryMeta)
            );
            addFinding(findings, {
              code: "BLOCKED_BY_XERO_OPERATION",
              severity: "warning",
              summary:
                "A failed or partial Xero allocation operation is blocking an unpaid cancelled booking from clearing its invoice.",
              safeToAutoApply: true,
              details: {
                operationId: blockingOperation.operation.id,
                operationStatus: blockingOperation.operation.status,
              },
              actionKeys: [action.key],
            });
          } else {
            const action = addAction(actionMap, {
              key: `queue:cancelled-allocation:${booking.id}:${cancellationCreditNote.objectId}`,
              bookingId: booking.id,
              type: "QUEUE_CREDIT_NOTE_ALLOCATION",
              description:
                "Queue the missing Xero allocation that clears the original invoice for a cancelled unpaid booking.",
              safeToAutoApply: true,
              payload: {
                localModel: "Booking",
                localId: booking.id,
                creditNoteId: cancellationCreditNote.objectId,
                invoiceId: primaryInvoice.objectId,
                amountCents: clearingAmountCents,
                role: "MODIFICATION_CREDIT_NOTE_ALLOCATION",
              },
            });
            addFinding(findings, {
              code: "MISSING_CREDIT_NOTE_ALLOCATION",
              severity: "critical",
              summary:
                "The cancellation credit note exists, but it is not allocated back to the cancelled booking invoice.",
              safeToAutoApply: true,
              details: {
                bookingId: booking.id,
                creditNoteId: cancellationCreditNote.objectId,
                invoiceId: primaryInvoice.objectId,
                amountCents: clearingAmountCents,
              },
              actionKeys: [action.key],
            });
          }
        }
      }
    }
  }

  if (
    booking.status === "CANCELLED" &&
    payment &&
    (payment.status === "PENDING" || payment.status === "PROCESSING")
  ) {
    const action = addAction(actionMap, {
      key: `cancel-inflight-payment:${booking.id}:${payment.id}`,
      bookingId: booking.id,
      type: "REPAIR_CANCELLED_IN_FLIGHT_PAYMENT",
      description:
        "Verify and cancel any in-flight Stripe payment intent, then mark the cancelled booking payment as failed if it never captured.",
      safeToAutoApply: true,
      payload: {
        bookingId: booking.id,
        paymentId: payment.id,
        stripePaymentIntentId: payment.stripePaymentIntentId,
      },
    });
    addFinding(findings, {
      code: "CANCELLED_IN_FLIGHT_PAYMENT",
      severity: "critical",
      summary:
        "The booking is cancelled, but its payment still shows as PENDING or PROCESSING.",
      safeToAutoApply: true,
      details: {
        paymentId: payment.id,
        paymentStatus: payment.status,
        paymentIntentId: payment.stripePaymentIntentId,
      },
      actionKeys: [action.key],
    });
  }

  if (
    booking.status === "CANCELLED" &&
    payment &&
    payment.status === "SUCCEEDED" &&
    payment.refundedAmountCents < payment.amountCents
  ) {
    const refundAmountCents = payment.amountCents - payment.refundedAmountCents;
    const action = addAction(actionMap, {
      key: `late-capture-refund:${booking.id}:${payment.id}:${refundAmountCents}`,
      bookingId: booking.id,
      type: "AUTO_REFUND_LATE_CAPTURED_PAYMENT",
      description:
        "Automatically refund the late Stripe capture for a cancelled booking and queue the matching Xero refund note if needed.",
      safeToAutoApply: true,
      payload: {
        bookingId: booking.id,
        paymentId: payment.id,
        stripePaymentIntentId: payment.stripePaymentIntentId,
        refundAmountCents,
        invoiceId: primaryInvoice?.objectId ?? null,
      },
    });
    addFinding(findings, {
      code: "LATE_CAPTURE_AFTER_CANCELLATION",
      severity: "critical",
      summary:
        "Stripe captured payment after the booking had already been cancelled.",
      safeToAutoApply: true,
      details: {
        paymentId: payment.id,
        refundAmountCents,
        invoiceId: primaryInvoice?.objectId ?? null,
      },
      actionKeys: [action.key],
    });
  }

  if (booking.status === "CANCELLED" && payment) {
    const cancellationCreditAmountCents = getCancellationCreditAmountCents(booking);
    if (cancellationCreditAmountCents > 0) {
      const accountCreditNote = resolveObjectFromCandidates({
        links: paymentLinks,
        operations: paymentOperations,
        xeroObjectType: "CREDIT_NOTE",
        role: "ACCOUNT_CREDIT_NOTE",
        entityType: "CREDIT_NOTE",
        operationType: "CREATE",
      });

      if (!accountCreditNote) {
        const blockingOperation = getBlockingOperation(
          paymentOperations,
          "CREDIT_NOTE",
          "CREATE"
        );
        if (blockingOperation && blockingOperation.retryMeta.supported) {
          const action = addAction(
            actionMap,
            buildRetryAction(booking.id, blockingOperation.operation, blockingOperation.retryMeta)
          );
          addFinding(findings, {
            code: "BLOCKED_BY_XERO_OPERATION",
            severity: "warning",
            summary:
              "A failed or partial Xero account-credit note operation is blocking a cancelled booking credit refund.",
            safeToAutoApply: true,
            details: {
              operationId: blockingOperation.operation.id,
              operationStatus: blockingOperation.operation.status,
            },
            actionKeys: [action.key],
          });
        } else if (!blockingOperation) {
          const action = addAction(actionMap, {
            key: `queue:account-credit-note:${payment.id}:${cancellationCreditAmountCents}`,
            bookingId: booking.id,
            type: "QUEUE_ACCOUNT_CREDIT_NOTE",
            description:
              "Queue the missing unapplied Xero account-credit note for a cancelled booking credit refund.",
            safeToAutoApply: true,
            payload: {
              paymentId: payment.id,
              refundAmountCents: cancellationCreditAmountCents,
            },
          });
          addFinding(findings, {
            code: "MISSING_ACCOUNT_CREDIT_NOTE",
            severity: "critical",
            summary:
              "The cancelled booking created local account credit, but no corresponding unapplied Xero credit note exists.",
            safeToAutoApply: true,
            details: {
              paymentId: payment.id,
              refundAmountCents: cancellationCreditAmountCents,
            },
            actionKeys: [action.key],
          });
        }
      }
    }

    if (primaryInvoice && !refundCreditNote) {
      const cashCancellationRefundCents = getCashCancellationRefundCandidateCents(booking);
      if (cashCancellationRefundCents === null) {
        const action = addAction(
          actionMap,
          buildManualReviewAction(
            booking.id,
            "Cancelled booking has refunded cash locally, but the missing Xero cancellation credit note amount is ambiguous."
          )
        );
        addFinding(findings, {
          code: "MANUAL_REVIEW_REQUIRED",
          severity: "manual_review",
          summary:
            "The booking appears to have a cash cancellation refund, but the missing Xero refund note amount cannot be derived safely from local history.",
          safeToAutoApply: false,
          details: {
            paymentId: payment.id,
            refundedAmountCents: payment.refundedAmountCents,
            knownModificationRefundCents: getKnownModificationRefundTotalCents(booking),
          },
          actionKeys: [action.key],
        });
      } else if (cashCancellationRefundCents > 0) {
        const blockingOperation = getBlockingOperation(
          paymentOperations,
          "CREDIT_NOTE",
          "CREATE"
        );
        if (blockingOperation && blockingOperation.retryMeta.supported) {
          const action = addAction(
            actionMap,
            buildRetryAction(booking.id, blockingOperation.operation, blockingOperation.retryMeta)
          );
          addFinding(findings, {
            code: "BLOCKED_BY_XERO_OPERATION",
            severity: "warning",
            summary:
              "A failed or partial Xero refund credit note operation is blocking a cancelled booking cash refund.",
            safeToAutoApply: true,
            details: {
              operationId: blockingOperation.operation.id,
              operationStatus: blockingOperation.operation.status,
            },
            actionKeys: [action.key],
          });
        } else if (!blockingOperation) {
          const action = addAction(actionMap, {
            key: `queue:refund-credit-note:${payment.id}:${cashCancellationRefundCents}`,
            bookingId: booking.id,
            type: "QUEUE_REFUND_CREDIT_NOTE",
            description:
              "Queue the missing Xero refund credit note for a cancelled booking cash refund.",
            safeToAutoApply: true,
            payload: {
              paymentId: payment.id,
              refundAmountCents: cashCancellationRefundCents,
            },
          });
          addFinding(findings, {
            code: "CANCELLED_BOOKING_OPEN_INVOICE",
            severity: "critical",
            summary:
              "The cancelled booking refunded cash locally, but no Xero refund credit note can be resolved for that cancellation.",
            safeToAutoApply: true,
            details: {
              paymentId: payment.id,
              refundAmountCents: cashCancellationRefundCents,
            },
            actionKeys: [action.key],
          });
        }
      }
    }
  }

  return buildBookingSummary(context, findings, actionMap);
}

function buildPassReport(pass: number, bookings: BookingXeroRepairBookingSummary[]): BookingXeroRepairPassReport {
  const bookingsWithFindings = bookings.filter((booking) => booking.findings.length > 0);
  const findings = bookingsWithFindings.flatMap((booking) => booking.findings.map((finding) => finding.code));
  const actions = bookingsWithFindings.flatMap((booking) => booking.actions.map((action) => action.type));
  const actionStatuses = bookingsWithFindings.flatMap((booking) =>
    booking.actions.map((action) => action.status)
  );

  return {
    pass,
    bookingsScanned: bookings.length,
    bookingsWithFindings: bookingsWithFindings.length,
    findingsByCode: createCountMap(findings),
    actionsByType: createCountMap(actions),
    actionStatuses: createCountMap(actionStatuses),
    bookings,
  };
}

async function applyLocalPrimaryInvoiceFieldRepair(
  action: BookingXeroRepairAction,
  deps: RepairDependencies
) {
  const paymentId = String(action.payload.paymentId);
  const xeroInvoiceId = String(action.payload.xeroInvoiceId);
  const xeroInvoiceNumber =
    typeof action.payload.xeroInvoiceNumber === "string"
      ? action.payload.xeroInvoiceNumber
      : null;

  await deps.prisma.payment.update({
    where: { id: paymentId },
    data: {
      xeroInvoiceId,
      xeroInvoiceNumber,
    },
  });

  action.status = "applied";
  action.resultMessage = `Updated payment ${paymentId} with Xero invoice ${xeroInvoiceId}.`;
}

async function applyLocalPrimaryInvoiceLinkRepair(
  action: BookingXeroRepairAction,
  deps: RepairDependencies
) {
  const paymentId = String(action.payload.paymentId);
  const xeroInvoiceId = String(action.payload.xeroInvoiceId);
  const xeroInvoiceNumber =
    typeof action.payload.xeroInvoiceNumber === "string"
      ? action.payload.xeroInvoiceNumber
      : null;

  await deps.upsertXeroObjectLink({
    localModel: "Payment",
    localId: paymentId,
    xeroObjectType: "INVOICE",
    xeroObjectId: xeroInvoiceId,
    xeroObjectNumber: xeroInvoiceNumber,
    xeroObjectUrl: buildXeroInvoiceUrl(xeroInvoiceId),
    role: "PRIMARY_INVOICE",
  });

  action.status = "applied";
  action.resultMessage = `Backfilled PRIMARY_INVOICE link for payment ${paymentId}.`;
}

async function applyLocalRefundCreditNoteFieldRepair(
  action: BookingXeroRepairAction,
  deps: RepairDependencies
) {
  const paymentId = String(action.payload.paymentId);
  const xeroRefundCreditNoteId = String(action.payload.xeroRefundCreditNoteId);

  await deps.prisma.payment.update({
    where: { id: paymentId },
    data: {
      xeroRefundCreditNoteId,
    },
  });

  action.status = "applied";
  action.resultMessage = `Updated payment ${paymentId} with refund credit note ${xeroRefundCreditNoteId}.`;
}

async function applyLinkRepair(
  action: BookingXeroRepairAction,
  deps: RepairDependencies
) {
  await deps.upsertXeroObjectLink({
    localModel: String(action.payload.localModel),
    localId: String(action.payload.localId),
    xeroObjectType: String(action.payload.xeroObjectType),
    xeroObjectId: String(action.payload.xeroObjectId),
    xeroObjectNumber:
      typeof action.payload.xeroObjectNumber === "string"
        ? action.payload.xeroObjectNumber
        : null,
    xeroObjectUrl:
      typeof action.payload.xeroObjectUrl === "string"
        ? action.payload.xeroObjectUrl
        : null,
    role: String(action.payload.role),
  });

  action.status = "applied";
  action.resultMessage = `Backfilled ${String(action.payload.role)} link for ${String(action.payload.localModel)} ${String(action.payload.localId)}.`;
}

async function applyCancelledInFlightPaymentRepair(
  action: BookingXeroRepairAction,
  deps: RepairDependencies
) {
  const paymentId = String(action.payload.paymentId);
  const bookingId = String(action.payload.bookingId);
  const paymentIntentId =
    typeof action.payload.stripePaymentIntentId === "string"
      ? action.payload.stripePaymentIntentId
      : null;

  if (!paymentIntentId) {
    await deps.prisma.payment.update({
      where: { id: paymentId },
      data: {
        status: "FAILED",
        additionalPaymentStatus: "FAILED",
      },
    });
    action.status = "applied";
    action.resultMessage =
      "Marked the cancelled booking payment as failed because no Stripe payment intent id was stored.";
    return;
  }

  const cancelledIntent = await deps.cancelPaymentIntentIfCancellable(paymentIntentId);
  const latestIntent = cancelledIntent ?? (await deps.getPaymentIntent(paymentIntentId));

  if (latestIntent.status === "succeeded") {
    action.status = "failed";
    action.resultMessage =
      "Stripe reports the payment intent as succeeded. Re-run the repair so late-capture refund handling can apply.";
    return;
  }

  const terminalFailureStatuses = new Set([
    "canceled",
    "requires_payment_method",
    "requires_confirmation",
  ]);

  if (!terminalFailureStatuses.has(latestIntent.status)) {
    action.status = "failed";
    action.resultMessage = `Stripe payment intent ${paymentIntentId} is still ${latestIntent.status}. Manual review is required.`;
    return;
  }

  await deps.prisma.payment.update({
    where: { id: paymentId },
    data: {
      status: "FAILED",
      additionalPaymentStatus: "FAILED",
    },
  });

  action.status = "applied";
  action.resultMessage = `Cancelled Stripe payment intent ${paymentIntentId} and marked payment ${paymentId} as failed for booking ${bookingId}.`;
}

async function applyLateCaptureRefundRepair(
  action: BookingXeroRepairAction,
  deps: RepairDependencies
) {
  const paymentId = String(action.payload.paymentId);
  const paymentIntentId =
    typeof action.payload.stripePaymentIntentId === "string"
      ? action.payload.stripePaymentIntentId
      : null;
  const refundAmountCents = Number(action.payload.refundAmountCents);
  const bookingId = String(action.payload.bookingId);
  const invoiceId =
    typeof action.payload.invoiceId === "string"
      ? action.payload.invoiceId
      : null;

  if (!paymentIntentId || !Number.isFinite(refundAmountCents) || refundAmountCents <= 0) {
    action.status = "failed";
    action.resultMessage = "Late-capture repair payload is incomplete.";
    return;
  }

  const refund = await deps.processRefund({
    paymentIntentId,
    amountCents: refundAmountCents,
    metadata: {
      bookingId,
      reason: "cancelled_booking_late_capture_repair",
    },
    idempotencyKey: `late_cancel_refund_repair_${bookingId}_${paymentIntentId}_${refundAmountCents}`,
  });

  await deps.prisma.payment.update({
    where: { id: paymentId },
    data: {
      refundedAmountCents: {
        increment: refundAmountCents,
      },
      status: "REFUNDED",
    },
  });

  if (invoiceId) {
    await deps.enqueueXeroRefundCreditNoteOperation(paymentId, refundAmountCents);
  }

  action.status = invoiceId ? "queued" : "applied";
  action.resultMessage = invoiceId
    ? `Refunded Stripe payment ${paymentIntentId} (${refund.id}) and queued the matching Xero refund credit note.`
    : `Refunded Stripe payment ${paymentIntentId} (${refund.id}). No Xero invoice was linked, so no refund credit note was queued.`;
}

async function applyQueuedAction(
  action: BookingXeroRepairAction,
  deps: RepairDependencies
) {
  switch (action.type) {
    case "QUEUE_PRIMARY_INVOICE": {
      const result = await deps.enqueueXeroBookingInvoiceOperation(
        String(action.payload.bookingId)
      );
      action.status = result.queueOperationId ? "queued" : "skipped";
      action.resultMessage = result.message;
      return;
    }
    case "QUEUE_SUPPLEMENTARY_INVOICE": {
      const result = await deps.enqueueXeroSupplementaryInvoiceOperation({
        bookingId: String(action.payload.bookingId),
        bookingModificationId:
          typeof action.payload.bookingModificationId === "string"
            ? action.payload.bookingModificationId
            : undefined,
        priceDiffCents: Number(action.payload.priceDiffCents),
        changeFeeCents: Number(action.payload.changeFeeCents),
      });
      action.status = result.queueOperationId ? "queued" : "skipped";
      action.resultMessage = result.message;
      return;
    }
    case "QUEUE_MODIFICATION_CREDIT_NOTE": {
      const result = await deps.enqueueXeroModificationCreditNoteOperation({
        bookingId: String(action.payload.bookingId),
        bookingModificationId:
          typeof action.payload.bookingModificationId === "string"
            ? action.payload.bookingModificationId
            : undefined,
        refundAmountCents: Number(action.payload.refundAmountCents),
      });
      action.status = result.queueOperationId ? "queued" : "skipped";
      action.resultMessage = result.message;
      return;
    }
    case "QUEUE_ACCOUNT_CREDIT_NOTE": {
      const result = await deps.enqueueXeroAccountCreditNoteOperation(
        String(action.payload.paymentId),
        Number(action.payload.refundAmountCents)
      );
      action.status = result.queueOperationId ? "queued" : "skipped";
      action.resultMessage = result.message;
      return;
    }
    case "QUEUE_REFUND_CREDIT_NOTE": {
      const result = await deps.enqueueXeroRefundCreditNoteOperation(
        String(action.payload.paymentId),
        Number(action.payload.refundAmountCents)
      );
      action.status = result.queueOperationId ? "queued" : "skipped";
      action.resultMessage = result.message;
      return;
    }
    case "QUEUE_CREDIT_NOTE_ALLOCATION": {
      const result = await deps.enqueueXeroCreditNoteAllocationOperation({
        localModel: action.payload.localModel as "Payment" | "Booking" | "BookingModification",
        localId: String(action.payload.localId),
        creditNoteId: String(action.payload.creditNoteId),
        invoiceId: String(action.payload.invoiceId),
        amountCents: Number(action.payload.amountCents),
        role:
          typeof action.payload.role === "string"
            ? action.payload.role
            : undefined,
      });
      action.status = result.queueOperationId ? "queued" : "skipped";
      action.resultMessage = result.message;
      return;
    }
    case "REQUEUE_XERO_OPERATION": {
      const result = await deps.enqueueXeroSyncOperationRetry(
        String(action.payload.operationId)
      );
      action.status = "queued";
      action.resultMessage = result.message;
      return;
    }
    case "SYNC_PAYMENT_PRIMARY_INVOICE_FIELD":
      await applyLocalPrimaryInvoiceFieldRepair(action, deps);
      return;
    case "SYNC_PAYMENT_PRIMARY_INVOICE_LINK":
      await applyLocalPrimaryInvoiceLinkRepair(action, deps);
      return;
    case "SYNC_PAYMENT_REFUND_CREDIT_NOTE_FIELD":
      await applyLocalRefundCreditNoteFieldRepair(action, deps);
      return;
    case "SYNC_BOOKING_SCOPED_LINK":
      await applyLinkRepair(action, deps);
      return;
    case "REPAIR_CANCELLED_IN_FLIGHT_PAYMENT":
      await applyCancelledInFlightPaymentRepair(action, deps);
      return;
    case "AUTO_REFUND_LATE_CAPTURED_PAYMENT":
      await applyLateCaptureRefundRepair(action, deps);
      return;
    case "MARK_MANUAL_REVIEW":
      action.status = "manual_review";
      action.resultMessage = String(action.payload.reason);
      return;
  }
}

async function applyActionsForPass(
  bookings: BookingXeroRepairBookingSummary[],
  deps: RepairDependencies,
  xeroConnectionAvailable: boolean
) {
  let hasStateChanges = false;

  for (const booking of bookings) {
    for (const action of booking.actions) {
      if (!action.safeToAutoApply || action.status !== "planned") {
        continue;
      }

      try {
        await applyQueuedAction(action, deps);
        if (action.status !== "failed" && action.status !== "manual_review") {
          hasStateChanges = true;
        }
      } catch (error) {
        action.status = "failed";
        action.resultMessage =
          error instanceof Error ? error.message : "Unknown repair error";
        logger.error(
          {
            err: error,
            bookingId: booking.bookingId,
            actionKey: action.key,
            actionType: action.type,
          },
          "Failed to apply booking/Xero repair action"
        );
      }
    }
  }

  if (xeroConnectionAvailable) {
    const [outboxResult, retryResult] = await Promise.all([
      deps.processQueuedXeroOutboxOperations({ limit: 50 }),
      deps.processQueuedXeroOperationRetries({ limit: 50 }),
    ]);

    if (
      outboxResult.processed > 0 ||
      retryResult.processed > 0 ||
      outboxResult.succeeded > 0 ||
      retryResult.succeeded > 0
    ) {
      hasStateChanges = true;
    }
  }

  return hasStateChanges;
}

async function runSinglePass(
  pass: number,
  scope: BookingXeroRepairScope,
  deps: RepairDependencies
) {
  const contexts = await loadAuditData(scope, deps);
  const bookings = contexts.map((context) => classifyBookingContext(context));
  return buildPassReport(pass, bookings);
}

export async function runBookingXeroRepair(options?: {
  scope?: BookingXeroRepairScope;
  apply?: boolean;
  dependencies?: Partial<RepairDependencies>;
}): Promise<BookingXeroRepairRunReport> {
  const scope = options?.scope ?? { all: true };
  const apply = options?.apply ?? false;
  const deps = getDependencies(options?.dependencies);
  const startedAt = new Date();
  const xeroConnectionAvailable = await deps.isXeroConnected().catch(() => false);

  const passes: BookingXeroRepairPassReport[] = [];
  const maxPasses = apply ? MAX_APPLY_PASSES : 1;

  for (let pass = 1; pass <= maxPasses; pass += 1) {
    const passReport = await runSinglePass(pass, scope, deps);
    passes.push(passReport);

    if (!apply) {
      break;
    }

    const hasPlannedActions = passReport.bookings.some((booking) =>
      booking.actions.some((action) => action.safeToAutoApply && action.status === "planned")
    );
    if (!hasPlannedActions) {
      break;
    }

    const hasStateChanges = await applyActionsForPass(
      passReport.bookings,
      deps,
      xeroConnectionAvailable
    );
    if (!hasStateChanges) {
      break;
    }
  }

  const finalPass = passes[passes.length - 1];
  const finalBookingsWithFindings = finalPass.bookings.filter(
    (booking) => booking.findings.length > 0
  );
  const allActions = passes.flatMap((pass) =>
    pass.bookings.flatMap((booking) => booking.actions)
  );
  const summary: BookingXeroRepairRunSummary = {
    bookingsScanned: finalPass.bookingsScanned,
    bookingsWithFindings: finalPass.bookingsWithFindings,
    findingsByCode: createCountMap(
      finalPass.bookings.flatMap((booking) =>
        booking.findings.map((finding) => finding.code)
      )
    ),
    actionsByType: createCountMap(allActions.map((action) => action.type)),
    actionStatuses: createCountMap(allActions.map((action) => action.status)),
    manualReviewBookings: finalBookingsWithFindings
      .filter((booking) =>
        booking.findings.some((finding) => finding.severity === "manual_review")
      )
      .map((booking) => booking.bookingId),
    xeroConnectionAvailable,
  };

  return {
    mode: apply ? "apply" : "dry-run",
    scope: {
      bookingId: scope.bookingId ?? null,
      from: scope.from ? toDateOnly(scope.from) : null,
      to: scope.to ? toDateOnly(scope.to) : null,
      all: Boolean(scope.all || (!scope.bookingId && !scope.from && !scope.to)),
    },
    startedAt: startedAt.toISOString(),
    completedAt: new Date().toISOString(),
    passes,
    summary,
  };
}

export function formatBookingXeroRepairHumanSummary(
  report: BookingXeroRepairRunReport
) {
  const lines: string[] = [];
  lines.push(`Mode: ${report.mode}`);
  lines.push(
    `Scope: booking=${report.scope.bookingId ?? "all"}, from=${report.scope.from ?? "-"}, to=${report.scope.to ?? "-"}`
  );
  lines.push(`Bookings scanned: ${report.summary.bookingsScanned}`);
  lines.push(`Bookings with findings: ${report.summary.bookingsWithFindings}`);
  lines.push(
    `Xero connected: ${report.summary.xeroConnectionAvailable ? "yes" : "no"}`
  );

  if (Object.keys(report.summary.findingsByCode).length > 0) {
    lines.push("");
    lines.push("Findings:");
    for (const [code, count] of Object.entries(report.summary.findingsByCode)) {
      lines.push(`- ${code}: ${count}`);
    }
  }

  if (Object.keys(report.summary.actionStatuses).length > 0) {
    lines.push("");
    lines.push("Action Statuses:");
    for (const [status, count] of Object.entries(report.summary.actionStatuses)) {
      lines.push(`- ${status}: ${count}`);
    }
  }

  const actionableBookings = report.passes[report.passes.length - 1]?.bookings.filter(
    (booking) => booking.findings.length > 0
  ) ?? [];

  if (actionableBookings.length > 0) {
    lines.push("");
    lines.push("Bookings:");
    for (const booking of actionableBookings) {
      lines.push(
        `- ${booking.bookingId} (${booking.memberName}, ${booking.bookingStatus}, payment=${booking.paymentStatus ?? "none"})`
      );
      for (const finding of booking.findings) {
        lines.push(`  ${finding.code}: ${finding.summary}`);
      }
      for (const action of booking.actions) {
        lines.push(`  action ${action.type}: ${action.status}${action.resultMessage ? ` - ${action.resultMessage}` : ""}`);
      }
    }
  }

  return lines.join("\n");
}
