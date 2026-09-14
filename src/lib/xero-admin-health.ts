import type { BookingStatus } from "@prisma/client";
import { bookingOwner } from "@/lib/booking-owner";
import { getXeroMemberGroupingSnapshot } from "@/lib/xero-member-grouping-resync";
import { prisma } from "@/lib/prisma";
import { resolveStripeCashRefundEvidence } from "@/lib/stripe-cash-refund-evidence";
import { getFailedXeroOperationOverview } from "@/lib/xero-admin-failures";
import { getTodaysXeroUsageSummary } from "@/lib/xero-api-usage";
import { getXeroContactLinkMismatchSnapshot } from "@/lib/xero-contact-link-mismatches";
import { sumCoveredRefundCreditNoteCents } from "@/lib/xero-sync";
import {
  STALE_PROCESSING_XERO_INBOUND_EVENT_MINUTES,
  STALE_RUNNING_XERO_OPERATION_MINUTES,
  countStaleProcessingXeroInboundEvents,
  countStaleRunningXeroOperations,
} from "@/lib/xero-stale-operations";

const MEMBERSHIP_SYNC_CURSOR_RESOURCE = "MEMBERSHIP_INVOICE_SYNC";

interface MissingXeroInvoiceBooking {
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

interface RefundMissingCreditNote {
  paymentId: string;
  bookingId: string;
  memberName: string;
  memberEmail: string;
  /** The aggregate settlement mirror (cash + account-credit dispositions). */
  refundedAmountCents: number;
  /**
   * Provider-backed Stripe CASH refund cents (#2902): succeeded PaymentRefund
   * rows, with the pre-ledger legacy fallback — never the raw mirror.
   */
  cashRefundedCents: number;
  // Cash-refunded cents not yet covered by any active refund credit note
  // (#1162, #2902).
  uncoveredCents: number;
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
  // #3369: the owner may be an Organisation; bookingOwner() reads both.
  organisation: { name: string; email: string | null } | null;
  payment: {
    id: string;
    xeroInvoiceId: string | null;
  };
}): MissingXeroInvoiceBooking {
  return {
    bookingId: input.id,
    paymentId: input.payment.id,
    memberId: bookingOwner(input).member.id ?? null,
    memberName: `${bookingOwner(input).member.firstName} ${bookingOwner(input).member.lastName}`,
    memberEmail: bookingOwner(input).member.email,
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
      // B5 (#2262): a manually settled booking (cash / off-Xero bank transfer)
      // is PAID with no invoice BY DESIGN, so it is not "missing" one. Listing
      // it here would invite an admin to mint an awaiting-payment invoice — and
      // email it to the member — for money the club already holds. Admin UX
      // only: the enforcement point is the enqueue choke fence.
      NOT: { payment: { manuallyMarkedPaidAt: { not: null } } },
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
      // #3369: the owner may be an Organisation; bookingOwner() reads both.
      organisation: { select: { name: true, email: true } },
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
 * (refundedAmountCents > 0), and has not changed for longer than the grace
 * window. Refunds can settle across several per-delta credit notes (#1162), so
 * rather than a single `xeroRefundCreditNoteId != null` check we compare the
 * refunded amount against the cents already covered by active refund credit
 * notes and flag only the still-uncovered remainder. This surfaces the "money
 * refunded but accounting follow-up failed" divergence the operator can't see.
 *
 * #2902 (INV-PAY-050): the amount compared against coverage is the
 * provider-backed CASH refund evidence (`resolveStripeCashRefundEvidence`),
 * never the raw `refundedAmountCents` mirror. The mirror also counts value
 * held as member account credit, so an account-credit-only cancellation used
 * to read as a missing Stripe cash refund here and the reconciliation
 * self-heal minted a fictitious refund note plus a Stripe-bank payment.
 * Account-credit-only payments now resolve to zero cash and are excluded.
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
          // #3369: the owner may be an Organisation; bookingOwner() reads both.
          organisation: { select: { name: true, email: true } },
        },
      },
    },
    orderBy: { updatedAt: "asc" },
  });

  const formatted: RefundMissingCreditNote[] = [];
  for (const payment of payments) {
    // #2902: cash evidence first — an account-credit-only cancellation
    // resolves to zero cash and is excluded before any coverage query runs.
    const evidence = await resolveStripeCashRefundEvidence(payment);
    if (evidence.cashRefundCents <= 0) {
      continue;
    }
    const coveredCents = await sumCoveredRefundCreditNoteCents(payment.id);
    if (evidence.cashRefundCents <= coveredCents) {
      continue;
    }
    formatted.push({
      paymentId: payment.id,
      bookingId: payment.bookingId,
      memberName:
        payment.booking && bookingOwner(payment.booking).member
        ? `${bookingOwner(payment.booking).member.firstName} ${bookingOwner(payment.booking).member.lastName}`
        : "Unknown",
      memberEmail: payment.booking
        ? (bookingOwner(payment.booking).member?.email ?? "")
        : "",
      refundedAmountCents: payment.refundedAmountCents,
      cashRefundedCents: evidence.cashRefundCents,
      uncoveredCents: evidence.cashRefundCents - coveredCents,
      refundedAt: payment.updatedAt.toISOString(),
    });
  }

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
    getXeroMemberGroupingSnapshot({ limit: 1 }),
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
      // Parity with the retired age-tier snapshot: information-only entries
      // (parked members in managed groups, never written to) count toward the
      // surfaced total so the operator still sees them.
      count:
        contactGroupMismatches.mismatchCount +
        contactGroupMismatches.informationalCount,
      cacheReady: contactGroupMismatches.cacheReady,
    },
    contactLinkMismatches: {
      count: contactLinkMismatches.count,
      cacheReady: contactLinkMismatches.cacheReady,
    },
    apiBudget: usageSummaryResult,
  };
}
