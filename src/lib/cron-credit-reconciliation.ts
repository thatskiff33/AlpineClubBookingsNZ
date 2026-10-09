import { BOOKING_ISSUED_CREDIT_TYPES } from "@/lib/member-credit-booking-rows";
import { prisma } from "./prisma";
import { readMemberCreditBalances, sumOutstandingCreditCents } from "@/lib/member-credit-balances";
import { isXeroConnected } from "./xero";
import logger from "@/lib/logger";
import { reportCronError } from "@/lib/observability-bridge";
import {
  REFUND_CREDIT_NOTE_GRACE_HOURS,
  getRefundsMissingXeroCreditNotes,
} from "@/lib/xero-admin-health";
import { findOrphanedAppliedCredits } from "@/lib/orphaned-applied-credit-backfill";
import { readPaidAnotherWayNotesNotLandedCents } from "@/lib/card-refund-paid-another-way-cash";
import {
  enqueueXeroRefundCreditNoteOperation,
  kickQueuedXeroOutboxOperationsIfConnected,
} from "@/lib/xero-operation-outbox";

/**
 * Daily reconciliation of account credit balances.
 * Compares local MemberCredit ledger totals against Xero unallocated credit notes.
 * Alerts admins if discrepancies are found.
 *
 * Note: Full Xero reconciliation requires querying credit notes per contact,
 * which is expensive. This simplified version just checks local consistency
 * and reports aggregate stats.
 */
export async function reconcileCreditBalances(): Promise<{
  membersWithCredit: number;
  totalCreditCents: number;
  discrepancies: number;
  refundsMissingXeroCreditNotes: number;
  orphanedAppliedCredits: number;
}> {
  // Get per-member credit balances from local ledger
  const balances = await readMemberCreditBalances();

  const membersWithCredit = balances.filter((b) => b.balanceCents > 0).length;

  const totalCreditCents = sumOutstandingCreditCents(balances);

  // Check for negative balances (should never happen — indicates a bug)
  const negativeBalances = balances.filter((b) => b.balanceCents < 0);

  const discrepancies = negativeBalances.length;

  const refundsMissingCreditNotes = await getRefundsMissingXeroCreditNotes({
    limit: 50,
  });

  if (refundsMissingCreditNotes.count > 0) {
    // F4 (#1354) self-heal: re-enqueue the uncovered delta for each flagged
    // payment. #2902 (INV-PAY-050): the amount asked for is the CASH
    // uncovered delta (provider-backed PaymentRefund evidence minus covered
    // notes), never the aggregate refundedAmountCents mirror — the mirror
    // also counts account-credit dispositions, and passing it minted
    // fictitious refund notes plus Stripe-bank payments for cancellations
    // that returned no cash. The enqueue re-caps against the same cash
    // evidence and is correlation-key-deduped, the execution path recomputes
    // coverage and cash evidence again at execution time, and the #1353 floor
    // keeps refundedAmountCents from being rewritten down — so a historically
    // swallowed delta converges to exactly one corrective note, and repeats
    // collapse into the existing PENDING operation. Alerting below is
    // unchanged: operators still see the divergence until the books actually
    // heal.
    //
    // #3924 round 7 (money M1, `INV-PAY-121`): what it asks for here is a CARD
    // note, settled from the Stripe account. Bank cash a "Paid another way"
    // close sent back is answered only by that close's own bank-transfer note,
    // keyed on its record; while that note has not landed (queued, running or
    // FAILED) its cash reads as uncovered, and is taken off the ask, never
    // filled with card money. The close's note is retried as its own row.
    let reEnqueued = 0;
    for (const missing of refundsMissingCreditNotes.payments) {
      try {
        const cardAskCents =
          missing.uncoveredCents -
          (await readPaidAnotherWayNotesNotLandedCents(prisma, missing.paymentId));
        if (cardAskCents <= 0) continue;
        const queued = await enqueueXeroRefundCreditNoteOperation(
          missing.paymentId,
          cardAskCents
        );
        if (queued.queueOperationId) {
          reEnqueued += 1;
        }
      } catch (err) {
        logger.error(
          { err, paymentId: missing.paymentId },
          "Failed to re-enqueue missing Xero refund credit note delta"
        );
      }
    }
    if (reEnqueued > 0 && (await isXeroConnected())) {
      void kickQueuedXeroOutboxOperationsIfConnected({ limit: reEnqueued }).catch(
        (err) =>
          logger.error(
            { err },
            "Failed to kick Xero outbox worker after credit-note self-heal re-enqueue"
          )
      );
    }
    // Cron context: the scoped bridge logs at error AND pages Sentry (deduped).
    reportCronError({
      tag: "credit-reconciliation:refunds-missing-credit-notes",
      message: `${refundsMissingCreditNotes.count} refunded Stripe payment(s) are missing Xero refund credit notes`,
      context: {
        alert: "REFUNDS_MISSING_XERO_CREDIT_NOTES",
        count: refundsMissingCreditNotes.count,
        graceHours: REFUND_CREDIT_NOTE_GRACE_HOURS,
        samplePayments: refundsMissingCreditNotes.payments.map((payment) => ({
          paymentId: payment.paymentId,
          bookingId: payment.bookingId,
          refundedAmountCents: payment.refundedAmountCents,
          cashRefundedCents: payment.cashRefundedCents,
          uncoveredCents: payment.uncoveredCents,
          refundedAt: payment.refundedAt,
        })),
        href: "/admin/xero",
      },
    });
  }

  if (negativeBalances.length > 0) {
    logger.error(
      {
        count: negativeBalances.length,
        memberIds: negativeBalances.map((b) => b.memberId),
      },
      "Members with negative credit balance detected"
    );

    // Cron context: the scoped bridge logs at error AND pages Sentry (deduped).
    reportCronError({
      tag: "credit-reconciliation:negative-credit-balances",
      message: `${negativeBalances.length} member(s) have negative credit balances — investigate immediately`,
      context: {
        alert: "CREDIT_BALANCE_DISCREPANCY",
        count: negativeBalances.length,
        memberIds: negativeBalances.map((b) => b.memberId),
      },
    });
  }

  // #1547 detection (alert-only, NO auto-heal): a CANCELLED booking holding a
  // never-restored BOOKING_APPLIED credit is money silently lost. Pre-fix
  // orphans are healed by scripts/backfill-orphaned-applied-credits.ts; AFTER
  // the fix any hit means a NEW credit-restore regression, so paying it out
  // here would mask the bug (owner decision). Alert and stop.
  const orphaned = await findOrphanedAppliedCredits();
  if (orphaned.findings.length > 0) {
    const count = orphaned.findings.length;
    const bookingIds = orphaned.findings.map((f) => f.bookingId);
    logger.error(
      { count, bookingIds },
      "Cancelled bookings with orphaned applied credit detected"
    );
    reportCronError({
      tag: "credit-reconciliation:orphaned-applied-credits",
      message: `${count} cancelled booking(s) hold applied account credit that was never restored — a NEW credit-restore regression (#1547); diagnose before healing with scripts/backfill-orphaned-applied-credits.ts`,
      context: {
        alert: "ORPHANED_APPLIED_CREDITS",
        count,
        sample: orphaned.findings.slice(0, 10).map((f) => ({
          bookingId: f.bookingId,
          memberId: f.memberId,
          appliedCreditCents: f.appliedCreditCents,
        })),
      },
    });
  }

  // If Xero is connected, log basic stats for manual reconciliation
  try {
    if (await isXeroConnected()) {
      // Count credits that reference Xero credit notes
      const creditsWithXero = await prisma.memberCredit.count({
        where: {
          xeroCreditNoteId: { not: null },
          type: { in: [...BOOKING_ISSUED_CREDIT_TYPES] },
        },
      });

      logger.info(
        {
          membersWithCredit,
          totalCreditCents,
          creditsWithXeroCreditNotes: creditsWithXero,
        },
        "Credit reconciliation: Xero credit note count logged for manual review"
      );
    }
  } catch (err) {
    logger.error({ err }, "Failed to check Xero connection during reconciliation");
  }

  logger.info(
    {
      membersWithCredit,
      totalCreditCents,
      discrepancies,
      refundsMissingXeroCreditNotes: refundsMissingCreditNotes.count,
      orphanedAppliedCredits: orphaned.findings.length,
    },
    "Credit reconciliation complete"
  );

  return {
    membersWithCredit,
    totalCreditCents,
    discrepancies,
    refundsMissingXeroCreditNotes: refundsMissingCreditNotes.count,
    orphanedAppliedCredits: orphaned.findings.length,
  };
}
