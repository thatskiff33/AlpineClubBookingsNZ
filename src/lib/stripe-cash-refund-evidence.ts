/**
 * Provider-backed Stripe CASH refund evidence for the Xero refund-note
 * pipeline (#2902, INV-PAY-050).
 *
 * `Payment.refundedAmountCents` is the aggregate settlement mirror and
 * DELIBERATELY tracks value removed from the captured payment for BOTH
 * dispositions — cash returned through Stripe AND cancellation /
 * booking-modification value held as member account credit
 * (`applyLocalRefundAllocation` runs on the credit paths so a later cancel
 * cannot refund the same cents twice, #1031). That makes the mirror the right
 * input for settlement and conservation maths, and the WRONG input for
 * deciding whether a Stripe cash-refund credit note (settled by a refund
 * payment against the Stripe bank account) should exist in Xero: an
 * account-credit-only cancellation read as a "missing Stripe refund" and the
 * reconciliation self-heal minted a fictitious REFUND_CREDIT_NOTE plus a
 * Stripe-bank payment no provider transaction backs (#2902, three payments in
 * an anonymized production review).
 *
 * The Xero refund-note surfaces (health detection, self-heal enqueue,
 * execution-time delta recompute, and the #2901 link repair's coverage
 * target) therefore derive cash-refund cents from here instead:
 *
 * - When the payment has ANY `PaymentRefund` ledger rows, the target is the
 *   sum of its `succeeded` rows — provider-backed evidence, recorded by
 *   `recordStripeRefundLedgerEntry` in every modern cash path (the inline
 *   cancel refund, the charge.refunded webhook sync, and payment recovery)
 *   BEFORE the matching note is enqueued. Grouped per payment so stepped
 *   refunds (#1162/#1354) sum naturally.
 * - When the payment has NO ledger rows at all (refunds that predate the
 *   2026-05-09 `PaymentRefund` model — there is no backfill), the legacy
 *   fallback is `refundedAmountCents` minus the account-credit disposition
 *   evidence: positive CANCELLATION_REFUND / BOOKING_MODIFICATION_REFUND
 *   `MemberCredit` rows sourced from the payment's booking, excluding
 *   restore rows (`restoredFromBookingId` set — restores never touch the
 *   mirror). Pre-ledger genuine cash refunds keep self-healing; pre-ledger
 *   account-credit cancellations are excluded.
 *
 * Stated limits. The first two are fail-safe: they can only UNDER-state cash,
 * so the pipeline under-flags a genuine refund note and can never mint one.
 * The third is NOT fail-safe in that direction and is the deliberate cost of
 * the 21 Aug 2026 owner decision recorded on
 * `isRecordedRefundStatus` (`payment-transaction-status.ts`) — read it before changing the filter:
 *
 * - A payment refunded partly before and partly after the ledger existed
 *   resolves from its (partial) ledger rows and can under-state cash.
 * - The legacy fallback subtracts the BOOKING's whole account-credit
 *   disposition from EACH per-payment mirror, because `MemberCredit` records
 *   only `sourceBookingId` — no payment linkage exists anywhere on the credit
 *   trail (the writer, `applyLocalRefundAllocation`, knows the payment at
 *   write time but persists nothing per payment, and the pre-ledger rows this
 *   fallback exists for could never be backfilled with an attribution that
 *   was never recorded). On the rare multi-Payment booking mixing a genuine
 *   pre-ledger cash refund on one payment with an account-credit disposition
 *   on another, the cash payment's evidence can clamp to zero and its refund
 *   note is under-flagged rather than self-healed; the operator repair's
 *   dry-run report still shows the divergence for manual review.
 *
 * - A refund Stripe has accepted but later FAILS counts as cash between those
 *   two events, so the note can briefly OVER-state cash. This is the one limit
 *   that is not fail-safe, and it is chosen rather than accidental: the
 *   alternative under-states every still-settling refund, which is both more
 *   common and harder to notice. `cashRefundCents` stays clamped to
 *   `refundedAmountCents`, so the overstatement can never exceed what was
 *   actually refunded, and the next reconciliation run corrects it once the
 *   row lands on `failed`.
 */
import { CreditType, Prisma } from "@prisma/client";
import { isRecordedRefundStatus } from "@/lib/payment-transaction-status";
import { prisma } from "@/lib/prisma";


export interface StripeCashRefundEvidence {
  /**
   * Cents of Stripe CASH refund the Xero refund-note pipeline should cover
   * for this payment. Never negative, never above `refundedAmountCents`.
   */
  cashRefundCents: number;
  /**
   * Sum of PaymentRefund rows whose status is not in
   * `isRecordedRefundStatus` (0 when none exist) — i.e. settled cash
   * plus cash Stripe has accepted and not yet settled.
   */
  countedRefundCents: number;
  /** PaymentRefund rows of any status — 0 means pre-ledger history. */
  refundLedgerRowCount: number;
  /**
   * Account-credit disposition cents subtracted by the legacy fallback.
   * Always 0 on the provider-ledger path (not queried there).
   */
  accountCreditCents: number;
  /** Which rule produced `cashRefundCents`. */
  source: "provider-ledger" | "legacy-mirror";
}

/**
 * Resolve the cash-refund evidence for one Stripe-source payment. Accepts an
 * optional transaction client so tx-scoped callers see their own uncommitted
 * writes (mirroring `sumCoveredRefundCreditNoteCents`, #1357).
 */
export async function resolveStripeCashRefundEvidence(
  payment: {
    id: string;
    bookingId: string;
    refundedAmountCents: number;
  },
  db: Prisma.TransactionClient = prisma
): Promise<StripeCashRefundEvidence> {
  const mirrorCents = Math.max(0, payment.refundedAmountCents);

  const grouped = await db.paymentRefund.groupBy({
    by: ["status"],
    where: { paymentId: payment.id },
    _sum: { amountCents: true },
    _count: { _all: true },
  });

  const refundLedgerRowCount = grouped.reduce(
    (sum, row) => sum + row._count._all,
    0
  );
  const countedRefundCents = grouped
    .filter(
      (row) =>
        isRecordedRefundStatus(row.status)
    )
    .reduce((sum, row) => sum + Math.max(0, row._sum.amountCents ?? 0), 0);

  if (refundLedgerRowCount > 0) {
    return {
      cashRefundCents: Math.min(mirrorCents, countedRefundCents),
      countedRefundCents,
      refundLedgerRowCount,
      accountCreditCents: 0,
      source: "provider-ledger",
    };
  }

  const credit = await db.memberCredit.aggregate({
    where: {
      sourceBookingId: payment.bookingId,
      type: {
        in: [
          CreditType.CANCELLATION_REFUND,
          CreditType.BOOKING_MODIFICATION_REFUND,
        ],
      },
      amountCents: { gt: 0 },
      // Restores of previously applied credit never ran
      // applyLocalRefundAllocation, so they are not part of the mirror.
      restoredFromBookingId: null,
    },
    _sum: { amountCents: true },
  });
  const accountCreditCents = Math.max(0, credit._sum.amountCents ?? 0);

  return {
    cashRefundCents: Math.max(0, mirrorCents - accountCreditCents),
    countedRefundCents: 0,
    refundLedgerRowCount: 0,
    accountCreditCents,
    source: "legacy-mirror",
  };
}
