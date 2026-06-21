import type { BookingStatus } from "@prisma/client";
import { getXeroContactGroupMismatchSnapshot } from "@/lib/age-tier-xero-groups";
import { prisma } from "@/lib/prisma";
import { getFailedXeroOperationOverview } from "@/lib/xero-admin-failures";
import { getTodaysXeroUsageSummary } from "@/lib/xero-api-usage";
import { getXeroContactLinkMismatchSnapshot } from "@/lib/xero-contact-link-mismatches";
import {
  STALE_PROCESSING_XERO_INBOUND_EVENT_MINUTES,
  STALE_RUNNING_XERO_OPERATION_MINUTES,
  countStaleProcessingXeroInboundEvents,
  countStaleRunningXeroOperations,
} from "@/lib/xero-stale-operations";

const MEMBERSHIP_SYNC_CURSOR_RESOURCE = "MEMBERSHIP_INVOICE_SYNC";

export interface MissingXeroInvoiceBooking {
  bookingId: string;
  paymentId: string;
  memberId: string;
  memberName: string;
  memberEmail: string;
  status: "PAID";
  checkIn: string;
  checkOut: string;
  createdAt: string;
  hasLinkedInvoice: boolean;
}

export interface MissingXeroInvoicesSnapshot {
  count: number;
  bookings: MissingXeroInvoiceBooking[];
}

// Issue #818: a Stripe refund moves money immediately, but the matching Xero
// refund credit note is created best-effort after the fact. Once an invoiced,
// refunded payment has gone this long without xeroRefundCreditNoteId being set,
// the accounting follow-up has almost certainly failed/been dropped rather than
// still being in flight, so it should be surfaced as a local↔Xero divergence.
export const REFUND_CREDIT_NOTE_GRACE_HOURS = 24;

export interface RefundMissingCreditNote {
  paymentId: string;
  bookingId: string;
  memberName: string;
  memberEmail: string;
  refundedAmountCents: number;
  refundedAt: string;
}

export interface RefundsMissingCreditNotesSnapshot {
  count: number;
  payments: RefundMissingCreditNote[];
}

export interface XeroAdminHealthSnapshot {
  unlinkedMembers: {
    count: number;
    href: string;
  };
  failedOperations: {
    count: number;
    legacyCount: number;
  };
  pendingOperations: {
    count: number;
  };
  staleRunningOperations: {
    count: number;
    thresholdMinutes: number;
  };
  staleProcessingInboundEvents: {
    count: number;
    thresholdMinutes: number;
  };
  lastMembershipRefresh: {
    at: string | null;
    lastCronStatus: string | null;
    lastCronStartedAt: string | null;
  };
  missingInvoices: {
    count: number;
  };
  refundsMissingCreditNotes: {
    count: number;
    graceHours: number;
  };
  contactGroupMismatches: {
    count: number;
    cacheReady: boolean;
  };
  contactLinkMismatches: {
    count: number;
    cacheReady: boolean;
  };
  apiBudget: {
    status: "healthy" | "warning" | "critical" | "exhausted" | "unknown";
    usagePercent: number | null;
    totalCalls: number | null;
    failedCalls: number | null;
  };
}

function formatBookingSnapshot(input: {
  id: string;
  createdAt: Date;
  checkIn: Date;
  checkOut: Date;
  status: BookingStatus;
  member: {
    id: string;
    firstName: string;
    lastName: string;
    email: string;
  };
  payment: {
    id: string;
    xeroInvoiceId: string | null;
  };
}): MissingXeroInvoiceBooking {
  return {
    bookingId: input.id,
    paymentId: input.payment.id,
    memberId: input.member.id,
    memberName: `${input.member.firstName} ${input.member.lastName}`,
    memberEmail: input.member.email,
    status: input.status as "PAID",
    checkIn: input.checkIn.toISOString(),
    checkOut: input.checkOut.toISOString(),
    createdAt: input.createdAt.toISOString(),
    hasLinkedInvoice: Boolean(input.payment.xeroInvoiceId),
  };
}

export async function getMissingXeroInvoiceBookings(options?: {
  limit?: number;
}): Promise<MissingXeroInvoicesSnapshot> {
  const candidates = await prisma.booking.findMany({
    where: {
      status: "PAID",
      payment: { isNot: null },
    },
    select: {
      id: true,
      createdAt: true,
      checkIn: true,
      checkOut: true,
      status: true,
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
          xeroInvoiceId: true,
        },
      },
    },
    orderBy: [{ checkIn: "desc" }, { createdAt: "desc" }],
  });

  const paymentIds = candidates
    .map((booking) => booking.payment?.id)
    .filter((paymentId): paymentId is string => Boolean(paymentId));

  if (paymentIds.length === 0) {
    return { count: 0, bookings: [] };
  }

  const succeededInvoiceOperations = await prisma.xeroSyncOperation.findMany({
    where: {
      entityType: "INVOICE",
      status: "SUCCEEDED",
      localModel: "Payment",
      localId: { in: paymentIds },
    },
    select: {
      localId: true,
    },
  });

  const succeededPaymentIds = new Set(
    succeededInvoiceOperations
      .map((operation) => operation.localId)
      .filter((localId): localId is string => Boolean(localId))
  );

  const missingBookings = candidates.flatMap((booking) => {
    if (!booking.payment?.id || succeededPaymentIds.has(booking.payment.id)) {
      return [];
    }

    return [
      booking as typeof booking & {
        payment: { id: string; xeroInvoiceId: string | null };
      },
    ];
  });

  return {
    count: missingBookings.length,
    bookings: (typeof options?.limit === "number"
      ? missingBookings.slice(0, Math.max(1, options.limit))
      : missingBookings
    ).map(formatBookingSnapshot),
  };
}

/**
 * Issue #818: detect refunds whose Xero credit-note follow-up never completed.
 * Local-only signal (no live Xero calls): a Stripe-source payment that was
 * invoiced (xeroInvoiceId set, so a credit note is expected), has been refunded
 * (refundedAmountCents > 0), still has no xeroRefundCreditNoteId, and has not
 * changed for longer than the grace window. This surfaces the "money refunded
 * but accounting follow-up failed" divergence the operator otherwise can't see.
 */
export async function getRefundsMissingXeroCreditNotes(options?: {
  limit?: number;
  now?: Date;
}): Promise<RefundsMissingCreditNotesSnapshot> {
  const now = options?.now ?? new Date();
  const graceThreshold = new Date(
    now.getTime() - REFUND_CREDIT_NOTE_GRACE_HOURS * 60 * 60 * 1000,
  );

  const payments = await prisma.payment.findMany({
    where: {
      source: "STRIPE",
      refundedAmountCents: { gt: 0 },
      xeroRefundCreditNoteId: null,
      xeroInvoiceId: { not: null },
      updatedAt: { lt: graceThreshold },
    },
    select: {
      id: true,
      bookingId: true,
      refundedAmountCents: true,
      updatedAt: true,
      booking: {
        select: {
          member: {
            select: { firstName: true, lastName: true, email: true },
          },
        },
      },
    },
    orderBy: { updatedAt: "asc" },
  });

  const formatted: RefundMissingCreditNote[] = payments.map((payment) => ({
    paymentId: payment.id,
    bookingId: payment.bookingId,
    memberName: payment.booking?.member
      ? `${payment.booking.member.firstName} ${payment.booking.member.lastName}`
      : "Unknown",
    memberEmail: payment.booking?.member?.email ?? "",
    refundedAmountCents: payment.refundedAmountCents,
    refundedAt: payment.updatedAt.toISOString(),
  }));

  return {
    count: formatted.length,
    payments:
      typeof options?.limit === "number"
        ? formatted.slice(0, Math.max(1, options.limit))
        : formatted,
  };
}

export async function getXeroAdminHealthSnapshot(): Promise<XeroAdminHealthSnapshot> {
  const [
    unlinkedMemberCount,
    failedOperationOverview,
    pendingOperationCount,
    staleRunningOperationCount,
    staleProcessingInboundEventCount,
    latestMembershipCursor,
    latestMembershipCron,
    missingInvoices,
    refundsMissingCreditNotes,
    contactGroupMismatches,
    contactLinkMismatches,
    usageSummaryResult,
  ] = await Promise.all([
    prisma.member.count({
      where: {
        active: true,
        xeroContactId: null,
      },
    }),
    getFailedXeroOperationOverview(),
    prisma.xeroSyncOperation.count({
      where: { status: "PENDING" },
    }),
    countStaleRunningXeroOperations(),
    countStaleProcessingXeroInboundEvents(),
    prisma.xeroSyncCursor.findFirst({
      where: {
        resourceType: MEMBERSHIP_SYNC_CURSOR_RESOURCE,
        lastSuccessfulSyncAt: { not: null },
      },
      orderBy: { lastSuccessfulSyncAt: "desc" },
      select: {
        lastSuccessfulSyncAt: true,
      },
    }),
    prisma.cronJobRun.findFirst({
      where: {
        jobName: "xero-membership-refresh",
      },
      orderBy: { startedAt: "desc" },
      select: {
        startedAt: true,
        status: true,
      },
    }),
    getMissingXeroInvoiceBookings({ limit: 1 }),
    getRefundsMissingXeroCreditNotes({ limit: 1 }),
    getXeroContactGroupMismatchSnapshot({ limit: 1 }),
    getXeroContactLinkMismatchSnapshot({ limit: 1 }),
    getTodaysXeroUsageSummary()
      .then((summary) => ({
        status: summary.today.budgetStatus,
        usagePercent: summary.today.usagePercent,
        totalCalls: summary.today.totalCalls,
        failedCalls: summary.today.failedCalls,
      }))
      .catch(() => ({
        status: "unknown" as const,
        usagePercent: null,
        totalCalls: null,
        failedCalls: null,
      })),
  ]);

  return {
    unlinkedMembers: {
      count: unlinkedMemberCount,
      href: "/admin/members?active=true&xeroLinked=false",
    },
    failedOperations: {
      count: failedOperationOverview.activeFailedCount,
      legacyCount: failedOperationOverview.legacyFailedCount,
    },
    pendingOperations: {
      count: pendingOperationCount,
    },
    staleRunningOperations: {
      count: staleRunningOperationCount,
      thresholdMinutes: STALE_RUNNING_XERO_OPERATION_MINUTES,
    },
    staleProcessingInboundEvents: {
      count: staleProcessingInboundEventCount,
      thresholdMinutes: STALE_PROCESSING_XERO_INBOUND_EVENT_MINUTES,
    },
    lastMembershipRefresh: {
      at: latestMembershipCursor?.lastSuccessfulSyncAt?.toISOString() ?? null,
      lastCronStatus: latestMembershipCron?.status ?? null,
      lastCronStartedAt: latestMembershipCron?.startedAt?.toISOString() ?? null,
    },
    missingInvoices: {
      count: missingInvoices.count,
    },
    refundsMissingCreditNotes: {
      count: refundsMissingCreditNotes.count,
      graceHours: REFUND_CREDIT_NOTE_GRACE_HOURS,
    },
    contactGroupMismatches: {
      count: contactGroupMismatches.count,
      cacheReady: contactGroupMismatches.cacheReady,
    },
    contactLinkMismatches: {
      count: contactLinkMismatches.count,
      cacheReady: contactLinkMismatches.cacheReady,
    },
    apiBudget: usageSummaryResult,
  };
}
