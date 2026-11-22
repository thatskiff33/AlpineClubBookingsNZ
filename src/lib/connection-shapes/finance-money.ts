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
