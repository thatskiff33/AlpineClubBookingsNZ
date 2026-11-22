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
import { connectionShapeFor } from "@/lib/connection-projection";

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
