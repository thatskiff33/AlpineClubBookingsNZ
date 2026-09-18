import { PaymentStatus, PaymentTransactionKind } from "@prisma/client";

import { CAPTURED_PAYMENT_STATUS_LIST } from "@/lib/booking-payment-state";

// #3340 (`INV-SSOT-001`): imported, not restated. The list lives once in
// `booking-payment-state.ts`.
const CAPTURED_PAYMENT_STATUSES = new Set<string>(CAPTURED_PAYMENT_STATUS_LIST);

interface AdditionalLedgerGapPaymentLike {
  additionalPaymentStatus: string | null;
  additionalAmountCents: number;
  transactions?: Array<{
    kind: PaymentTransactionKind;
    status: PaymentStatus;
    amountCents: number;
  }>;
}

interface AdditionalLedgerGapBookingLike {
  id: string;
  payment: AdditionalLedgerGapPaymentLike | null;
}

export interface AdditionalLedgerGapSummary {
  additionalLedgerGapCents: number;
  additionalLedgerGapBookings: number;
  bookingIds: string[];
}

/**
 * Detect payments that claim a collected price increase without the captured
 * ADDITIONAL ledger evidence that makes that increase part of amountCents.
 *
 * Missing transactions are deliberately treated as no evidence. Cash remains
 * payment-aggregate-derived; this helper measures the possible understatement
 * and never reconstructs or changes the cash figure from ledger rows (#2408).
 */
export function summarizeAdditionalLedgerGap(
  bookings: AdditionalLedgerGapBookingLike[],
): AdditionalLedgerGapSummary {
  const summary: AdditionalLedgerGapSummary = {
    additionalLedgerGapCents: 0,
    additionalLedgerGapBookings: 0,
    bookingIds: [],
  };

  for (const booking of bookings) {
    const payment = booking.payment;
    if (
      !payment ||
      payment.additionalPaymentStatus !== "SUCCEEDED" ||
      payment.additionalAmountCents <= 0
    ) {
      continue;
    }

    const capturedAdditionalLedgerCents = (
      Array.isArray(payment.transactions) ? payment.transactions : []
    ).reduce(
      (sum, row) =>
        row.kind === PaymentTransactionKind.ADDITIONAL &&
        CAPTURED_PAYMENT_STATUSES.has(row.status)
          ? sum + row.amountCents
          : sum,
      0,
    );

    if (capturedAdditionalLedgerCents !== 0) continue;

    summary.additionalLedgerGapCents += payment.additionalAmountCents;
    summary.additionalLedgerGapBookings += 1;
    summary.bookingIds.push(booking.id);
  }

  return summary;
}
