/**
 * What each Finance officer action on payments, credits and refunds returns
 * (ALP-721, `INV-MCP-006`): the one place a catalogue entry's `returns` and
 * its route's projection both read (`INV-SSOT`). Money is integer cents.
 *
 * An officer's connection sends what it reads to the officer's AI provider,
 * so each shape keeps what the officer needs to answer a question about the
 * money and leaves out contact details, card and provider identifiers and
 * free text the screen does not need. Types only: nothing here reaches the
 * database.
 */
import { connectionShapeFor } from "@/lib/connection-projection";
import type { ApplyManualBookingPaymentResult } from "@/lib/manual-booking-payment";
import type {
  DismissedManualRefundTaskPayload,
  OpenManualRefundTaskPayload,
  toAutoRefundedManualRefundTaskPayload,
} from "@/lib/manual-refund-task-queue-payload";
import type { AdminAdjustmentRequestListItem } from "@/lib/member-credit";

/**
 * `GET /api/admin/payments`: one page of payments and the filtered totals.
 * `refundedAmountCents` counts cancellation credit too, so each row also
 * carries the screen's split of it into card refund and account credit.
 */
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
    cancellationSettlement: {
      accountCreditCents: number;
      restoredAppliedCreditCents: number;
      refundToOriginalMethodCents: number;
    };
    disputes: Array<{ status: string; amountCents: number }>;
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
    cancellationSettlement: {
      accountCreditCents: true,
      restoredAppliedCreditCents: true,
      refundToOriginalMethodCents: true,
    },
    // The card dispute's state and cents, not Stripe's dispute id.
    disputes: { status: true, amountCents: true },
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
export const CREDIT_APPROVALS_CONNECTION_SHAPE = connectionShapeFor<{ requests: AdminAdjustmentRequestListItem[] }>({
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
  tasks: OpenManualRefundTaskPayload[];
  autoRefundedUnavailable: boolean;
  autoRefunded: Array<ReturnType<typeof toAutoRefundedManualRefundTaskPayload>>;
  dismissedUnavailable: boolean;
  dismissed: DismissedManualRefundTaskPayload[];
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

/** `POST /api/admin/bookings/[id]/mark-paid`: the settlement recorded or reversed, in integer cents. */
export const MANUAL_BOOKING_PAYMENT_CONNECTION_SHAPE = connectionShapeFor<{
  success: boolean;
  booking: ApplyManualBookingPaymentResult;
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
