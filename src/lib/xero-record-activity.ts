import "server-only";

import { prisma } from "@/lib/prisma";
import { formatCents } from "@/lib/utils";
import { buildXeroObjectUrl } from "@/lib/xero-links";
import { getXeroOperationRetryMeta } from "@/lib/xero-operation-retry";
import { buildLocalAdminUrl, type XeroLocalModel } from "@/lib/xero-record-links";
import type {
  XeroRecordActivityData,
  XeroRecordActivityOperation,
  XeroRecordBackLink,
  XeroRecordObjectLink,
  XeroRecordReference,
} from "@/lib/xero-record-types";

interface XeroRecordScope {
  rootRecord: XeroRecordReference
  scopeRecords: XeroRecordReference[]
  relatedRecords: XeroRecordReference[]
  backLink: XeroRecordBackLink | null
}

function formatDisplayDate(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  return date.toLocaleDateString("en-NZ", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

function formatStatusLabel(value: string): string {
  return value.replace(/_/g, " ").toLowerCase().replace(/\b\w/g, (char) => char.toUpperCase());
}

function formatSeasonLabel(seasonYear: number): string {
  return `${seasonYear}/${seasonYear + 1}`;
}

function createRecordReference(
  localModel: string,
  localId: string,
  label: string,
  relation: string
): XeroRecordReference {
  return {
    localModel,
    localId,
    label,
    relation,
    url: buildLocalAdminUrl(localModel, localId),
  };
}

function dedupeRecordReferences(records: XeroRecordReference[]): XeroRecordReference[] {
  const seen = new Set<string>();
  return records.filter((record) => {
    const key = `${record.localModel}:${record.localId}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function getScopeWhere(records: XeroRecordReference[]) {
  return {
    OR: records.map((record) => ({
      localModel: record.localModel,
      localId: record.localId,
    })),
  };
}

async function getMemberScope(localId: string): Promise<XeroRecordScope | null> {
  const member = await prisma.member.findUnique({
    where: { id: localId },
    select: {
      id: true,
      firstName: true,
      lastName: true,
      subscriptions: {
        orderBy: { seasonYear: "desc" },
        select: {
          id: true,
          seasonYear: true,
          status: true,
        },
      },
    },
  });

  if (!member) {
    return null;
  }

  const rootRecord = createRecordReference(
    "Member",
    member.id,
    `${member.firstName} ${member.lastName}`,
    "Member"
  );
  const subscriptionRecords = member.subscriptions.map((subscription) =>
    createRecordReference(
      "MemberSubscription",
      subscription.id,
      `Subscription ${formatSeasonLabel(subscription.seasonYear)} (${formatStatusLabel(subscription.status)})`,
      "Subscription"
    )
  );

  return {
    rootRecord,
    scopeRecords: [rootRecord, ...subscriptionRecords],
    relatedRecords: [],
    backLink: {
      href: `/admin/members/${member.id}`,
      label: `Back to ${member.firstName} ${member.lastName}`,
    },
  };
}

async function getPaymentScope(localId: string): Promise<XeroRecordScope | null> {
  const payment = await prisma.payment.findUnique({
    where: { id: localId },
    select: {
      id: true,
      amountCents: true,
      booking: {
        select: {
          id: true,
          checkIn: true,
          checkOut: true,
          member: {
            select: {
              firstName: true,
              lastName: true,
            },
          },
        },
      },
    },
  });

  if (!payment) {
    return null;
  }

  const rootRecord = createRecordReference(
    "Payment",
    payment.id,
    `Payment ${formatCents(payment.amountCents)} for ${payment.booking.member.firstName} ${payment.booking.member.lastName}`,
    "Payment"
  );
  const relatedBooking = createRecordReference(
    "Booking",
    payment.booking.id,
    `Booking ${formatDisplayDate(payment.booking.checkIn)} - ${formatDisplayDate(payment.booking.checkOut)}`,
    "Booking"
  );

  return {
    rootRecord,
    scopeRecords: [rootRecord],
    relatedRecords: [relatedBooking],
    backLink: {
      href: "/admin/payments",
      label: "Back to Payments",
    },
  };
}

async function getBookingScope(localId: string): Promise<XeroRecordScope | null> {
  const booking = await prisma.booking.findUnique({
    where: { id: localId },
    select: {
      id: true,
      checkIn: true,
      checkOut: true,
      member: {
        select: {
          firstName: true,
          lastName: true,
        },
      },
      payment: {
        select: {
          id: true,
          amountCents: true,
        },
      },
      modifications: {
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          modificationType: true,
          priceDiffCents: true,
        },
      },
    },
  });

  if (!booking) {
    return null;
  }

  const rootRecord = createRecordReference(
    "Booking",
    booking.id,
    `${booking.member.firstName} ${booking.member.lastName} (${formatDisplayDate(booking.checkIn)} - ${formatDisplayDate(booking.checkOut)})`,
    "Booking"
  );
  const scopeRecords = [rootRecord];

  if (booking.payment) {
    scopeRecords.push(
      createRecordReference(
        "Payment",
        booking.payment.id,
        `Payment ${formatCents(booking.payment.amountCents)}`,
        "Payment"
      )
    );
  }

  for (const modification of booking.modifications) {
    const prefix = formatStatusLabel(modification.modificationType);
    const amount =
      modification.priceDiffCents === 0
        ? "No price change"
        : modification.priceDiffCents > 0
          ? `+${formatCents(modification.priceDiffCents)}`
          : formatCents(modification.priceDiffCents);

    scopeRecords.push(
      createRecordReference(
        "BookingModification",
        modification.id,
        `${prefix} (${amount})`,
        "Modification"
      )
    );
  }

  return {
    rootRecord,
    scopeRecords,
    relatedRecords: [],
    backLink: {
      href: "/admin/bookings",
      label: "Back to Bookings",
    },
  };
}

async function getBookingModificationScope(localId: string): Promise<XeroRecordScope | null> {
  const modification = await prisma.bookingModification.findUnique({
    where: { id: localId },
    select: {
      id: true,
      modificationType: true,
      priceDiffCents: true,
      booking: {
        select: {
          id: true,
          checkIn: true,
          checkOut: true,
          payment: {
            select: {
              id: true,
              amountCents: true,
            },
          },
        },
      },
    },
  });

  if (!modification) {
    return null;
  }

  const amount =
    modification.priceDiffCents === 0
      ? "No price change"
      : modification.priceDiffCents > 0
        ? `+${formatCents(modification.priceDiffCents)}`
        : formatCents(modification.priceDiffCents);

  const rootRecord = createRecordReference(
    "BookingModification",
    modification.id,
    `${formatStatusLabel(modification.modificationType)} (${amount})`,
    "Modification"
  );
  const relatedRecords = [
    createRecordReference(
      "Booking",
      modification.booking.id,
      `Booking ${formatDisplayDate(modification.booking.checkIn)} - ${formatDisplayDate(modification.booking.checkOut)}`,
      "Booking"
    ),
  ];

  if (modification.booking.payment) {
    relatedRecords.push(
      createRecordReference(
        "Payment",
        modification.booking.payment.id,
        `Payment ${formatCents(modification.booking.payment.amountCents)}`,
        "Payment"
      )
    );
  }

  return {
    rootRecord,
    scopeRecords: [rootRecord],
    relatedRecords,
    backLink: {
      href: buildLocalAdminUrl("Booking", modification.booking.id) ?? "/admin/bookings",
      label: "Back to Booking Activity",
    },
  };
}

async function getMemberSubscriptionScope(localId: string): Promise<XeroRecordScope | null> {
  const subscription = await prisma.memberSubscription.findUnique({
    where: { id: localId },
    select: {
      id: true,
      seasonYear: true,
      status: true,
      member: {
        select: {
          id: true,
          firstName: true,
          lastName: true,
        },
      },
    },
  });

  if (!subscription) {
    return null;
  }

  const rootRecord = createRecordReference(
    "MemberSubscription",
    subscription.id,
    `Subscription ${formatSeasonLabel(subscription.seasonYear)} (${formatStatusLabel(subscription.status)})`,
    "Subscription"
  );
  const relatedMember = createRecordReference(
    "Member",
    subscription.member.id,
    `${subscription.member.firstName} ${subscription.member.lastName}`,
    "Member"
  );

  return {
    rootRecord,
    scopeRecords: [rootRecord],
    relatedRecords: [relatedMember],
    backLink: {
      href: `/admin/members/${subscription.member.id}`,
      label: `Back to ${subscription.member.firstName} ${subscription.member.lastName}`,
    },
  };
}

async function getXeroRecordScope(localModel: XeroLocalModel, localId: string): Promise<XeroRecordScope | null> {
  switch (localModel) {
    case "Member":
      return getMemberScope(localId);
    case "Payment":
      return getPaymentScope(localId);
    case "Booking":
      return getBookingScope(localId);
    case "BookingModification":
      return getBookingModificationScope(localId);
    case "MemberSubscription":
      return getMemberSubscriptionScope(localId);
    default:
      return null;
  }
}

function toIsoString(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

export async function getXeroRecordActivity(
  localModel: XeroLocalModel,
  localId: string,
  limit = 25
): Promise<XeroRecordActivityData | null> {
  const scope = await getXeroRecordScope(localModel, localId);
  if (!scope) {
    return null;
  }

  const scopeRecords = dedupeRecordReferences(scope.scopeRecords);
  const scopeLookup = new Map(
    scopeRecords.map((record) => [`${record.localModel}:${record.localId}`, record])
  );
  const where = getScopeWhere(scopeRecords);

  const [operations, operationCount, operationStatusCounts, links] = await Promise.all([
    prisma.xeroSyncOperation.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: limit,
    }),
    prisma.xeroSyncOperation.count({ where }),
    prisma.xeroSyncOperation.groupBy({
      by: ["status"],
      where,
      _count: true,
    }),
    prisma.xeroObjectLink.findMany({
      where,
      orderBy: { createdAt: "desc" },
    }),
  ]);

  const summaryCounts = new Map(
    operationStatusCounts.map((item) => [item.status, item._count])
  );

  const mappedOperations: XeroRecordActivityOperation[] = operations.map((operation) => {
    const retryMeta = getXeroOperationRetryMeta(operation);
    const scopeRecord =
      operation.localModel && operation.localId
        ? scopeLookup.get(`${operation.localModel}:${operation.localId}`)
        : null;

    return {
      id: operation.id,
      direction: operation.direction,
      entityType: operation.entityType,
      operationType: operation.operationType,
      localModel: operation.localModel,
      localId: operation.localId,
      localUrl: buildLocalAdminUrl(operation.localModel, operation.localId),
      localLabel: scopeRecord?.label ?? null,
      status: operation.status,
      idempotencyKey: operation.idempotencyKey,
      correlationKey: operation.correlationKey,
      attemptCount: operation.attemptCount,
      replayable: operation.replayable,
      lastErrorCode: operation.lastErrorCode,
      lastErrorMessage: operation.lastErrorMessage,
      requestPayload: operation.requestPayload,
      responsePayload: operation.responsePayload,
      xeroObjectType: operation.xeroObjectType,
      xeroObjectId: operation.xeroObjectId,
      xeroObjectNumber: operation.xeroObjectNumber,
      xeroObjectUrl:
        operation.xeroObjectUrl ??
        (operation.xeroObjectType && operation.xeroObjectId
          ? buildXeroObjectUrl(operation.xeroObjectType, operation.xeroObjectId)
          : null),
      createdByMemberId: operation.createdByMemberId,
      startedAt: toIsoString(operation.startedAt),
      completedAt: toIsoString(operation.completedAt),
      createdAt: operation.createdAt.toISOString(),
      updatedAt: operation.updatedAt.toISOString(),
      supported: retryMeta.supported,
      reason: retryMeta.reason,
    };
  });

  const mappedLinks: XeroRecordObjectLink[] = links
    .map((link) => {
      const scopeRecord = scopeLookup.get(`${link.localModel}:${link.localId}`);

      return {
        id: link.id,
        localModel: link.localModel,
        localId: link.localId,
        localUrl: buildLocalAdminUrl(link.localModel, link.localId),
        localLabel: scopeRecord?.label ?? null,
        xeroObjectType: link.xeroObjectType,
        xeroObjectId: link.xeroObjectId,
        xeroObjectNumber: link.xeroObjectNumber,
        xeroObjectUrl: link.xeroObjectUrl ?? buildXeroObjectUrl(link.xeroObjectType, link.xeroObjectId),
        role: link.role,
        active: link.active,
        metadata: link.metadata,
        createdAt: link.createdAt.toISOString(),
        updatedAt: link.updatedAt.toISOString(),
      };
    })
    .sort((left, right) => {
      if (left.active !== right.active) {
        return left.active ? -1 : 1;
      }
      return new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime();
    });

  return {
    rootRecord: scope.rootRecord,
    scopeRecords,
    relatedRecords: dedupeRecordReferences(scope.relatedRecords),
    summary: {
      totalOperations: operationCount,
      failedOperations: summaryCounts.get("FAILED") ?? 0,
      pendingOperations: (summaryCounts.get("PENDING") ?? 0) + (summaryCounts.get("RUNNING") ?? 0),
      partialOperations: summaryCounts.get("PARTIAL") ?? 0,
      activeLinks: mappedLinks.filter((link) => link.active).length,
    },
    operations: mappedOperations,
    links: mappedLinks,
    backLink: scope.backLink,
  };
}
