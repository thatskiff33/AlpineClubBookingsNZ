/** Stripe evidence before a charge-backed recovery sends again (INV-PAY-145). */
import { Prisma, type PaymentRecoveryOperation, type PaymentTransaction } from "@prisma/client";
import type Stripe from "stripe";
import { netCollectedCardRefundSelect } from "@/lib/additional-ledger-gap";
import { foreignRefundsSizingSupersededRow, isSizedOnLedger } from "@/lib/card-refund-dead-row";
import { listRefundsOnCardCharge } from "@/lib/card-refund-stripe-refunds";
import { recordStripeRefundsAgainstTransaction, type RefundAllocationSlice } from "@/lib/payment-transactions";
import { isRecordedRefundStatus } from "@/lib/payment-transaction-status";
import logger from "@/lib/logger";
import { notifyXeroSyncError } from "@/lib/xero-error-alert";
import { queueRecordedCardRefundNotes } from "@/lib/recorded-card-refund-notes";
import { cardRefundDoorOf } from "@/lib/card-refund-own-note-share";
import { prisma } from "@/lib/prisma";
import { onPlanWhere } from "@/lib/refused-card-refund-retry";
import { parseRefundAllocationPlan } from "@/lib/open-card-refund-owed";
import { refundSliceStripeIdempotencyKey } from "@/lib/payment-recovery-keys";
import { REFUND_SLICE_KEY_METADATA } from "@/lib/refund-slice-evidence";

/**
 * A hold: the row goes to the guarded terminal failure, audited and alerted
 * (`failPaymentRecoveryOperation`), and nothing is sent. Every hold is this
 * class, so each takes the same path; its message is what officers read.
 */
export class UnattributedCardRefundBeforeResendError extends Error {
  constructor(
    readonly stripeRefundIds: string[],
    message = "A refund made outside the app may already have paid this debt (INV-PAY-145). The app sent nothing and stopped automatic retries. Check the Stripe refunds and the booking before paying anything else. If money is still owed, use Paid another way in Stuck States; do not make a new Stripe dashboard refund. If that refund leaves nothing owed, close it with Nothing left owed in Stuck States.",
  ) {
    super(message);
  }
}

/** #4858: the hold for another refund on a plan-less superseded row's charge (`holdSupersededRowSizedOnAnotherRefund`). */
export class AnotherRefundSizesSupersededRowError extends UnattributedCardRefundBeforeResendError {
  constructor(stripeRefundIds: string[]) {
    super(
      stripeRefundIds,
      "Another refund on this card charge, which this refund did not make, counts toward what this refund owes (INV-PAY-145, #4858). If that refund failed later, the member could be paid twice, so the app sent nothing and stopped automatic retries. Check the Stripe refunds and the booking before paying anything else. If the refund named here has since failed (it then shows as a refund of its own that Stripe failed later), do not close this one with Paid another way: ask a developer (#4492). Otherwise, if money is still owed, use Paid another way in Stuck States; do not make a new Stripe dashboard refund.",
    );
  }
}

/**
 * The slice's captured charge, read straight from its ledger row. The row
 * stores no Stripe charge id: an intent has at most one succeeded charge, and
 * only a succeeded charge can be refunded, so the intent names the charge.
 */
type Charge = Pick<PaymentTransaction, "id" | "stripePaymentIntentId">;

type PreflightInput = {
  operation: Pick<PaymentRecoveryOperation, "id" | "paymentId" | "bookingId" | "createdAt" | "allocationPlan" | "processingStartedAt">;
  plan: readonly RefundAllocationSlice[];
  transactions: readonly Charge[];
  stripeKeyPrefix: string;
};

/**
 * No caller transaction: the provider read finishes before the canonical writer
 * opens its own Payment-row-locked transaction. All slices are checked before
 * any is sent, including on a row's first runner attempt after an inline call.
 */
export async function checkCardRefundResend(input: PreflightInput): Promise<RefundAllocationSlice[]> {
  return (await preflightCardRefundResend(input)).plan;
}

/** `checkCardRefundResend`, with what Stripe listed on each charge it read, by transaction id (#4858). */
export async function preflightCardRefundResend({
  operation,
  plan,
  transactions,
  stripeKeyPrefix,
}: PreflightInput): Promise<{ plan: RefundAllocationSlice[]; listedByTransaction: ReadonlyMap<string, readonly Stripe.Refund[]> }> {
  const listedByTransaction = new Map<string, readonly Stripe.Refund[]>();
  let updatedPlan = [...plan];
  // What the row holds now: the stored plan as read, then each plan written here.
  let storedPlan: Parameters<typeof onPlanWhere>[0] = operation.allocationPlan;
  const unmadeIds = new Set(plan.filter((slice) => !slice.madeRefundId).map((slice) => slice.paymentTransactionId));
  const charges = transactions.filter((row) => unmadeIds.has(row.id));
  if (charges.length !== unmadeIds.size) throw new Error("Refund preflight could not find every planned charge (INV-PAY-145)");
  for (const charge of charges) {
    if (!charge.stripePaymentIntentId) throw new Error("Refund preflight charge has no Stripe intent (INV-PAY-145)");
    // One bounded page, the refunds on this charge only (`listRefundsOnCardCharge`, #4368 review F3).
    const onCharge = await listRefundsOnCardCharge(charge.stripePaymentIntentId);
    listedByTransaction.set(charge.id, onCharge);
    if (onCharge.length === 0) continue;
    // The writer deduplicates unseen refunds and refreshes known statuses. Its
    // refusal result prevents a stale Stripe listing reviving a known failure.
    const recorded = await recordStripeRefundsAgainstTransaction({
      paymentId: operation.paymentId,
      paymentTransactionId: charge.id,
      refunds: onCharge,
      fallbackPaymentIntentId: charge.stripePaymentIntentId,
    });
    if (!recorded.payment) throw new Error("Refund preflight could not reconcile the payment (INV-PAY-145)");
    const matched = new Set<string>();
    const marked = updatedPlan.map((slice) => {
      if (slice.madeRefundId) return slice;
      const key = refundSliceStripeIdempotencyKey(stripeKeyPrefix, slice);
      const refund = onCharge.find((each) =>
        isRecordedRefundStatus(each.status ?? "unknown") &&
        !recorded.readAsRefused.includes(each.id) &&
        each.metadata?.[REFUND_SLICE_KEY_METADATA] === key,
      );
      if (!refund) return slice;
      matched.add(refund.id);
      return { ...slice, madeRefundId: refund.id };
    });
    let markError: Error | undefined;
    try {
      if (matched.size > 0 && parseRefundAllocationPlan(operation.allocationPlan)) {
        // Same plan guard as card-refund-resend-answer, on the stored plan as
        // read (a later charge's, on the plan written for the one before), and
        // this runner's claim. Provider reads and the Payment-row-locked ledger
        // write finished; one compare-and-set, and a lost one sends nothing.
        const written = await prisma.paymentRecoveryOperation.updateMany({
          where: {
            id: operation.id,
            status: "PROCESSING",
            processingStartedAt: operation.processingStartedAt,
            ...onPlanWhere(storedPlan),
          },
          data: { allocationPlan: marked as unknown as Prisma.InputJsonValue },
        });
        if (written.count !== 1) throw new Error("Refund preflight plan or claim changed (INV-PAY-147)");
        updatedPlan = marked;
        storedPlan = marked;
      } else {
        // A legacy row without a stored plan has no slice evidence to adopt.
        matched.clear();
      }
    } catch (error) {
      // The ledger committed already: its accounting correction and any
      // outside-app hold still run, but this attempt must send nothing.
      markError = error instanceof Error ? error : new Error(String(error));
    }
    await queueRecordedCardRefundNotes({
      payment: recorded.payment,
      paymentIntentId: charge.stripePaymentIntentId,
      deltaCents: Math.max(recorded.appliedCents, 0),
      refunds: onCharge,
      newlyCountedRefundIds: recorded.newlyCountedRefundIds,
    }).catch((error: unknown) => {
      // Recording committed already. As in charge.refunded, note failure must
      // not hide the dashboard hold or cause another money movement.
      logger.error({ err: error, paymentId: operation.paymentId }, "Failed to queue preflight refund credit note");
      void notifyXeroSyncError({
        errorType: "CREDIT_NOTE_CREATION",
        operation: `Queue refund credit note for payment ${operation.paymentId}`,
        errorMessage: error instanceof Error ? error.message : String(error),
      }).catch(() => {});
    });
    const unexpected: string[] = [];
    for (const refund of onCharge) {
      if (isRecordedRefundStatus(refund.status ?? "unknown") &&
        !recorded.readAsRefused.includes(refund.id) &&
        !matched.has(refund.id) &&
        cardRefundDoorOf(refund.metadata) === "outside-app" &&
        refund.created >= Math.floor(operation.createdAt.getTime() / 1000)) {
        unexpected.push(refund.id);
      }
    }
    // Conclusive evidence must hold the row even if another charge's read
    // would fail. No further provider reads are needed to refuse every slice.
    if (unexpected.length > 0) throw new UnattributedCardRefundBeforeResendError(unexpected);
    if (markError) throw markError;
  }
  return { plan: updatedPlan, listedByTransaction };
}

/**
 * #4858 (`INV-PAY-145`): a superseded intent's refund with no stored plan is
 * sized on its charge's ledger, so a refund another door made on that charge
 * since the row was raised is counted as its progress. Should that refund fail
 * later, the failed-later writer owes it on a row of its own while this row,
 * still open, re-sizes with its headroom back: paid twice. So, before sending,
 * the runner holds the row - the outside-app hold above, under its own message -
 * while the owed figure's attribution gives it any refund its own request did
 * not make, by Stripe's listing of the charge (`foreignRefundsSizingSupersededRow`,
 * the rule "Try the card again" refuses a re-arm by). A no-op for a row with a
 * stored plan, and for one whose attributed refunds are all its own.
 *
 * The caller reads the payment AFTER its sizing read of the charge, so every
 * refund the size counted is checked; one recorded in between is checked
 * without being counted, and holds the row conservatively. A plain read
 * outside every transaction, after the preflight's provider read: no lock.
 */
export async function holdSupersededRowSizedOnAnotherRefund({
  operation,
  listed,
}: {
  operation: Pick<PaymentRecoveryOperation, "id" | "type" | "paymentId" | "bookingId" | "idempotencyKey" | "stripeKeyPrefix" | "allocationPlan">;
  /** What the preflight listed on the row's charge. */
  listed: readonly Stripe.Refund[];
}): Promise<void> {
  if (!isSizedOnLedger(operation)) return;
  const payment = await prisma.payment.findUnique({ where: { id: operation.paymentId }, select: netCollectedCardRefundSelect });
  if (!payment) throw new Error("Refund preflight could not read the payment (INV-PAY-145)");
  const foreign = foreignRefundsSizingSupersededRow(payment, operation, listed);
  if (foreign.length > 0) throw new AnotherRefundSizesSupersededRowError(foreign);
}
