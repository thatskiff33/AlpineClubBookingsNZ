// One-off, idempotent, local-only backfill for Payment rows whose captured
// aggregate status was flattened to FAILED by the pre-#1489 booking-cancel
// defect (#1473 / #1506).
//
// Before PR #1489, `cancelBooking`'s not-SUCCEEDED branch overwrote EVERY
// payment's aggregate `status` to FAILED — including captured
// (PARTIALLY_)REFUNDED payments — while leaving `refundedAmountCents` and the
// PaymentTransaction ledger untouched. #1489 stopped the overwrite going
// forward, but rows already flattened are not backfilled. The read path is
// already correct (the repair pass synthesizes captured state from the STRIPE
// mirror / ledger); this restores the STORED aggregate status for cleanliness.
//
// Pure local DB repair: no Xero, Stripe, SES, or Sentry calls; money stays in
// integer cents; only the flattened `status` field is touched.
import { PaymentSource, PaymentStatus, Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { applyLegacyRefundStatus } from "@/lib/xero-booking-repair-payments";
import { isCapturedTransactionStatus } from "@/lib/payment-transaction-status";

// The full client, not a nested TransactionClient: the apply path opens its own
// $transaction, so it must not run inside another one.
type BackfillStore = typeof prisma;

// Minimal shape needed to reproduce the #1489 capture discriminator and the
// repair-pass synthesis. Kept independent of the heavier bookingRepairSelect.
export interface FlattenedCandidatePayment {
  id: string;
  bookingId: string;
  source: PaymentSource;
  status: PaymentStatus;
  amountCents: number;
  refundedAmountCents: number;
  transactions: Array<{ status: PaymentStatus }>;
}

export interface FlattenedPaymentRestoration {
  paymentId: string;
  bookingId: string;
  source: PaymentSource;
  field: "status";
  storedStatus: PaymentStatus;
  restoredStatus: PaymentStatus;
  amountCents: number;
  refundedAmountCents: number;
}

/**
 * Reproduces booking-cancel.ts `paymentHasCaptureEvidence` (#1473/#1491,
 * ~line 1528) exactly: ledger truth first — any PaymentTransaction row holding
 * a captured status — else the STRIPE-only refund mirror for pre-ledger rows.
 * The aggregate mirror alone is NOT trusted for non-STRIPE payments: the
 * inbound reconcile folds invoice-applied modification credit notes into
 * `refundedAmountCents`/PARTIALLY_REFUNDED on never-captured IB payments (pure
 * bookkeeping, zero cash), so those must stay FAILED after cancel.
 *
 * Duplicated here (not imported) only because the source lives in
 * booking-cancel.ts as a private helper that is off-limits to edit; the two
 * MUST stay in lockstep.
 */
export function paymentHasCaptureEvidence(
  payment: FlattenedCandidatePayment
): boolean {
  const hasCapturedLedgerRow = payment.transactions.some((transaction) =>
    isCapturedTransactionStatus(transaction.status)
  );
  return (
    hasCapturedLedgerRow ||
    (payment.source === PaymentSource.STRIPE &&
      (payment.status === PaymentStatus.REFUNDED ||
        payment.status === PaymentStatus.PARTIALLY_REFUNDED ||
        payment.refundedAmountCents > 0))
  );
}

/**
 * Returns the restoration for a single payment if — and only if — it carries
 * the pre-#1489 flattening signature, else null.
 *
 * Signature (all required):
 *  - the payment's booking is CANCELLED (enforced by the scan query), and
 *  - the aggregate `status` is FAILED (the flatten target — the old code only
 *    ever wrote `status: "FAILED"`; it never touched `refundedAmountCents` or
 *    the ledger), and
 *  - the payment has capture evidence per the #1489 discriminator, and
 *  - the restored captured status the read path already synthesizes differs
 *    from the stored FAILED.
 *
 * The restored status reuses the exact #1489 repair-pass synthesis
 * (`applyLegacyRefundStatus`) with base SUCCEEDED — capture evidence proves the
 * payment captured, so its base state is SUCCEEDED and any refund history in
 * the intact `refundedAmountCents` mirror re-derives PARTIALLY_REFUNDED /
 * REFUNDED. Because the mirror is untouched by the flatten, this is exactly
 * what the repair pass reads today.
 */
export function deriveFlattenedPaymentRestoration(
  payment: FlattenedCandidatePayment
): FlattenedPaymentRestoration | null {
  if (payment.status !== PaymentStatus.FAILED) {
    return null;
  }
  if (!paymentHasCaptureEvidence(payment)) {
    return null;
  }

  const restoredStatus = applyLegacyRefundStatus(
    PaymentStatus.SUCCEEDED,
    payment.amountCents,
    payment.refundedAmountCents
  );

  if (restoredStatus === payment.status) {
    return null;
  }

  return {
    paymentId: payment.id,
    bookingId: payment.bookingId,
    source: payment.source,
    field: "status",
    storedStatus: payment.status,
    restoredStatus,
    amountCents: payment.amountCents,
    refundedAmountCents: payment.refundedAmountCents,
  };
}

export interface FlattenedCancelPaymentBackfillResult {
  mode: "dry-run" | "apply";
  scanned: number;
  restorations: FlattenedPaymentRestoration[];
  appliedCount: number;
}

const CANDIDATE_PAYMENT_SELECT = {
  id: true,
  bookingId: true,
  source: true,
  status: true,
  amountCents: true,
  refundedAmountCents: true,
  transactions: {
    select: { status: true },
  },
} satisfies Prisma.PaymentSelect;

/**
 * Scans FAILED payments on CANCELLED bookings and returns the ones carrying the
 * pre-#1489 flattening signature. When `apply` is true, restores each row's
 * `status` field inside a single transaction. Read-only otherwise (dry run).
 */
export async function backfillFlattenedCancelPayments({
  store = prisma,
  apply = false,
  batchSize = 500,
}: {
  store?: BackfillStore;
  apply?: boolean;
  batchSize?: number;
} = {}): Promise<FlattenedCancelPaymentBackfillResult> {
  const restorations: FlattenedPaymentRestoration[] = [];
  let scanned = 0;
  let cursor: string | undefined;

  // Cursor-paginate so a large history never loads at once. The query is the
  // narrow flatten target: FAILED aggregate status on a CANCELLED booking.
  for (;;) {
    const page = await store.payment.findMany({
      where: {
        status: PaymentStatus.FAILED,
        booking: { status: "CANCELLED" },
      },
      select: CANDIDATE_PAYMENT_SELECT,
      orderBy: { id: "asc" },
      take: batchSize,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
    });

    if (page.length === 0) {
      break;
    }

    for (const payment of page) {
      scanned += 1;
      const restoration = deriveFlattenedPaymentRestoration(payment);
      if (restoration) {
        restorations.push(restoration);
      }
    }

    if (page.length < batchSize) {
      break;
    }
    cursor = page[page.length - 1]!.id;
  }

  let appliedCount = 0;

  if (apply && restorations.length > 0) {
    await store.$transaction(
      restorations.map((restoration) =>
        store.payment.update({
          where: {
            id: restoration.paymentId,
            // Guard: only flip a row that is still the flattened FAILED it was
            // scanned as, so a concurrent write can never be clobbered.
            status: PaymentStatus.FAILED,
          },
          data: { status: restoration.restoredStatus },
        })
      )
    );
    appliedCount = restorations.length;
  }

  return {
    mode: apply ? "apply" : "dry-run",
    scanned,
    restorations,
    appliedCount,
  };
}

export function formatFlattenedCancelPaymentReport(
  result: FlattenedCancelPaymentBackfillResult
): string {
  const lines: string[] = [];
  lines.push(
    `Cancel-flattened payment backfill (${result.mode}) — scanned ${result.scanned} FAILED payment(s) on CANCELLED bookings.`
  );

  if (result.restorations.length === 0) {
    lines.push("No flattened rows found; nothing to restore.");
    return lines.join("\n");
  }

  lines.push(
    `Found ${result.restorations.length} flattened row(s) to restore:`
  );
  for (const restoration of result.restorations) {
    lines.push(
      `  booking=${restoration.bookingId} payment=${restoration.paymentId} ` +
        `source=${restoration.source} field=${restoration.field} ` +
        `${restoration.storedStatus} -> ${restoration.restoredStatus} ` +
        `(amountCents=${restoration.amountCents}, refundedAmountCents=${restoration.refundedAmountCents})`
    );
  }

  if (result.mode === "apply") {
    lines.push(`Applied ${result.appliedCount} restoration(s).`);
  } else {
    lines.push("Dry run: no changes written. Re-run with --apply to restore.");
  }

  return lines.join("\n");
}
