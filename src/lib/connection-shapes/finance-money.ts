/**
 * What each Finance officer action on payments, credits, refunds,
 * subscriptions and reports returns (ALP-721, `INV-MCP-006`): the one place a
 * catalogue entry's `returns` and its route's projection both read
 * (`INV-SSOT`). Money is integer cents.
 *
 * An officer's connection sends what it reads to the officer's AI provider,
 * so each shape keeps what the officer needs to answer a question about the
 * money and leaves out contact details, card and provider identifiers and
 * free text the screen does not need. Types only: nothing here reaches the
 * database.
 */
import { connectionShapeFor, eachEntry } from "@/lib/connection-projection";
import type { FinanceBookingMetricsResult } from "@/lib/finance-booking-metrics";
import type { FinanceSyncDiagnosticsStatus } from "@/lib/finance-sync-diagnostics";
import type { FinanceSyncExecutionResult } from "@/lib/finance-sync-service";

/** `GET /api/admin/payments`: one page of payments and the filtered totals. */
export const ADMIN_PAYMENTS_CONNECTION_SHAPE = connectionShapeFor<{
  data: Array<{
    id: string;
    bookingId: string;
    amountCents: number;
    source: string;
    reference: string | null;
    status: string;
    xeroInvoiceNumber: string | null;
    refundedAmountCents: number;
    additionalAmountCents: number;
    additionalPaymentStatus: string | null;
    lastUpdatedAt: Date;
    xeroState: string;
    settlementKind: string;
    booking: {
      id: string;
      status: string;
      checkIn: Date;
      checkOut: Date;
      member: { id: string; firstName: string; lastName: string } | null;
      organisation: { name: string } | null;
    };
  }>;
  total: number;
  page: number;
  pageSize: number;
  summary: {
    netCollectedCents: number;
    refundsOwedCents: number;
    creditsOwedCents: number;
    refundedCents: number;
    count: number;
    additionalLedgerGapCents: number;
    additionalLedgerGapBookings: number;
  };
}>({
  data: {
    id: true,
    bookingId: true,
    amountCents: true,
    source: true,
    reference: true,
    status: true,
    xeroInvoiceNumber: true,
    refundedAmountCents: true,
    additionalAmountCents: true,
    additionalPaymentStatus: true,
    lastUpdatedAt: true,
    xeroState: true,
    settlementKind: true,
    booking: {
      id: true,
      status: true,
      checkIn: true,
      checkOut: true,
      member: { id: true, firstName: true, lastName: true },
      organisation: { name: true },
    },
  },
  total: true,
  page: true,
  pageSize: true,
  summary: {
    netCollectedCents: true,
    refundsOwedCents: true,
    creditsOwedCents: true,
    refundedCents: true,
    count: true,
    additionalLedgerGapCents: true,
    additionalLedgerGapBookings: true,
  },
});

/** `POST /api/admin/members/[id]/credits`: the request waiting for a second officer. */
export const CREDIT_ADJUSTMENT_REQUESTED_CONNECTION_SHAPE = connectionShapeFor<{
  success: boolean;
  requestId: string;
  requestStatus: string;
  replayed: boolean;
  message: string;
}>({
  success: true,
  requestId: true,
  requestStatus: true,
  replayed: true,
  message: true,
});

/** A member as an officer's credit screens name them: no contact details. */
type CreditPerson = { id: string; firstName: string; lastName: string };

/**
 * `GET /api/admin/credit-approvals`: the credit adjustment requests in the
 * review queue. A connection is answered `{ requests }`; the browser keeps
 * the bare list.
 */
export const CREDIT_APPROVALS_CONNECTION_SHAPE = connectionShapeFor<{
  requests: Array<{
    id: string;
    memberId: string;
    amountCents: number;
    description: string;
    grantAccount: string | null;
    status: string;
    requestedById: string;
    reviewedById: string | null;
    reviewedAt: Date | null;
    createdAt: Date;
    member: CreditPerson;
    requestedBy: CreditPerson;
    reviewedBy: CreditPerson | null;
    approvedCredit: { id: string; createdAt: Date } | null;
  }>;
}>({
  requests: {
    id: true,
    memberId: true,
    amountCents: true,
    description: true,
    grantAccount: true,
    status: true,
    requestedById: true,
    reviewedById: true,
    reviewedAt: true,
    createdAt: true,
    member: { id: true, firstName: true, lastName: true },
    requestedBy: { id: true, firstName: true, lastName: true },
    reviewedBy: { id: true, firstName: true, lastName: true },
    approvedCredit: { id: true, createdAt: true },
  },
});

type CreditBookingStay = { id: string; checkIn: Date; checkOut: Date };

/** `GET /api/admin/members/[id]/credits`: one member's balance, ledger and pending requests. */
export const MEMBER_CREDITS_CONNECTION_SHAPE = connectionShapeFor<{
  balanceCents: number;
  history: Array<{
    id: string;
    amountCents: number;
    type: string;
    description: string;
    createdAt: Date;
    sourceBooking: CreditBookingStay | null;
    appliedToBooking: CreditBookingStay | null;
    requestedBy: CreditPerson | null;
    approvedBy: CreditPerson | null;
    approvalRequest: { createdAt: Date; reviewedAt: Date | null } | null;
  }>;
  pendingRequests: Array<{
    id: string;
    amountCents: number;
    description: string;
    grantAccount: string | null;
    status: string;
    requestedById: string;
    createdAt: Date;
    requestedBy: CreditPerson;
  }>;
}>({
  balanceCents: true,
  history: {
    id: true,
    amountCents: true,
    type: true,
    description: true,
    createdAt: true,
    sourceBooking: { id: true, checkIn: true, checkOut: true },
    appliedToBooking: { id: true, checkIn: true, checkOut: true },
    requestedBy: { id: true, firstName: true, lastName: true },
    approvedBy: { id: true, firstName: true, lastName: true },
    approvalRequest: { createdAt: true, reviewedAt: true },
  },
  pendingRequests: {
    id: true,
    amountCents: true,
    description: true,
    grantAccount: true,
    status: true,
    requestedById: true,
    createdAt: true,
    requestedBy: { id: true, firstName: true, lastName: true },
  },
});

/** `PATCH /api/admin/members/[id]/credits/[requestId]`: the decision and the member's balance after it. */
export const CREDIT_ADJUSTMENT_REVIEWED_CONNECTION_SHAPE = connectionShapeFor<{
  success: boolean;
  balanceCents: number;
  message: string;
}>({
  success: true,
  balanceCents: true,
  message: true,
});

/** `GET /api/admin/opening-credits`: the opening-credit batches posted so far, newest first. */
export const OPENING_CREDIT_BATCHES_CONNECTION_SHAPE = connectionShapeFor<{
  batches: Array<{
    id: string;
    totalCents: number;
    rowCount: number;
    postedAt: string;
    reversedAt: string | null;
    reversalReason: string | null;
    postedBy: string | null;
    reversedBy: string | null;
  }>;
}>({
  batches: {
    id: true,
    totalCents: true,
    rowCount: true,
    postedAt: true,
    reversedAt: true,
    reversalReason: true,
    postedBy: true,
    reversedBy: true,
  },
});

/**
 * `POST /api/admin/payments/[id]/generate-invoice`: the invoice raised, or
 * queued for the Xero outbox. Xero's own invoice id stays behind; its number
 * is what an officer quotes.
 */
export const PAYMENT_INVOICE_GENERATED_CONNECTION_SHAPE = connectionShapeFor<{
  status: "generated" | "queued";
  xeroInvoiceNumber: string | null;
  queueOperationId: string | null;
  message: string;
}>({
  status: true,
  xeroInvoiceNumber: true,
  queueOperationId: true,
  message: true,
});

/** `POST /api/admin/payments/bank-refund-voids/[id]/answered`: the payment and booking the answered note was on. */
export const BANK_REFUND_VOID_ANSWERED_CONNECTION_SHAPE = connectionShapeFor<{
  success: boolean;
  paymentId: string;
  bookingId: string;
}>({
  success: true,
  paymentId: true,
  bookingId: true,
});

/**
 * `GET /api/admin/payments/manual-refund-tasks`: the money the club owes back
 * by hand, the late captures Stripe refunded itself, and the tasks dismissed
 * lately. The screen's link flags (`viewerCanViewBookings`,
 * `viewerOwnsBooking`) stay behind.
 */
export const MANUAL_REFUND_TASKS_CONNECTION_SHAPE = connectionShapeFor<{
  tasks: Array<{
    id: string;
    bookingId: string;
    amountCents: number | null;
    raisedAmountCents: number | null;
    kind: string | null;
    awaitingLateCaptureApproval: boolean;
    partPaymentReview: boolean;
    editRefundHandBack: boolean;
    refundRequestHandBack: boolean;
    paidToGroupOrganiser: boolean;
    groupOrganiserHandBack: boolean;
    journalHandBackDismissRefusal: string | null;
    disputedHandBackLost: boolean;
    disputeReduction: { reducedByCents: number; stillOwedCents: number } | null;
    markPaidRefusal: string | null;
    cardShortfallHandBack: boolean;
    cardShortfallCheck: boolean;
    bankRefundVoidFollowUp: { voidedCreditNoteNumber: string | null; voidedAt: string } | null;
    partPaymentReviewXeroPaid: { reportedAt: string; cashCents: number } | null;
    reason: string;
    createdAt: string;
    memberName: string;
    checkIn: string;
    checkOut: string;
  }>;
  autoRefundedUnavailable: boolean;
  autoRefunded: Array<{
    id: string;
    bookingId: string;
    amountCents: number | null;
    reason: string;
    note: string | null;
    refundedAt: string | null;
    bookingDeleted: boolean;
    memberName: string;
    checkIn: string;
    checkOut: string;
  }>;
  dismissedUnavailable: boolean;
  dismissed: Array<{
    id: string;
    bookingId: string;
    amountCents: number | null;
    kind: string | null;
    reason: string;
    note: string | null;
    dismissedAt: string | null;
    bookingDeleted: boolean;
    memberName: string;
    checkIn: string;
    checkOut: string;
  }>;
}>({
  tasks: {
    id: true,
    bookingId: true,
    amountCents: true,
    raisedAmountCents: true,
    kind: true,
    awaitingLateCaptureApproval: true,
    partPaymentReview: true,
    editRefundHandBack: true,
    refundRequestHandBack: true,
    paidToGroupOrganiser: true,
    groupOrganiserHandBack: true,
    journalHandBackDismissRefusal: true,
    disputedHandBackLost: true,
    disputeReduction: { reducedByCents: true, stillOwedCents: true },
    markPaidRefusal: true,
    cardShortfallHandBack: true,
    cardShortfallCheck: true,
    bankRefundVoidFollowUp: { voidedCreditNoteNumber: true, voidedAt: true },
    partPaymentReviewXeroPaid: { reportedAt: true, cashCents: true },
    reason: true,
    createdAt: true,
    memberName: true,
    checkIn: true,
    checkOut: true,
  },
  autoRefundedUnavailable: true,
  autoRefunded: {
    id: true,
    bookingId: true,
    amountCents: true,
    reason: true,
    note: true,
    refundedAt: true,
    bookingDeleted: true,
    memberName: true,
    checkIn: true,
    checkOut: true,
  },
  dismissedUnavailable: true,
  dismissed: {
    id: true,
    bookingId: true,
    amountCents: true,
    kind: true,
    reason: true,
    note: true,
    dismissedAt: true,
    bookingDeleted: true,
    memberName: true,
    checkIn: true,
    checkOut: true,
  },
});

/**
 * `GET /api/admin/refund-requests`: one page of refund appeals, with each
 * booking's payment and the most an approval can give back. The requester's
 * email, the Stripe payment id and the booking's email switch stay behind.
 */
export const REFUND_REQUESTS_CONNECTION_SHAPE = connectionShapeFor<{
  data: Array<{
    id: string;
    bookingId: string;
    memberId: string;
    reason: string;
    requestedAmountCents: number | null;
    status: string;
    adminNotes: string | null;
    approvedAmountCents: number | null;
    reviewedBy: string | null;
    reviewedAt: Date | null;
    createdAt: Date;
    cardRefundState: string;
    cardRefundOwedCents: number;
    cardRefundRefusedCents: number;
    cardRefundUnansweredCents: number;
    handBackOwedCents: number;
    handBackDismissedCents: number;
    cardRefundClosedUnpaidCents: number;
    member: { id: string; firstName: string; lastName: string };
    booking: {
      id: string;
      checkIn: Date;
      checkOut: Date;
      finalPriceCents: number;
      status: string;
      organiserSettled: boolean;
      parentBookingId: string | null;
      creditsFromCancellation: Array<{ amountCents: number; description: string; type: string }>;
      payment: {
        id: string;
        source: string;
        status: string;
        amountCents: number;
        refundedAmountCents: number;
      } | null;
      appealCeilingCents: number;
      appealCardRefundOwedCents: number;
      organiserCardMaxRefundableCents: number;
      organiserCardCombinedRefundPending: boolean;
    };
  }>;
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}>({
  data: {
    id: true,
    bookingId: true,
    memberId: true,
    reason: true,
    requestedAmountCents: true,
    status: true,
    adminNotes: true,
    approvedAmountCents: true,
    reviewedBy: true,
    reviewedAt: true,
    createdAt: true,
    cardRefundState: true,
    cardRefundOwedCents: true,
    cardRefundRefusedCents: true,
    cardRefundUnansweredCents: true,
    handBackOwedCents: true,
    handBackDismissedCents: true,
    cardRefundClosedUnpaidCents: true,
    member: { id: true, firstName: true, lastName: true },
    booking: {
      id: true,
      checkIn: true,
      checkOut: true,
      finalPriceCents: true,
      status: true,
      organiserSettled: true,
      parentBookingId: true,
      creditsFromCancellation: { amountCents: true, description: true, type: true },
      payment: { id: true, source: true, status: true, amountCents: true, refundedAmountCents: true },
      appealCeilingCents: true,
      appealCardRefundOwedCents: true,
      organiserCardMaxRefundableCents: true,
      organiserCardCombinedRefundPending: true,
    },
  },
  page: true,
  pageSize: true,
  total: true,
  totalPages: true,
});

/** `GET /api/admin/reports`: the report window's bookings, money, members and occupancy figures. */
export const ADMIN_REPORTS_CONNECTION_SHAPE = connectionShapeFor<{
  summary: {
    totalBookings: number;
    moneyReconciliation: {
      totalBookings: number;
      byState: { RECONCILED: number; UNRECONCILED: number };
      byReason: Record<string, number>;
    };
    totalRevenueCents: number;
    netCollectedCents: number;
    refundsOwedCents: number;
    creditsOwedCents: number;
    additionalLedgerGapCents: number;
    additionalLedgerGapBookings: number;
    outstandingAdditionalCents: number;
    outstandingAdditionalBookings: number;
    totalGuests: number;
    avgOccupancyRate: number;
    memberGuests: number;
    nonMemberGuests: number;
  };
  statusBreakdown: {
    pending: number;
    paymentPending: number;
    confirmed: number;
    paid: number;
    awaitingReview: number;
    completed: number;
  };
  memberStats: {
    totalActiveMembers: number;
    paidMembers: number;
    unpaidMembers: number;
    overdueMembers: number;
    newMembers: number;
    currentSeasonYear: number;
    currentSeasonLabel: string;
  };
  occupancy: Array<{ date: string; occupiedBeds: number; availableBeds: number; occupancyRate: number }>;
  revenueGranularity: string;
  revenue: Array<{
    periodStart: string;
    periodEnd: string;
    label: string;
    tooltipLabel: string;
    revenueCents: number;
    bookingCount: number;
  }>;
  trends: Array<{
    week: string;
    total: number;
    pending: number;
    paymentPending: number;
    confirmed: number;
    paid: number;
    awaitingReview: number;
    completed: number;
  }>;
}>({
  summary: {
    totalBookings: true,
    moneyReconciliation: {
      totalBookings: true,
      byState: { RECONCILED: true, UNRECONCILED: true },
      byReason: eachEntry(true),
    },
    totalRevenueCents: true,
    netCollectedCents: true,
    refundsOwedCents: true,
    creditsOwedCents: true,
    additionalLedgerGapCents: true,
    additionalLedgerGapBookings: true,
    outstandingAdditionalCents: true,
    outstandingAdditionalBookings: true,
    totalGuests: true,
    avgOccupancyRate: true,
    memberGuests: true,
    nonMemberGuests: true,
  },
  statusBreakdown: {
    pending: true,
    paymentPending: true,
    confirmed: true,
    paid: true,
    awaitingReview: true,
    completed: true,
  },
  memberStats: {
    totalActiveMembers: true,
    paidMembers: true,
    unpaidMembers: true,
    overdueMembers: true,
    newMembers: true,
    currentSeasonYear: true,
    currentSeasonLabel: true,
  },
  occupancy: { date: true, occupiedBeds: true, availableBeds: true, occupancyRate: true },
  revenueGranularity: true,
  revenue: {
    periodStart: true,
    periodEnd: true,
    label: true,
    tooltipLabel: true,
    revenueCents: true,
    bookingCount: true,
  },
  trends: {
    week: true,
    total: true,
    pending: true,
    paymentPending: true,
    confirmed: true,
    paid: true,
    awaitingReview: true,
    completed: true,
  },
});

/**
 * `GET /api/admin/subscriptions`: one page of the season's member
 * subscriptions and the status counts. Email addresses, the member's Xero
 * contact id, the Xero invoice id and the Xero contact group ids stay behind;
 * the invoice number and the group names are what an officer reads.
 */
export const ADMIN_SUBSCRIPTIONS_CONNECTION_SHAPE = connectionShapeFor<{
  data: Array<{
    id: string;
    memberId: string;
    seasonYear: number;
    status: string;
    xeroInvoiceNumber: string | null;
    paidAt: Date | null;
    manuallyMarkedPaidAt: Date | null;
    manualPaymentNote: string | null;
    xeroContactGroupsLoaded: boolean;
    xeroContactGroups: Array<{ id: string; name: string }>;
    member: { firstName: string; lastName: string; ageTier: string; role: string };
  }>;
  total: number;
  page: number;
  pageSize: number;
  summary: {
    total: number;
    paid: number;
    unpaid: number;
    overdue: number;
    notInvoiced: number;
    notRequired: number;
  };
  xeroContactGroupsLoaded: boolean;
}>({
  data: {
    id: true,
    memberId: true,
    seasonYear: true,
    status: true,
    xeroInvoiceNumber: true,
    paidAt: true,
    manuallyMarkedPaidAt: true,
    manualPaymentNote: true,
    xeroContactGroupsLoaded: true,
    xeroContactGroups: { name: true },
    member: { firstName: true, lastName: true, ageTier: true, role: true },
  },
  total: true,
  page: true,
  pageSize: true,
  summary: {
    total: true,
    paid: true,
    unpaid: true,
    overdue: true,
    notInvoiced: true,
    notRequired: true,
  },
  xeroContactGroupsLoaded: true,
});

/** `POST /api/admin/subscriptions/[id]/manual-payment`: the subscription afterwards and what became of the receipt. */
export const MANUAL_SUBSCRIPTION_PAYMENT_CONNECTION_SHAPE = connectionShapeFor<{
  success: boolean;
  subscription: {
    id: string;
    memberId: string;
    seasonYear: number;
    status: string;
    direction: string;
    memberNotified: boolean;
    receipt: string;
  };
  message: string;
}>({
  success: true,
  subscription: {
    id: true,
    memberId: true,
    seasonYear: true,
    status: true,
    direction: true,
    memberNotified: true,
    receipt: true,
  },
  message: true,
});

/** `POST /api/admin/bookings/[id]/mark-paid`: the settlement recorded or reversed, in integer cents. */
export const MANUAL_BOOKING_PAYMENT_CONNECTION_SHAPE = connectionShapeFor<{
  success: boolean;
  booking: {
    bookingId: string;
    paymentId: string;
    direction: string;
    memberNotified: boolean;
    receipt: string;
    amountCents: number;
    bookingStatus: string;
    creditElectionCents: number | null;
    additional: {
      outstandingCents: number;
      settled: boolean;
      recordedAmountCents: number;
      payableOnline: boolean;
    } | null;
  };
  message: string;
}>({
  success: true,
  booking: {
    bookingId: true,
    paymentId: true,
    direction: true,
    memberNotified: true,
    receipt: true,
    amountCents: true,
    bookingStatus: true,
    creditElectionCents: true,
    additional: {
      outstandingCents: true,
      settled: true,
      recordedAmountCents: true,
      payableOnline: true,
    },
  },
  message: true,
});

type BillingPerson = { memberId: string; memberName: string };

/**
 * `GET /api/admin/subscription-billing`: the season's billing preview (what
 * confirming would invoice, and to whom), the charges already raised, the
 * open billing exceptions and the settings it ran with. Recipients' email
 * addresses, Xero invoice ids and links, idempotency keys and the exceptions'
 * raw context stay behind. `preview.confirmationToken` stays: confirming the
 * batch sends it back.
 */
const SUBSCRIPTION_BILLING_DATA_SHAPE = {
  preview: {
    seasonYear: true,
    decisionDate: true,
    dueDays: true,
    totalCents: true,
    confirmationToken: true,
    entries: {
      key: true,
      membershipTypeName: true,
      subscriptionCategoryName: true,
      billingBasis: true,
      prorationRule: true,
      annualAmountCents: true,
      chargedAmountCents: true,
      coveredMonths: true,
      coverageStart: true,
      coverageEnd: true,
      familyGroupId: true,
      recipient: { id: true, name: true },
      coveredMembers: { id: true, name: true },
      components: { label: true, description: true, annualAmountCents: true, chargedAmountCents: true, prorated: true },
    },
    exceptions: { fingerprint: true, code: true, message: true, memberId: true, familyGroupId: true },
    exemptMembers: { memberId: true, memberName: true, ageTier: true, exemptBy: true, membershipTypeName: true },
    alreadyInvoiced: { memberId: true, memberName: true, xeroInvoiceNumber: true, status: true },
    alreadyInvoicedFamilies: {
      familyGroupId: true,
      holderName: true,
      xeroInvoiceNumber: true,
      status: true,
      membersCovered: true,
      holderBasisUnresolvable: true,
      operatorMarked: true,
      markerNote: true,
      markedByName: true,
      markedAt: true,
    },
    ungroupedCategoryMembers: { subscriptionCategoryName: true, members: { memberId: true, memberName: true } },
  },
  charges: {
    id: true,
    seasonYear: true,
    source: true,
    status: true,
    membershipTypeName: true,
    subscriptionCategoryName: true,
    billingBasis: true,
    annualAmountCents: true,
    chargedAmountCents: true,
    coverageStart: true,
    coverageEnd: true,
    recipientMemberId: true,
    recipientName: true,
    dueDays: true,
    xeroInvoiceNumber: true,
    emailSentAt: true,
    lastErrorCode: true,
    lastErrorMessage: true,
    confirmedAt: true,
    createdAt: true,
    coverage: { memberId: true, memberName: true, releasedAt: true, subscription: { status: true } },
  },
  exceptions: {
    id: true,
    fingerprint: true,
    seasonYear: true,
    source: true,
    status: true,
    code: true,
    message: true,
    memberId: true,
    familyGroupId: true,
    firstSeenAt: true,
    lastSeenAt: true,
  },
  xeroInvoicing: { enabled: true, awaitingXeroCount: true },
  settings: { invoiceDueDays: true, familyBillingMode: true },
} as const;

type SubscriptionBillingData = {
  preview: {
    seasonYear: number;
    decisionDate: string;
    dueDays: number;
    totalCents: number;
    confirmationToken: string;
    entries: Array<{
      key: string;
      membershipTypeName: string | null;
      subscriptionCategoryName?: string | null;
      billingBasis: string;
      prorationRule: string;
      annualAmountCents: number;
      chargedAmountCents: number;
      coveredMonths: number;
      coverageStart: string;
      coverageEnd: string;
      familyGroupId: string | null;
      recipient: { id: string; name: string };
      coveredMembers: Array<{ id: string; name: string }>;
      components: Array<{
        label: string;
        description: string;
        annualAmountCents: number;
        chargedAmountCents: number;
        prorated: boolean;
      }>;
    }>;
    exceptions: Array<{
      fingerprint: string;
      code: string;
      message: string;
      memberId: string | null;
      familyGroupId: string | null;
    }>;
    exemptMembers: Array<BillingPerson & { ageTier: string | null; exemptBy: string; membershipTypeName?: string }>;
    alreadyInvoiced: Array<BillingPerson & { xeroInvoiceNumber: string | null; status: string }>;
    alreadyInvoicedFamilies: Array<{
      familyGroupId: string;
      holderName: string | null;
      xeroInvoiceNumber: string | null;
      status: string | null;
      membersCovered: number;
      holderBasisUnresolvable: boolean;
      operatorMarked: boolean;
      markerNote: string | null;
      markedByName: string | null;
      markedAt: Date | null;
    }>;
    ungroupedCategoryMembers: Array<{ subscriptionCategoryName: string; members: BillingPerson[] }>;
  };
  charges: Array<{
    id: string;
    seasonYear: number;
    source: string;
    status: string;
    membershipTypeName: string | null;
    subscriptionCategoryName: string | null;
    billingBasis: string;
    annualAmountCents: number;
    chargedAmountCents: number;
    coverageStart: Date;
    coverageEnd: Date;
    recipientMemberId: string;
    recipientName: string;
    dueDays: number;
    xeroInvoiceNumber: string | null;
    emailSentAt: Date | null;
    lastErrorCode: string | null;
    lastErrorMessage: string | null;
    confirmedAt: Date | null;
    createdAt: Date;
    coverage: Array<BillingPerson & { releasedAt: Date | null; subscription: { status: string } }>;
  }>;
  exceptions: Array<{
    id: string;
    fingerprint: string;
    seasonYear: number;
    source: string;
    status: string;
    code: string;
    message: string;
    memberId: string | null;
    familyGroupId: string | null;
    firstSeenAt: Date;
    lastSeenAt: Date;
  }>;
  xeroInvoicing: { enabled: boolean; awaitingXeroCount: number };
  settings: { invoiceDueDays: number; familyBillingMode: string };
};

export const SUBSCRIPTION_BILLING_CONNECTION_SHAPE = connectionShapeFor<SubscriptionBillingData>(
  SUBSCRIPTION_BILLING_DATA_SHAPE,
);

/** `POST /api/admin/subscription-billing`, `REFRESH_PREVIEW`: the refreshed panel and how many stale exceptions closed. */
export const SUBSCRIPTION_BILLING_REFRESHED_CONNECTION_SHAPE = connectionShapeFor<
  SubscriptionBillingData & { success: boolean; message: string; reconciledCount: number }
>({
  success: true,
  message: true,
  reconciledCount: true,
  ...SUBSCRIPTION_BILLING_DATA_SHAPE,
});

/**
 * `POST /api/admin/subscription-billing`, `CONFIRM_ANNUAL_BATCH`: the charges
 * raised and the invoice work queued for each. When Xero was switched off
 * mid-confirm, `queued` is empty and `message` says so.
 */
export const SUBSCRIPTION_BILLING_ANNUAL_BATCH_CONFIRMED_CONNECTION_SHAPE = connectionShapeFor<{
  success: boolean;
  message: string;
  chargeIds: string[];
  exceptionCount: number;
  queued: Array<{ queueOperationId: string | null; message: string }>;
}>({
  success: true,
  message: true,
  chargeIds: true,
  exceptionCount: true,
  queued: { queueOperationId: true, message: true },
});

/** `POST /api/admin/subscription-billing`, `RETRY_CHARGE`: the invoice work queued, if any. */
export const SUBSCRIPTION_BILLING_CHARGE_RETRIED_CONNECTION_SHAPE = connectionShapeFor<{
  success: boolean;
  queueOperationId: string | null;
  message: string;
}>({
  success: true,
  queueOperationId: true,
  message: true,
});

/** `POST /api/admin/subscription-billing`, `CLOSE_ALREADY_PAID`: whether this call closed the charge. */
export const SUBSCRIPTION_BILLING_CHARGE_CLOSED_CONNECTION_SHAPE = connectionShapeFor<{
  success: boolean;
  closed: boolean;
  message: string;
}>({
  success: true,
  closed: true,
  message: true,
});

/** `POST /api/admin/subscription-billing`, `MARK_FAMILY_INVOICED` / `UNMARK_FAMILY_INVOICED`. */
export const SUBSCRIPTION_BILLING_FAMILY_MARKER_CONNECTION_SHAPE = connectionShapeFor<{
  success: boolean;
  message: string;
}>({
  success: true,
  message: true,
});

const FINANCE_METRICS_WINDOW_SHAPE = { from: true, to: true, effectiveFrom: true, effectiveTo: true, dayCount: true } as const;
const FINANCE_METRICS_STATUS_SHAPE = { bookingCount: true, bookingNights: true, guestNights: true, bookedRevenueCents: true } as const;
const FINANCE_METRICS_BUCKET_SHAPE = {
  ...FINANCE_METRICS_STATUS_SHAPE,
  occupancy: { occupiedBedNights: true, capacityBedNights: true, occupancyRate: true },
} as const;
const FINANCE_METRICS_DAY_SHAPE = {
  date: true,
  bookingCount: true,
  guestNights: true,
  occupiedBeds: true,
  availableBeds: true,
  occupancyRate: true,
  bookedRevenueCents: true,
} as const;

/**
 * `GET /api/finance/bookings/metrics`: the finance workspace's booking
 * figures for a realised (past stays) window, a forward (bookings ahead)
 * window, or both, with the payment and money-reconciliation summaries.
 * Aggregates only, in integer cents.
 */
export const FINANCE_BOOKING_METRICS_CONNECTION_SHAPE = connectionShapeFor<FinanceBookingMetricsResult>({
  generatedAt: true,
  bookingCount: true,
  moneyReconciliation: {
    totalBookings: true,
    byState: { RECONCILED: true, UNRECONCILED: true },
    byReason: eachEntry(true),
  },
  paymentSummary: {
    bookingCount: true,
    bookingsWithPayment: true,
    bookingsWithoutPayment: true,
    paymentStatusBreakdown: eachEntry(true),
    additionalPaymentStatusBreakdown: eachEntry(true),
    capturedGrossCents: true,
    capturedAdditionalCents: true,
    outstandingAdditionalCents: true,
    outstandingAdditionalBookings: true,
    additionalLedgerGapCents: true,
    additionalLedgerGapBookings: true,
    refundedCents: true,
    handBackOwedCents: true,
    cardRefundOwedCents: true,
    lateCaptureOwedCents: true,
    lateCashCreditedCents: true,
    keptCreditCents: true,
    netCollectedCents: true,
    refundsOwedCents: true,
    creditsOwedCents: true,
    creditAppliedCents: true,
    changeFeeCents: true,
  },
  realized: {
    window: { ...FINANCE_METRICS_WINDOW_SHAPE, cutoffDate: true },
    totals: { ...FINANCE_METRICS_BUCKET_SHAPE, averageNightlyRevenueCents: true },
    statusBreakdown: eachEntry(FINANCE_METRICS_STATUS_SHAPE),
    byDate: FINANCE_METRICS_DAY_SHAPE,
  },
  forward: {
    window: { ...FINANCE_METRICS_WINDOW_SHAPE, asOfDate: true },
    totals: {
      committed: { ...FINANCE_METRICS_BUCKET_SHAPE, statusBreakdown: eachEntry(FINANCE_METRICS_STATUS_SHAPE) },
      atRisk: { ...FINANCE_METRICS_BUCKET_SHAPE, statusBreakdown: eachEntry(FINANCE_METRICS_STATUS_SHAPE) },
      totalPipeline: FINANCE_METRICS_BUCKET_SHAPE,
    },
    byDate: {
      date: true,
      committed: FINANCE_METRICS_DAY_SHAPE,
      atRisk: FINANCE_METRICS_DAY_SHAPE,
      totalPipeline: FINANCE_METRICS_DAY_SHAPE,
    },
  },
});

const FINANCE_SYNC_RUN_SUMMARY_SHAPE = {
  id: true,
  workflow: true,
  trigger: true,
  status: true,
  startedAt: true,
  completedAt: true,
  durationMs: true,
  snapshotCount: true,
  totalRowCount: true,
  datasetCount: true,
  successfulDatasetCount: true,
  failedDatasetCount: true,
  datasets: { datasetKey: true, snapshotCount: true, totalRowCount: true, snapshotTypes: true, errorMessage: true },
  errorSummary: true,
  failureDetails: { stage: true, datasetKey: true, message: true },
} as const;

const FINANCE_SYNC_CRON_RUN_SHAPE = {
  id: true,
  jobName: true,
  status: true,
  startedAt: true,
  completedAt: true,
  durationMs: true,
  financeSyncRunId: true,
  financeSyncStatus: true,
  snapshotCount: true,
  totalRowCount: true,
  datasetCount: true,
  failedDatasetCount: true,
  error: true,
  reason: true,
} as const;

/**
 * `GET /api/finance/sync/status`: the latest finance sync from Xero, its
 * nightly schedule and recent failures. The Xero organisation id and the
 * requesting member's id stay behind.
 */
export const FINANCE_SYNC_STATUS_CONNECTION_SHAPE = connectionShapeFor<FinanceSyncDiagnosticsStatus>({
  workflow: true,
  latestRun: FINANCE_SYNC_RUN_SUMMARY_SHAPE,
  cron: { jobName: true, schedule: true, timezone: true, latestRun: FINANCE_SYNC_CRON_RUN_SHAPE },
  recentFailures: { syncRuns: FINANCE_SYNC_RUN_SUMMARY_SHAPE, cronRuns: FINANCE_SYNC_CRON_RUN_SHAPE },
});

type FinanceSyncDatasetResult = FinanceSyncExecutionResult["datasetResults"][number];

const FINANCE_SYNC_DATASET_RESULT_SHAPE = {
  datasetKey: true,
  snapshotCount: true,
  totalRowCount: true,
  snapshotTypes: true,
  factRowCount: true,
  unresolvedFactRowCount: true,
  errorMessage: true,
} as const;

/**
 * `POST /api/finance/sync/run`, as a connection is answered (the browser is
 * redirected): `completed` or `partial` with the run's figures.
 */
export const FINANCE_SYNC_RUN_CONNECTION_SHAPE = connectionShapeFor<{
  outcome: "completed" | "partial";
  runId: string;
  status: string;
  startedAt: string;
  completedAt: string;
  snapshotCount: number;
  totalRowCount: number;
  datasetResults: FinanceSyncDatasetResult[];
}>({
  outcome: true,
  runId: true,
  status: true,
  startedAt: true,
  completedAt: true,
  snapshotCount: true,
  totalRowCount: true,
  datasetResults: FINANCE_SYNC_DATASET_RESULT_SHAPE,
});

/** `POST /api/finance/sync/backfill-monthly-facts`: the backfill run and what each report gave. */
export const FINANCE_BACKFILL_MONTHLY_FACTS_CONNECTION_SHAPE = connectionShapeFor<{
  runId: string;
  status: string;
  snapshotCount: number;
  totalRowCount: number;
  datasetResults: FinanceSyncDatasetResult[];
}>({
  runId: true,
  status: true,
  snapshotCount: true,
  totalRowCount: true,
  datasetResults: FINANCE_SYNC_DATASET_RESULT_SHAPE,
});
