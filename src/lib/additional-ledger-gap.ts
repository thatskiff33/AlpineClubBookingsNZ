import { PaymentStatus, PaymentTransactionKind, Prisma } from "@prisma/client";

import {
  CAPTURED_PAYMENT_STATUS_LIST,
  netCollectedScopedPayments,
  summarizeCollectedCash,
  type CollectedCashSummary,
  type NetCollectedPaymentRow,
} from "@/lib/booking-payment-state";

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

/**
 * #3372 / #3637: the shared Prisma select for a payment read behind a "Net
 * Collected Cash" figure and its ledger-gap warning, used by Reports and Finance.
 * The payments board and the dashboard keep their own selects (the board loads
 * transactions of every kind for its list), and the compiler holds all of them
 * to the columns below - the columns
 * `summarizeCollectedCash` reads, `summarizeAdditionalLedgerGap`'s inputs, and
 * the booking fields `netCollectedBookingSelect` names (the scope's `deletedAt`
 * and a cancelled booking's credit and hand-back rows). The dashboard spreads
 * that booking select too. A surface may widen `booking.select` with what its
 * own filters need.
 *
 * ADDITIONAL ledger rows only (#2408): only a captured ADDITIONAL row proves a
 * collected increase is inside `amountCents`, and the cash total is never
 * rebuilt from the ledger (a capture can have no PRIMARY row). `kind` is
 * re-checked by `summarizeAdditionalLedgerGap`; the filter is an optimisation,
 * not the correctness boundary.
 */
export const netCollectedBookingSelect = Prisma.validator<Prisma.BookingSelect>()({
  deletedAt: true,
  // Owner decision on #3372 (3 Oct 2026): a cancelled booking's kept credit and
  // owed hand-back. Loaded as relations of the one payment query - no per-row
  // read - and judged in code (`getNetCollectedPaymentParts`), the one home of
  // which rows count; no `where` here, so the query cannot disagree with it.
  status: true,
  creditsApplied: { select: { type: true, amountCents: true } },
  creditsFromCancellation: {
    select: { type: true, amountCents: true, restoredFromBookingId: true },
  },
  manualRefundTasks: {
    select: {
      status: true,
      kind: true,
      amountCents: true,
      partPaymentReviewPaymentId: true,
    },
  },
});

export const netCollectedPaymentSelect = Prisma.validator<Prisma.PaymentSelect>()({
  bookingId: true,
  status: true,
  amountCents: true,
  refundedAmountCents: true,
  additionalAmountCents: true,
  additionalPaymentStatus: true,
  transactions: {
    where: { kind: PaymentTransactionKind.ADDITIONAL },
    select: { kind: true, status: true, amountCents: true },
  },
  booking: { select: netCollectedBookingSelect },
});

/**
 * #3372 / #3637: a Net Collected Cash figure and its "may understate" ledger
 * gap, over ONE set of payments. The gap runs over exactly the payments the
 * figure counts (the Net Collected booking scope), so no surface can warn about
 * a payment its figure left out, or stay silent about one it counted. Reports,
 * the payments board and the finance dashboard all call it.
 *
 * It lives here, not beside `summarizeCollectedCash`, because
 * `booking-payment-state.ts` is an import-free leaf that this module already
 * imports: the reverse import would be a cycle.
 */
export function summarizeNetCollectedWithLedgerGap<
  T extends NetCollectedPaymentRow &
    AdditionalLedgerGapPaymentLike & { bookingId: string },
>(
  payments: ReadonlyArray<T>,
): { collected: CollectedCashSummary; ledgerGap: AdditionalLedgerGapSummary } {
  return {
    collected: summarizeCollectedCash(payments),
    ledgerGap: summarizeAdditionalLedgerGap(
      netCollectedScopedPayments(payments).map((payment) => ({
        id: payment.bookingId,
        payment,
      })),
    ),
  };
}
