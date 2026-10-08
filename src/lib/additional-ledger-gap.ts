import { PaymentStatus, PaymentTransactionKind, Prisma } from "@prisma/client";

import { CARD_REFUND_OPERATION_WHERE } from "@/lib/open-card-refund-owed";
import { netCollectedScopedPayments, summarizeCollectedCash, type CollectedCashSummary, type NetCollectedPaymentRow } from "@/lib/payment-net-collected";
import {
  CAPTURED_TRANSACTION_STATUS_LIST,
  isCapturedTransactionStatus,
} from "@/lib/payment-transaction-status";

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
        isCapturedTransactionStatus(row.status)
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
 * Collected" figure and its ledger-gap warning, used by Reports and Finance.
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
    // `description` for a restore written before the marker existed
    // (`isCancellationCreditRestoreRow`).
    select: { type: true, amountCents: true, description: true, restoredFromBookingId: true },
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

/**
 * #3372 (owner's rule on PR #3811: only money actually received counts): the
 * capture evidence `getNetCollectedPaymentParts` asks of a payment whose status
 * is REFUNDED / PARTIALLY_REFUNDED (`netCollectedPaymentTookMoney`) - the
 * payment's `source`, for the STRIPE mirror, and how many of its ledger rows
 * hold a captured status. A filtered relation count inside the one payment
 * query: no per-row read, and no ledger rows loaded on the dashboard. Every Net
 * Collected select spreads it, so none can count every ledger row instead.
 */
export const netCollectedCaptureEvidenceSelect = Prisma.validator<Prisma.PaymentSelect>()({
  source: true,
  _count: {
    select: {
      transactions: {
        where: { status: { in: [...CAPTURED_TRANSACTION_STATUS_LIST] } },
      },
    },
  },
});

/**
 * #3372 (owner, 7 Oct 2026: "count in both"): a payment's card refund
 * operations, and the refunds already recorded on it to net the open ones
 * against (`openCardRefundOwedCents`). Closed operations are loaded too, so a
 * refund one of them sent is never taken as an open one's progress (#3924
 * money review, F2). Every Net Collected select spreads it (the payments board
 * merges its own `refunds` columns in), and so does the "Refunds owed" read, so
 * the two figures read the same rows. The `where` is an optimisation; the rule
 * re-checks the type.
 */
export const netCollectedCardRefundSelect = Prisma.validator<Prisma.PaymentSelect>()({
  recoveryOperations: {
    where: CARD_REFUND_OPERATION_WHERE,
    select: {
      id: true,
      type: true,
      status: true,
      idempotencyKey: true,
      amountCents: true,
      allocationPlan: true,
      paymentTransactionId: true,
      createdAt: true,
      succeededAt: true,
    },
  },
  refunds: {
    select: { paymentTransactionId: true, amountCents: true, status: true, createdAt: true },
  },
});

export const netCollectedPaymentSelect = Prisma.validator<Prisma.PaymentSelect>()({
  ...netCollectedCaptureEvidenceSelect,
  ...netCollectedCardRefundSelect,
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
 * #3372 / #3637: a Net Collected figure and its "may understate" ledger
 * gap, over ONE set of payments. The gap runs over exactly the payments the
 * figure counts (the Net Collected booking scope), so no surface can warn about
 * a payment its figure left out, or stay silent about one it counted. Reports,
 * the payments board and the finance dashboard all call it.
 *
 * It lives here, not beside `summarizeCollectedCash` in
 * `payment-net-collected.ts`, because this module already imports that one:
 * the reverse import would be a cycle.
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
